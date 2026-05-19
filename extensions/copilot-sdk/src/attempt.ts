import type { SessionConfig, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCopilotAuth } from "./auth-bridge.js";
import {
  createInfiniteSessionConfig,
  type CopilotSdkInfiniteSessionOptions,
} from "./compaction-bridge.js";
import {
  attachCopilotSdkMirrorIdentity,
  dualWriteCopilotSdkTranscriptBestEffort,
} from "./dual-write-transcripts.js";
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
import { classifyResumeFailure, computeReplayMetadata, decideReplayAction } from "./replay-shim.js";
import type { ClientCreateOptions, CopilotClientPool, PoolKey, PooledClient } from "./runtime.js";
import { createCopilotSdkToolBridge } from "./tool-bridge.js";

const SUPPORTED_PROVIDERS = new Set(["github-copilot"]);

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
  enableSessionTelemetry?: boolean;
  hooksConfig?: CopilotSdkHooksConfig;
  infiniteSessionConfig?: CopilotSdkInfiniteSessionOptions;
  initialReplayState?: AgentHarnessAttemptParams["initialReplayState"] & { sdkSessionId?: string };
  messages?: AgentMessage[];
  model?: string | { api?: string; id?: string; provider?: string };
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  permissionPolicy?: CopilotSdkPermissionPolicy;
  profileVersion?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  // User-visible prompt body (when distinct from `prompt`, which may
  // include runtime-expanded context). Used when synthesizing the
  // current-turn user message for the OpenClaw audit transcript so
  // dashboard/CLI history shows what the user actually typed, not the
  // internal expansion. Symmetric to `EmbeddedRunAttemptParams.transcriptPrompt`.
  transcriptPrompt?: string;
};
type ModelRef = { api?: string; id: string; provider: string };

