import type { SessionConfig, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCopilotAuth } from "./auth-bridge.js";
import {
  attachEventBridge,
  type AssistantMessage,
  type AssistantUsageSnapshot,
  type OnAssistantDeltaPayload,
  type SessionLike,
} from "./event-bridge.js";
import { createHooksBridge, type CopilotSdkHooksConfig } from "./hooks-bridge.js";
import {
  createPermissionBridge,
  rejectAllPolicy,
  type CopilotSdkPermissionPolicy,
} from "./permission-bridge.js";
import type { ClientCreateOptions, CopilotClientPool, PoolKey, PooledClient } from "./runtime.js";
import { createCopilotSdkToolBridge } from "./tool-bridge.js";
import {
  createUserInputBridge,
  denyAllUserInputPolicy,
  type CopilotSdkUserInputPolicy,
} from "./user-input-bridge.js";

const SUPPORTED_PROVIDERS = new Set(["github", "openclaw", "copilot"]);

type AttemptResultWithSdkSessionId = AgentHarnessAttemptResult & { sdkSessionId?: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };
// TODO(plugin-sdk-widening): Remove AttemptParamsLike when
// openclaw/plugin-sdk/agent-harness-runtime declares auth, messages,
// onAssistantDelta, and initialReplayState.sdkSessionId fields. Tracked by
// project openclaw-copilot-sdk-harness; reviewer-attempt-bridge note.

type AttemptParamsLike = AgentHarnessAttemptParams & {
  auth?: {
    gitHubToken?: string;
    profileId?: string;
    profileVersion?: string;
    useLoggedInUser?: boolean;
  };
  copilotHome?: string;
  cwd?: string;
  hooksConfig?: CopilotSdkHooksConfig;
  initialReplayState?: AgentHarnessAttemptParams["initialReplayState"] & { sdkSessionId?: string };
  messages?: AgentMessage[];
  model?: string | { api?: string; id?: string; provider?: string };
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  permissionPolicy?: CopilotSdkPermissionPolicy;
  profileVersion?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  userInputPolicy?: CopilotSdkUserInputPolicy;
};
type ModelRef = { api?: string; id: string; provider: string };

export interface CopilotSdkAttemptDeps {
  pool: CopilotClientPool;
  now?: () => number;
  createToolBridge?: typeof createCopilotSdkToolBridge;
  /**
   * Called once with the SDK session id and pooled client immediately
   * after the SDK session is created (or resumed) successfully. The
   * harness uses this to track the openclawSessionId -> sdkSessionId
   * mapping needed for `reset(params)` (see harness.ts). Exceptions
   * thrown from this callback are swallowed so they cannot break the
   * attempt.
   */
  onSessionEstablished?: (info: { sdkSessionId: string; pooledClient: PooledClient }) => void;
}

