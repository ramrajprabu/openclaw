import type { SessionConfig, SessionEvent, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessSideQuestionParams,
  AgentHarnessSideQuestionResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  readString,
  resolveModelRef,
  resolvePoolAcquire,
  SUPPORTED_PROVIDERS,
  toError,
  type CopilotSdkPoolAcquireInput,
} from "./attempt.js";
import { createPermissionBridge, rejectAllPolicy } from "./permission-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";
import { createUserInputBridge, denyAllUserInputPolicy } from "./user-input-bridge.js";

// Side-question bridge for the Copilot SDK harness.
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
  auth?: CopilotSdkPoolAcquireInput["auth"];
  copilotHome?: string;
  cwd?: string;
  profileVersion?: string;
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

function buildSideQuestionPoolInput(params: SideQuestionParamsLike): CopilotSdkPoolAcquireInput {
  // resolvePoolAcquire only inspects auth/agentId/agentDir/workspaceDir
  // /copilotHome/cwd/authProfileId/profileVersion. Keeping the cast
  // narrow documents that side-question shares the attempt pool key
  // so a `/btw` call can reuse the main attempt's pooled CLI process
  // rather than spawning a new one.
  return {
    agentId: params.agentId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    copilotHome: params.copilotHome,
    cwd: params.cwd,
    auth: params.auth,
    authProfileId: params.authProfileId,
    profileVersion: params.profileVersion,
  } as unknown as CopilotSdkPoolAcquireInput;
}

function buildSideQuestionSessionConfig(
  params: SideQuestionParamsLike,
  modelId: string,
): Pick<
  SessionConfig,
  "model" | "onPermissionRequest" | "onUserInputRequest" | "tools" | "workingDirectory"
> {
  // Defensive permission/userInput handlers: tools is [] but the SDK
  // does not contractually rule out built-in tool calls in every
  // future release. Fail-closed handlers ensure a side-question can
  // never spawn an interactive prompt.
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
    onUserInputRequest: createUserInputBridge(denyAllUserInputPolicy),
    tools: [] as SdkTool[],
    workingDirectory: readString(params.workspaceDir) ?? readString(params.cwd),
  };
}

export async function runCopilotSdkSideQuestion(
  params: AgentHarnessSideQuestionParams,
  deps: SideQuestionDeps,
): Promise<AgentHarnessSideQuestionResult> {
  const input = params as SideQuestionParamsLike;

  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) {
    throw new Error("[copilot-sdk-side-question] question is empty");
  }

  const modelRef = resolveModelRef(input as unknown as CopilotSdkPoolAcquireInput);
  if (!SUPPORTED_PROVIDERS.has(modelRef.provider)) {
    throw new Error(
      `[copilot-sdk-side-question] provider ${modelRef.provider} is not supported at MVP (subscription Copilot models only)`,
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
    const sessionConfig = buildSideQuestionSessionConfig(input, modelRef.id);
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
      timedOut = true;
      primaryError = new Error(`[copilot-sdk-side-question] timed out after ${timeoutMs}ms`);
    }
  } catch (err: unknown) {
    primaryError = toError(err);
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