export type { AttemptParamsLike as CopilotSdkPoolAcquireInput, ModelRef };
export { SUPPORTED_PROVIDERS };

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
  let downgradedFromResume = false;
  let resumeFailureRecovered = false;
  // True when a wrapped tool fired `sessions_yield`. Propagated into
  // the final attempt result so the parent runner can mark liveness
  // as paused and stop_reason as `end_turn`, matching the in-tree PI
  // (`src/agents/pi-embedded-runner/run/attempt.ts:1107-1113`) and
  // codex (`extensions/codex/src/app-server/run-attempt.ts:539,1739`)
  // behavior. See `EmbeddedRunAttemptResult.yieldDetected` at
  // `src/agents/pi-embedded-runner/run/types.ts:139`.
  let yieldDetected = false;

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

  // Mutable session holder shared with the tool bridge so onYield
  // (raised inside wrapped-tool execution) can route to the live SDK
  // session's abort once it exists. The bridge is constructed before
  // createSession/resumeSession resolves, so the holder is the only
  // safe way to defer the binding without creating a circular dep.
  // See tool-bridge.ts CopilotSdkSessionHolder.
  const sessionRef: { current: SessionLike | undefined } = { current: undefined };

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
        // Forward the full attempt params so the wrapped-tool
        // enforcement layer receives the same context PI does
        // (identity, owner-only allowlist, auth-profile store,
        // channel/routing, model context, run hooks). See
        // tool-bridge.ts buildOpenClawCodingToolsOptions().
        attemptParams: input,
        sessionRef,
        onYieldDetected: () => {
          yieldDetected = true;
        },
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
    const sessionConfig = createSessionConfig(input, modelRef.id, sdkTools, poolAcquire.auth);
    const replayDecision = decideReplayAction({
      sdkSessionId: input.initialReplayState?.sdkSessionId,
      replayInvalid: input.initialReplayState?.replayInvalid,
    });
    downgradedFromResume = replayDecision.downgradedFromResume;
    const resumeSessionId =
      replayDecision.action === "resume" ? replayDecision.sdkSessionId : undefined;

    // SAFETY: replay-shim owns the create/resume decision and the
    // recovery policy when resumeSession fails. See replay-shim.ts.
    // continuePendingWork is always false here so suspended tool/
    // permission work cannot be replayed implicitly — replay-shim's
    // worst-case-wins replayMetadata is the only signal the
    // orchestrator uses to decide whether the next attempt is safe.
    if (resumeSessionId) {
      try {
        session = (await client.resumeSession(resumeSessionId, {
          ...sessionConfig,
          continuePendingWork: false,
        })) as unknown as SessionLike;
      } catch (error: unknown) {
        const classification = classifyResumeFailure(error);
        if (!classification.recoverable) {
          throw error;
        }
        // Downgrade silently: the prior SDK session is gone, so start a
        // fresh one. replayMetadata will reflect replaySafe:false via
        // resumeFailureRecovered so the orchestrator does not blindly
        // retry the same prompt with stale assumptions.
        resumeFailureRecovered = true;
        session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
      }
    } else {
      session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
    }
    // Bind the session holder so the tool bridge's onYield callback
    // can abort the live SDK session if a wrapped tool yields.
    sessionRef.current = session;

    // After a recovered resume, the prior sdkSessionId no longer exists
    // server-side, so don't fall back to it: only the freshly-created
    // session's id is valid.
    sdkSessionId = readSessionId(session) ?? (resumeFailureRecovered ? undefined : resumeSessionId);
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

  // Dogfood finding #3 (mirror codex parity):
  //
  // Without this synthesis the OpenClaw audit transcript never sees
  // the user's prompt for a copilot-sdk attempt. The shell's
  // `persistTextTurnTranscript` skips the user write when
  // `embeddedAssistantGapFill` is true (its `body` arrives as ""),
  // trusting the harness to mirror it. Codex does exactly this in
  // `event-projector.ts:262` by prepending
  // `{role:"user", content:params.prompt, ...}` tagged `${turnId}:prompt`.
  // We mirror that pattern with `${runId}:prompt` as the turn-stable
  // identity so re-mirror of the same turn is a true no-op AND two
  // turns sharing the same SDK session produce distinct dedupe keys
  // (the latter matters once session reuse lands in harness.ts).
  //
  // Defensive guard: if the caller already passed the same user turn
  // as the tail of `messages`, skip synthesis to avoid double-writing
  // the user message.
  const syntheticUserText = readString(input.transcriptPrompt) ?? readString(input.prompt);
  const tailUserText = readTailUserText(messages);
  const syntheticUser: AgentMessage | undefined =
    syntheticUserText && syntheticUserText !== tailUserText
      ? attachCopilotSdkMirrorIdentity(
          { role: "user", content: syntheticUserText, timestamp: now() } as AgentMessage,
          `${input.runId}:prompt`,
        )
      : undefined;
  const taggedLastAssistant = lastAssistant
    ? attachCopilotSdkMirrorIdentity(lastAssistant, `${input.runId}:assistant:final`)
    : undefined;
  const messagesSnapshot: AgentMessage[] = [
    ...messages,
    ...(syntheticUser ? [syntheticUser] : []),
    ...(taggedLastAssistant ? [taggedLastAssistant] : []),
  ];

  // Best-effort dual-write: mirror this attempt's full message snapshot
  // (user/assistant/toolResult) into the OpenClaw audit transcript at
  // params.sessionFile, alongside the SDK's own session storage. The
  // OpenClaw shell (attempt-execution.ts) writes only the user prompt
  // and terminal assistant text; mirroring here captures intermediate
  // tool calls/results for full audit/replay parity with the codex
  // extension. Identity-tagged so re-emits dedupe. Errors are
  // swallowed so a mirror failure cannot break the attempt.
  const sessionFileForMirror = readString(input.sessionFile);
  const sessionIdForScope = sessionIdUsed ?? readString(input.sessionId);
  if (sessionFileForMirror && messagesSnapshot.length > 0) {
    const taggedMessages = messagesSnapshot.map((message, index) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      ) {
        return message;
      }
      // Preserve any caller-attached (or upstream-attached) mirror
      // identity — especially the `${runId}:prompt` /
      // `${runId}:assistant:final` identities attached above — so the
      // dedupe key stays turn-stable. Falling back to a per-attempt
      // positional identity here is only safe for messages that don't
      // already carry a logical identity; with SDK session reuse the
      // positional scheme would collapse turn 2's index-0 user onto
      // turn 1's index-0 user inside the same `${sdkSessionId}`
      // scope. See replay-shim.ts + harness.ts session-reuse path.
      if (hasMirrorIdentity(message)) {
        return message;
      }
      const identityScope = sdkSessionId ?? sessionIdForScope ?? "attempt";
      return attachCopilotSdkMirrorIdentity(message, `${identityScope}:${message.role}:${index}`);
    });
    await dualWriteCopilotSdkTranscriptBestEffort({
      sessionFile: sessionFileForMirror,
      sessionKey: readString((input as { sessionKey?: unknown }).sessionKey),
      agentId: readString(input.agentId),
      messages: taggedMessages,
      idempotencyScope: sessionIdForScope ? `copilot-sdk:${sessionIdForScope}` : undefined,
      config: (input as { config?: unknown }).config as never,
    }).catch((mirrorError: unknown) => {
      // Defense-in-depth: the best-effort wrapper already swallows
      // mirror failures, but we double-guard here so any future
      // signature change or unexpected rejection cannot break the
      // attempt result. The SDK's own session storage remains
      // authoritative; only the OpenClaw audit transcript would be
      // missing intermediate messages for this turn.
      console.warn(
        "[copilot-sdk-attempt] dual-write transcript wrapper rejected unexpectedly",
        mirrorError,
      );
    });
  }

  return createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    downgradedFromResume,
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
    resumeFailureRecovered,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    toolMetas: snap ? [...snap.toolMetas] : [],
    usage: snap?.usage,
    yieldDetected,
  });
}

