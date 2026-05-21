import type { SessionConfig, SessionEvent, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessSideQuestionParams,
  AgentHarnessSideQuestionResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isSdkSendAndWaitTimeoutError,
  readString,
  resolveModelRef,
  resolvePoolAcquire,
  SUPPORTED_PROVIDERS,
  toError,
  type CopilotPoolAcquireInput,
} from "./attempt.js";
import { createPermissionBridge, rejectAllPolicy } from "./permission-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";

// Side-question bridge for the GitHub Copilot agent runtime.
//
// `/btw` (and similar one-shot utility prompts dispatched through
// `harness.runSideQuestion`) sends a single self-contained question
// to the model and reads back a text answer. This path is
// intentionally lightweight: a transient SDK session with no tools,
// no hooks, no infinite-sessions, and no streaming callback.
//
// Lifecycle: createSession -> sendAndWait -> on timeout: abort
// first -> always disconnect + deleteSession + pool.release in a
// finally block. The session is throwaway: explicit deleteSession
// prevents server-side leaks when many side questions accumulate.
//
// Host back-pointer (NOT imported):
//   - src/agents/btw.ts — calls this method from the `/btw` command flow.
//   - src/agents/harness/types.ts — `AgentHarnessSideQuestionParams`
//     and `AgentHarnessSideQuestionResult` shapes.

const DEFAULT_SIDE_QUESTION_TIMEOUT_MS = 60_000;

type SideQuestionParamsLike = AgentHarnessSideQuestionParams & {
  auth?: CopilotPoolAcquireInput["auth"];
  copilotHome?: string;
  cwd?: string;
  profileVersion?: string;
  /**
   * Contract-resolved token from core's AuthProfileStore lookup
   * (`EmbeddedRunAttemptParams.resolvedApiKey`). When the host
   * dispatches `/btw` from an embedded run with a `copilot`
   * auth profile configured, this carries the same token the main
   * attempt is using so the throwaway side-question session shares
   * the identity (and therefore the content-exclusion / model
   * routing / quota that identity implies).
   */
  resolvedApiKey?: string;
};

interface MinimalSession {
  readonly id?: string;
  sendAndWait(input: { prompt: string }, timeoutMs?: number): Promise<SessionEvent | undefined>;
  abort(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  on?: (handler: (event: SessionEvent) => void | Promise<void>) => () => void;
}

interface SideQuestionDeps {
  pool: CopilotClientPool;
  timeoutMs?: number;
  /** Override for tests. */
  now?: () => number;
}

/**
 * Extract assistant text from a final `assistant.message` event,
 * falling back to accumulated streaming deltas when the final event
 * carries no inline content. Matches the precedence used by the
 * attempt event-bridge (see event-bridge.ts).
 */
export function extractAssistantText(
  finalEvent: SessionEvent | undefined,
  accumulatedDeltaText: string,
): string {
  if (finalEvent?.type === "assistant.message") {
    const content = (finalEvent as Extract<SessionEvent, { type: "assistant.message" }>).data
      .content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
  }
  return accumulatedDeltaText;
}

function buildSideQuestionPoolInput(params: SideQuestionParamsLike): CopilotPoolAcquireInput {
  // resolvePoolAcquire inspects auth/agentId/agentDir/workspaceDir
  // /copilotHome/cwd/authProfileId/profileVersion/resolvedApiKey.
  // Keeping the cast narrow documents that side-question shares the
  // attempt pool key so a `/btw` call can reuse the main attempt's
  // pooled CLI process rather than spawning a new one. The
  // `resolvedApiKey` field is forwarded so the side-question
  // resolves the same `github-copilot` profile token the embedded
  // run used; without it, `/btw` from a headless/cron run would
  // silently fall back to env / useLoggedInUser, which would
  // attempt a different identity and could fail on hosts without
  // logged-in CLI state.
  return {
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    copilotHome: params.copilotHome,
    cwd: params.cwd,
    auth: params.auth,
    authProfileId: params.authProfileId,
    profileVersion: params.profileVersion,
    resolvedApiKey: params.resolvedApiKey,
  } as unknown as CopilotPoolAcquireInput;
}

function buildSideQuestionSessionConfig(
  params: SideQuestionParamsLike,
  modelId: string,
  resolvedAuth: ReturnType<typeof resolvePoolAcquire>["auth"],
): Pick<SessionConfig, "gitHubToken" | "model" | "onPermissionRequest" | "tools" | "workingDirectory"> {
  // Defensive permission handler: tools is [] but the SDK does not
  // contractually rule out built-in tool calls in every future release.
  // A fail-closed handler ensures a side-question can never spawn an
  // interactive prompt. `onUserInputRequest` is intentionally not
  // registered so `ask_user` is hidden from the model (matches the
  // primary attempt path; see attempt.ts and
  // docs/plugins/copilot.md).
  //
  // Reasoning effort is intentionally NOT mapped here. OpenClaw's
  // `ReasoningLevel` enum ("off" | "on" | "stream") is not aligned
  // with the SDK's `ReasoningEffort` enum ("low" | "medium" | "high"
  // | "xhigh"). Side questions are short utility prompts where the
  // SDK / model default is sufficient. If the host needs finer
  // control later, that should land as part of byok-mapping work.
  return {
    model: modelId,
    onPermissionRequest: createPermissionBridge(rejectAllPolicy),
    tools: [] as SdkTool[],
    workingDirectory: readString(params.workspaceDir) ?? readString(params.cwd),
    // Session-level GitHub token (see attempt.ts:createSessionConfig
    // for the rationale). Identity is the same as the main attempt
    // because side-questions are dispatched on behalf of the same
    // run; carrying the token ensures content exclusion / model
    // routing / quota are consistent between the main attempt and
    // its `/btw` follow-ups.
    ...(resolvedAuth.authMode === "gitHubToken" && resolvedAuth.gitHubToken
      ? { gitHubToken: resolvedAuth.gitHubToken }
      : {}),
  };
}

export async function runCopilotSideQuestion(
  params: AgentHarnessSideQuestionParams,
  deps: SideQuestionDeps,
): Promise<AgentHarnessSideQuestionResult> {
  const input = params as SideQuestionParamsLike;

  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) {
    throw new Error("[copilot-side-question] question is empty");
  }