export async function runCopilotSdkAttempt(
  params: AgentHarnessAttemptParams,
  deps: CopilotSdkAttemptDeps,
): Promise<AgentHarnessAttemptResult> {
  const now = deps.now ?? Date.now;
  const input = params as AttemptParamsLike;
  const createToolBridge = deps.createToolBridge ?? createCopilotSdkToolBridge;
  const messages = getMessagesSnapshotInput(input);

  if (params.abortSignal?.aborted) {
    return createResult(input, {
      aborted: true,
      externalAbort: true,
      messagesSnapshot: messages,
      now,
      promptError: undefined,
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  const modelRef = resolveModelRef(input);
  if (!SUPPORTED_PROVIDERS.has(modelRef.provider)) {
    return createResult(input, {
      messagesSnapshot: messages,
      now,
      promptError: createPromptError(
        "model_not_supported",
        `[copilot-sdk-attempt] provider ${modelRef.provider} is not supported at MVP (subscription Copilot models only; BYOK arrives via byok-mapping-skeleton)`,
      ),
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  let abortRequested = false;
  let aborted = false;
  let externalAbort = false;
  let settled = false;
  let sentTurnStarted = false;
  let timedOut = false;
  let promptError: Error | undefined;
  let sdkSessionId: string | undefined;
  let sessionIdUsed = input.sessionId;
  let disconnectError: Error | undefined;
  let handle: PooledClient | undefined;
  let session: SessionLike | undefined;
  let bridge: ReturnType<typeof attachEventBridge> | undefined;
  let releaseError: Error | undefined;

  const onAbort = () => {
    abortRequested = true;
    externalAbort = true;
    aborted = true;
    if (settled || !sentTurnStarted || !session) {
      return;
    }
    void session.abort().catch(() => undefined);
  };

  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const poolAcquire = resolvePoolAcquire(input);

  try {
    let sdkTools: SdkTool[];
    try {
      const toolBridge = await createToolBridge({
        modelProvider: modelRef.provider,
        modelId: modelRef.id,
        agentId: readString(params.agentId) ?? "copilot-sdk",
        sessionId: readString(input.sessionId) ?? "copilot-sdk-session",
        sessionKey: readString((input as { sessionKey?: unknown }).sessionKey),
        agentDir: readString(input.agentDir),
        workspaceDir: readString(input.workspaceDir) ?? readString(input.cwd),
        abortSignal: params.abortSignal,
      });
      sdkTools = toolBridge.sdkTools;
    } catch (error: unknown) {
      return createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError(
          "tool_bridge_failure",
          `[copilot-sdk-attempt] tool-bridge construction failed: ${toError(error).message}`,
          error,
        ),
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      });
    }

    handle = await deps.pool.acquire(poolAcquire.key, poolAcquire.options);
    const client = handle.client;
    const sessionConfig = createSessionConfig(input, modelRef.id, sdkTools);
    const resumeSessionId = readString(input.initialReplayState?.sdkSessionId);

    session = (resumeSessionId
      ? await client.resumeSession(resumeSessionId, {
          ...sessionConfig,
          // SAFETY: replay-shim owns pending-work replay. This bridge always resumes
          // with continuePendingWork: false so suspended tool/permission work cannot
          // be replayed implicitly before the dedicated replay bridge lands.
          continuePendingWork: false,
        })
      : await client.createSession(sessionConfig)) as unknown as SessionLike;

    sdkSessionId = readSessionId(session) ?? resumeSessionId;
    sessionIdUsed = sdkSessionId ?? input.sessionId;
    if (sdkSessionId && deps.onSessionEstablished) {
      try {
        deps.onSessionEstablished({ sdkSessionId, pooledClient: handle });
      } catch {
        // never let session-tracking callbacks break attempts
      }
    }
    bridge = attachEventBridge(session, {
      onAssistantDelta: input.onAssistantDelta,
      getSdkSessionId: () => sdkSessionId,
      isAborted: () => aborted,
    });

    if (abortRequested || params.abortSignal?.aborted) {
      aborted = true;
      externalAbort = true;
    } else {
      sentTurnStarted = true;
      const result = await session.sendAndWait({ prompt: input.prompt }, input.timeoutMs);
      await bridge.awaitDeltaChain();
      if (!bridge.recordSendResult(result) && !aborted) {
        // SDK sendAndWait returning undefined is treated as a timeout by the
        // capability inventory. Do not call session.abort() here: OpenClaw may
        // resume the in-flight SDK session on the next attempt.
        timedOut = true;
      }
      const snap = bridge.snapshot();
      if (!promptError && !timedOut && !aborted && snap.streamError) {
        promptError = snap.streamError;
      }
    }
  } catch (error: unknown) {
    if (!aborted) {
      promptError = toError(error);
    }
  } finally {
    settled = true;
    bridge?.detach();
    params.abortSignal?.removeEventListener("abort", onAbort);

    if (session) {
      try {
        await session.disconnect();
      } catch (error: unknown) {
        disconnectError = toError(error);
        if (!promptError) {
          promptError = disconnectError;
        }
      }
    }

    if (handle) {
      try {
        await deps.pool.release(handle);
      } catch (error: unknown) {
        const releaseFailure = toError(error);
        if (promptError) {
          console.warn(
            "[copilot-sdk-attempt] pool.release failed after primary error",
            releaseFailure,
          );
        } else {
          releaseError = releaseFailure;
        }
      }
    }
  }

  if (releaseError) {
    throw releaseError;
  }

  const snap = bridge?.snapshot();
  const assistantTexts = bridge?.finalizeAssistantTexts() ?? [];
  const lastAssistant = bridge?.buildAssistantMessage({ modelRef, now });
  const messagesSnapshot = lastAssistant ? [...messages, lastAssistant] : [...messages];

  return createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    externalAbort,
    itemLifecycle: {
      activeCount: Math.max((snap?.startedCount ?? 0) - (snap?.completedCount ?? 0), 0),
      completedCount: snap?.completedCount ?? 0,
      startedCount: snap?.startedCount ?? 0,
    },
    lastAssistant,
    messagesSnapshot,
    now,
    promptError,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    toolMetas: snap ? [...snap.toolMetas] : [],
    usage: snap?.usage,
  });
}

function createResult(
  params: AttemptParamsLike,
  state: {
    aborted?: boolean;
    assistantTexts?: string[];
    currentAttemptAssistant?: AssistantMessage;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    messagesSnapshot: AgentMessage[];
    now: () => number;
    promptError: Error | undefined;
    sdkSessionId?: string;
    sessionIdUsed?: string;
    timedOut?: boolean;
    toolMetas?: Array<{ meta?: string; toolName: string }>;
    usage?: AssistantUsageSnapshot;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const timedOut = state.timedOut === true;
  const replayHadPotentialSideEffects = timedOut;
  return {
    aborted: state.aborted === true,
    ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
    assistantTexts: state.assistantTexts ?? [],
    attemptUsage: state.usage,
    cloudCodeAssistFormatError: false,
    currentAttemptAssistant: state.currentAttemptAssistant,
    didSendViaMessagingTool: false,
    externalAbort: state.externalAbort === true,
    idleTimedOut: false,
    itemLifecycle: state.itemLifecycle ?? {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: state.lastAssistant,
    messagesSnapshot: state.messagesSnapshot,
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError,
    promptErrorSource: promptError ? "prompt" : null,
    replayMetadata: {
      hadPotentialSideEffects: replayHadPotentialSideEffects,
      replaySafe: !replayHadPotentialSideEffects,
    },
    sessionFileUsed: readString(params.sessionFile),
    sessionIdUsed: state.sessionIdUsed ?? readString(params.sessionId) ?? "copilot-sdk-session",
    timedOut,
    timedOutDuringCompaction: false,
    toolMetas: state.toolMetas ?? [],
  };
}

function createPromptError(code: string, message: string, cause?: unknown): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function createSessionConfig(
  params: AttemptParamsLike,
  sdkModelId: string,
  sdkTools: SdkTool[],
): Pick<
  SessionConfig,
  | "hooks"
  | "model"
  | "onPermissionRequest"
  | "onUserInputRequest"
  | "reasoningEffort"
  | "tools"
  | "workingDirectory"
> {
  const permissionPolicy = params.permissionPolicy ?? rejectAllPolicy;
  const userInputPolicy = params.userInputPolicy ?? denyAllUserInputPolicy;
  const hooks = createHooksBridge(params.hooksConfig);
  return {
    model: sdkModelId,
    // Permission decisions flow through permission-bridge. The default
    // (rejectAllPolicy) keeps the harness fail-closed; the core wiring
    // layer can inject `delegatingPolicy({ onRequest })` that calls into
    // the host's PI-style tool-policy decisions. See permission-bridge.ts
    // for the back-pointer to src/agents/pi-tools.before-tool-call.ts.
    onPermissionRequest: createPermissionBridge(permissionPolicy),
    // User-input requests flow through user-input-bridge. The default
    // (denyAllUserInputPolicy) returns a synthetic answer so the model
    // sees a real string rather than a generic RPC failure; the core
    // wiring layer can inject `delegatingUserInputPolicy({ onRequest })`
    // that calls into the host's channel/TUI prompt path (commitments/).
    onUserInputRequest: createUserInputBridge(userInputPolicy),
    // SessionHooks: only set when the host actually supplied handlers.
    // createHooksBridge returns undefined for an empty config so we
    // never install an empty hooks subsystem. See hooks-bridge.ts for
    // the back-pointer to src/agents/harness/lifecycle-hook-helpers.ts.
    ...(hooks ? { hooks } : {}),
    reasoningEffort: params.reasoningEffort,
    tools: sdkTools,
    workingDirectory: readString(params.workspaceDir) ?? readString(params.cwd),
  };
}

function getMessagesSnapshotInput(params: AttemptParamsLike): AgentMessage[] {
  return Array.isArray(params.messages) ? [...params.messages] : [];
}

function readSessionId(session: SessionLike | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  return readString(session.sessionId) ?? readString(session.id);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveModelRef(params: AttemptParamsLike): ModelRef {
  const rawModel = params.model;
  if (rawModel && typeof rawModel === "object") {
    return {
      api: readString(rawModel.api),
      id:
        readString(rawModel.id) ??
        readString((params as { modelId?: unknown }).modelId) ??
        "unknown-model",
      provider:
        readString(rawModel.provider) ??
        readString((params as { provider?: unknown }).provider) ??
        "unknown-provider",
    };
  }
  return {
    id:
      readString(typeof rawModel === "string" ? rawModel : undefined) ??
      readString((params as { modelId?: unknown }).modelId) ??
      "unknown-model",
    provider: readString((params as { provider?: unknown }).provider) ?? "unknown-provider",
  };
}

function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
} {
  const resolved = resolveCopilotAuth({
    agentId: readString(params.agentId),
    agentDir: readString(params.agentDir),
    workspaceDir: readString(params.workspaceDir),
    copilotHome: readString(params.copilotHome),
    auth: params.auth,
    authProfileId: readString(params.authProfileId),
    profileVersion: readString(params.profileVersion),
  });

  return {
    key: {
      agentId: resolved.agentId,
      authMode: resolved.authMode,
      ...(resolved.authMode === "gitHubToken"
        ? {
            authProfileId: resolved.authProfileId,
            authProfileVersion: resolved.authProfileVersion,
          }
        : {}),
      copilotHome: resolved.copilotHome,
    },
    options: {
      copilotHome: resolved.copilotHome,
      cwd: readString(params.cwd) ?? readString(params.workspaceDir),
      gitHubToken: resolved.authMode === "gitHubToken" ? resolved.gitHubToken : undefined,
      useLoggedInUser: resolved.authMode === "useLoggedInUser",
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