function createResult(
  params: AttemptParamsLike,
  state: {
    aborted?: boolean;
    assistantTexts?: string[];
    currentAttemptAssistant?: AssistantMessage;
    downgradedFromResume?: boolean;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    messagesSnapshot: AgentMessage[];
    now: () => number;
    promptError: Error | undefined;
    resumeFailureRecovered?: boolean;
    sdkSessionId?: string;
    sessionIdUsed?: string;
    timedOut?: boolean;
    toolMetas?: Array<{ meta?: string; toolName: string }>;
    usage?: AssistantUsageSnapshot;
    yieldDetected?: boolean;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const timedOut = state.timedOut === true;
  const replayMetadata = computeReplayMetadata({
    priorReplayInvalid: params.initialReplayState?.replayInvalid,
    priorHadPotentialSideEffects: params.initialReplayState?.hadPotentialSideEffects,
    thisAttemptTimedOut: timedOut,
    thisAttemptDowngradedFromResume: state.downgradedFromResume,
    thisAttemptResumeFailureRecovered: state.resumeFailureRecovered,
  });
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
    replayMetadata,
    sessionFileUsed: readString(params.sessionFile),
    sessionIdUsed: state.sessionIdUsed ?? readString(params.sessionId) ?? "copilot-sdk-session",
    timedOut,
    timedOutDuringCompaction: false,
    toolMetas: state.toolMetas ?? [],
    yieldDetected: state.yieldDetected === true,
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
  resolvedAuth: ReturnType<typeof resolveCopilotAuth>,
): Pick<
  SessionConfig,
  | "enableSessionTelemetry"
  | "gitHubToken"
  | "hooks"
  | "infiniteSessions"
  | "model"
  | "onPermissionRequest"
  | "reasoningEffort"
  | "tools"
  | "workingDirectory"
> {
  const permissionPolicy = params.permissionPolicy ?? rejectAllPolicy;
  const hooks = createHooksBridge(params.hooksConfig);
  const infiniteSessions = createInfiniteSessionConfig(params.infiniteSessionConfig);
  return {
    model: sdkModelId,
    // Permission decisions for SDK built-in tool kinds (shell, write,
    // read, url, mcp, memory, hook) fall through to permission-bridge.
    // The default (`rejectAllPolicy`) keeps the harness fail-closed,
    // but in practice the SDK should never invoke any of those because
    // every bridged tool is registered with `overridesBuiltInTool: true`
    // and `skipPermission: true` (see tool-bridge.ts), so 100% of tool
    // calls go through OpenClaw's wrapped `execute()` which runs
    // `runBeforeToolCallHook` (loop detection, trusted plugin policies,
    // before-tool-call hooks, two-phase plugin approval). This mirrors
    // the in-tree codex harness's split: bridged-tool enforcement
    // happens inside the tool wrapper, and the SDK gate is a safety
    // net for kinds we don't surface. See permission-bridge.ts and
    // docs/plugins/copilot-sdk-harness.md.
    onPermissionRequest: createPermissionBridge(permissionPolicy),
    // `onUserInputRequest` is intentionally NOT registered: per the SDK
    // contract, omitting the handler hides the `ask_user` tool from the
    // model entirely. This is the MVP posture — interactive ask_user
    // requires routing the request to the OpenClaw channel/TUI prompt
    // path (mirroring extensions/codex/src/app-server/user-input-bridge.ts),
    // which is tracked as a follow-up. With the handler absent, agents
    // running under this harness must make best-judgment decisions from
    // the initial prompt rather than asking clarifying questions
    // mid-turn. See user-input-bridge.ts for the dormant policy
    // scaffolding the follow-up will reuse.
    // SessionHooks: only set when the host actually supplied handlers.
    // createHooksBridge returns undefined for an empty config so we
    // never install an empty hooks subsystem. See hooks-bridge.ts for
    // the back-pointer to src/agents/harness/lifecycle-hook-helpers.ts.
    ...(hooks ? { hooks } : {}),
    // Session-level telemetry opt-out: only propagate when the host
    // explicitly set a boolean. undefined means "use SDK default"
    // (enabled for GitHub auth; disabled when a BYOK provider is set).
    // Client-level OTel config is plumbed via runtime.ts /
    // telemetry-bridge.ts.
    ...(typeof params.enableSessionTelemetry === "boolean"
      ? { enableSessionTelemetry: params.enableSessionTelemetry }
      : {}),
    // Infinite sessions / background compaction: only attach when the
    // host provided an InfiniteSessionConfig. SDK defaults
    // (`enabled: true`, background 0.80, buffer 0.95) apply when
    // omitted. See compaction-bridge.ts.
    ...(infiniteSessions ? { infiniteSessions } : {}),
    reasoningEffort: params.reasoningEffort,
    tools: sdkTools,
    workingDirectory: readString(params.workspaceDir) ?? readString(params.cwd),
    // Session-level GitHub token. INDEPENDENT of the client-level
    // token in `CopilotClientOptions.gitHubToken` (set in
    // `resolvePoolAcquire().options`). Per the SDK contract
    // (`@github/copilot-sdk/dist/types.d.ts:1168-1178`), the client-
    // level token authenticates the CLI process while the session-
    // level token determines the identity used for content exclusion,
    // model routing, and quota — and is sent on BOTH `createSession`
    // and `resumeSession` (`ResumeSessionConfig` picks `gitHubToken`
    // at types.d.ts:1198). Omitted when `useLoggedInUser` is the
    // resolved mode — passing both would be contradictory and the SDK
    // already implies content-exclusion/quota from the logged-in
    // identity in that mode.
    ...(resolvedAuth.authMode === "gitHubToken" && resolvedAuth.gitHubToken
      ? { gitHubToken: resolvedAuth.gitHubToken }
      : {}),
  };
}

function getMessagesSnapshotInput(params: AttemptParamsLike): AgentMessage[] {
  return Array.isArray(params.messages) ? [...params.messages] : [];
}

// Returns the trimmed plain-text content of the tail user message in
// `messages`, if any. Used to skip synthetic-user injection when the
// caller already passed the current turn's user prompt as the last
// entry of `params.messages`, which would otherwise produce a duplicate
// user record in the audit transcript.
function readTailUserText(messages: AgentMessage[]): string | undefined {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== "user") {
    return undefined;
  }
  const content = (tail as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          return text;
        }
      }
    }
  }
  return undefined;
}