  const modelRef = resolveModelRef(input as unknown as CopilotPoolAcquireInput);
  if (!SUPPORTED_PROVIDERS.has(modelRef.provider)) {
    throw new Error(
      `[copilot-side-question] provider ${modelRef.provider} is not supported at MVP (subscription Copilot models only)`,
    );
  }

  const timeoutMs = deps.timeoutMs ?? DEFAULT_SIDE_QUESTION_TIMEOUT_MS;
  const poolAcquire = resolvePoolAcquire(buildSideQuestionPoolInput(input));

  let handle: PooledClient | undefined;
  let session: MinimalSession | undefined;
  let primaryError: Error | undefined;
  let timedOut = false;
  let accumulatedDeltaText = "";
  let result: SessionEvent | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    handle = await deps.pool.acquire(poolAcquire.key, poolAcquire.options);
    const sessionConfig = buildSideQuestionSessionConfig(input, modelRef.id, poolAcquire.auth);
    session = (await handle.client.createSession(sessionConfig)) as unknown as MinimalSession;

    // Accumulate streaming deltas as a fallback in case the final
    // assistant.message event carries no inline content.
    if (typeof session.on === "function") {
      unsubscribe = session.on((event) => {
        if (event.type === "assistant.message_delta") {
          const delta = (event as Extract<SessionEvent, { type: "assistant.message_delta" }>).data
            .deltaContent;
          if (typeof delta === "string") {
            accumulatedDeltaText += delta;
          }
        }
      });
    }

    result = await session.sendAndWait({ prompt: question }, timeoutMs);
    if (result === undefined) {
      // Defensive: keep handling the legacy `resolve(undefined)`
      // shape in case a future SDK release changes back, even
      // though @github/copilot-sdk@1.0.0-beta.4 rejects with the
      // shape detected in the catch block below.
      timedOut = true;
      primaryError = new Error(`[copilot-side-question] timed out after ${timeoutMs}ms`);
    }
  } catch (err: unknown) {
    if (isSdkSendAndWaitTimeoutError(err)) {
      // The SDK rejects sendAndWait with a deterministic timeout
      // message (see isSdkSendAndWaitTimeoutError). Flip timedOut so
      // the cleanup branch at the bottom of the finally block
      // calls session.abort() before disconnect — for `/btw` we
      // want the throwaway session torn down so quota isn't billed
      // for work the caller will never read. Set primaryError to
      // the canonical side-question timeout message so the caller
      // sees a consistent error message regardless of whether the
      // SDK resolved-undefined or rejected.
      timedOut = true;
      primaryError = new Error(`[copilot-side-question] timed out after ${timeoutMs}ms`);
    } else {
      primaryError = toError(err);
    }
  } finally {
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // listener cleanup must not mask the primary error
      }
    }
    if (session) {
      if (timedOut) {
        // Abort the in-flight turn before disconnecting so the model
        // stops consuming quota. Best-effort — don't mask the primary
        // timeout error if abort itself fails.
        try {
          await session.abort();
        } catch {
          // swallowed
        }
      }
      try {
        await session.disconnect();
      } catch {
        // swallowed
      }
      const sessionId = readString(session.id);
      if (sessionId && handle) {
        try {
          await handle.client.deleteSession(sessionId);
        } catch {
          // swallowed: best-effort cleanup
        }
      }
    }
    if (handle) {
      try {
        await deps.pool.release(handle);
      } catch {
        // swallowed: cleanup errors don't mask primary errors
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }
  return { text: extractAssistantText(result, accumulatedDeltaText) };
}