// True when an AgentMessage already carries a stable mirror identity
// (e.g. the `${runId}:prompt` / `${runId}:assistant:final` identities
// attached in attempt.ts before the dual-write, or any caller-attached
// identity from a prior turn). Keep this in sync with the
// MIRROR_IDENTITY_META_KEY constant in dual-write-transcripts.ts; we
// duplicate the read here instead of importing the helper to avoid
// widening the module's public surface for what is otherwise a pure
// guard. See attempt.ts dual-write tagging block.
function hasMirrorIdentity(message: AgentMessage): boolean {
  const record = message as unknown as { __openclaw?: unknown };
  const meta = record.__openclaw;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  const id = (meta as Record<string, unknown>).mirrorIdentity;
  return typeof id === "string" && id.length > 0;
}

function readSessionId(session: SessionLike | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  return readString(session.sessionId) ?? readString(session.id);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolveModelRef(params: AttemptParamsLike): ModelRef {
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

export function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
  /**
   * The resolved auth result is returned so call sites that build a
   * `SessionConfig` immediately afterwards (attempt.ts +
   * side-question.ts) can populate `SessionConfig.gitHubToken`
   * without re-resolving auth. `SessionConfig.gitHubToken` is
   * INDEPENDENT of `CopilotClientOptions.gitHubToken` per the SDK
   * contract (`@github/copilot-sdk/dist/types.d.ts:1168-1178`): the
   * client-level token authenticates the CLI process, while the
   * session-level token determines the identity used for content
   * exclusion, model routing, and quota. Both `createSession` and
   * `resumeSession` (`ResumeSessionConfig` at types.d.ts:1198) honor
   * the session-level field, so per-session multitenancy requires
   * setting both.
   */
  auth: ReturnType<typeof resolveCopilotAuth>;
} {
  const resolved = resolveCopilotAuth({
    agentId: readString(params.agentId),
    agentDir: readString(params.agentDir),
    workspaceDir: readString(params.workspaceDir),
    copilotHome: readString(params.copilotHome),
    auth: params.auth,
    // Contract-resolved auth (EmbeddedRunAttemptParams): the production
    // main path for agents with a configured `github-copilot` auth
    // profile. Falling through to env / useLoggedInUser when absent
    // keeps the direct-CLI / dogfood paths working unchanged.
    resolvedApiKey: readString(params.resolvedApiKey),
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
    auth: resolved,
  };
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
