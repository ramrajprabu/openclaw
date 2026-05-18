import type { CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessSideQuestionParams,
  AgentHarnessSideQuestionResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { writeOpenClawCompactionMarker } from "./src/compaction-bridge.js";
import type { CopilotClientPool, CopilotClientPoolOptions, PooledClient } from "./src/runtime.js";

export type { CopilotClientPool, CopilotClientPoolOptions };

const DEFAULT_COPILOT_SDK_PROVIDER_IDS = new Set(["github", "openclaw", "copilot"]);

export interface CreateCopilotSdkAgentHarnessOptions {
  id?: string;
  label?: string;
  providerIds?: Iterable<string>;
  pluginConfig?: unknown;
  pool?: CopilotClientPool;
  poolOptions?: CopilotClientPoolOptions;
}

interface TrackedSession {
  sdkSessionId: string;
  client: CopilotClient;
  // Compatibility fingerprint of the params that created the SDK
  // session. We only reuse the tracked SDK session when the next
  // attempt's fingerprint matches — different provider/model/cwd/auth
  // configurations should start a fresh SDK session rather than resume
  // one bound to incompatible state. Mismatch falls back to
  // `createSession` (no resume injection) and the new sdkSessionId
  // replaces this entry via `onSessionEstablished`.
  compatKey: string;
}

// Build a string fingerprint of the attempt params that must agree
// across turns for SDK-session reuse to be safe. Keep this list
// conservative: any field whose change would invalidate the SDK
// session's bound state belongs here. Token / auth profile rotation
// produces a new fingerprint so we don't replay a session against a
// stale credential.
function computeSessionCompatKey(params: AgentHarnessAttemptParams): string {
  const p = params as AgentHarnessAttemptParams & {
    auth?: {
      gitHubToken?: string;
      profileId?: string;
      profileVersion?: string;
      useLoggedInUser?: boolean;
    };
    copilotHome?: string;
    cwd?: string;
    model?: string | { api?: string; id?: string; provider?: string };
    profileVersion?: string;
  };
  const modelObj: { api?: string; id?: string; provider?: string } =
    p.model && typeof p.model === "object"
      ? p.model
      : { id: typeof p.model === "string" ? p.model : undefined };
  const auth = p.auth ?? {};
  const parts = [
    `provider=${String(modelObj.provider ?? "")}`,
    `model=${String(modelObj.id ?? "")}`,
    `api=${String(modelObj.api ?? "")}`,
    `cwd=${String(p.cwd ?? p.workspaceDir ?? "")}`,
    `agentDir=${String(p.agentDir ?? "")}`,
    `copilotHome=${String(p.copilotHome ?? "")}`,
    `auth.profileId=${String(auth.profileId ?? "")}`,
    `auth.profileVersion=${String(auth.profileVersion ?? p.profileVersion ?? "")}`,
    `auth.loggedInUser=${auth.useLoggedInUser ? "1" : "0"}`,
    `auth.hasToken=${auth.gitHubToken ? "1" : "0"}`,
  ];
  return parts.join("|");
}

export function createCopilotSdkAgentHarness(
  options?: CreateCopilotSdkAgentHarnessOptions,
): AgentHarness {
  const providerIds = new Set(
    [...(options?.providerIds ?? DEFAULT_COPILOT_SDK_PROVIDER_IDS)].map((id) =>
      id.trim().toLowerCase(),
    ),
  );

  let poolPromise: Promise<CopilotClientPool> | undefined;
  let createdPool: CopilotClientPool | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  // Maps OpenClaw session id (from AgentHarnessAttemptParams.sessionId) to
  // the SDK session id + client that owns it. Populated by
  // runCopilotSdkAttempt via the onSessionEstablished callback so that
  // reset(params) can call client.deleteSession on the right client.
  const trackedSessions = new Map<string, TrackedSession>();

  async function getPool(): Promise<CopilotClientPool> {
    if (options?.pool) return options.pool;
    if (!poolPromise) {
      poolPromise = (async () => {
        const { createCopilotClientPool } = await import("./src/runtime.js");
        createdPool = createCopilotClientPool(options?.poolOptions);
        return createdPool;
      })();
    }
    return poolPromise;
  }

  return {
    id: options?.id ?? "copilot-sdk",
    label: options?.label ?? "GitHub Copilot SDK",

    supports(ctx) {
      const requestedRuntime = String(ctx.requestedRuntime ?? "")
        .trim()
        .toLowerCase();
      if (requestedRuntime !== "copilot-sdk") {
        return { supported: false, reason: "copilot-sdk is opt-in only" };
      }
      const provider = ctx.provider.trim().toLowerCase();
      if (!providerIds.has(provider)) {
        return {
          supported: false,
          reason: `provider is not one of: ${[...providerIds].toSorted().join(", ")}`,
        };
      }
      return { supported: true, priority: 100 };
    },

    async runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult> {
      if (disposed) {
        throw new Error("[copilot-sdk] harness has been disposed; cannot start new attempts");
      }
      const { runCopilotSdkAttempt } = await import("./src/attempt.js");
      const pool = await getPool();
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;

      // Dogfood finding #4: reuse the SDK session across turns within
      // the same OpenClaw session so that the Copilot SDK's prompt
      // cache, tool-call history, and any server-side compaction state
      // survive turn boundaries. Without this, every turn called
      // `createSession()` and lost cache + thread continuity — the
      // smoking gun was distinct `${sdkSessionId}` scopes per turn in
      // the playground transcript.
      //
      // Safety:
      //   - Only inject when the tracked compatKey still matches the
      //     current attempt's fingerprint (provider/model/cwd/auth).
      //     Mismatch falls through to `createSession` and the new SDK
      //     session replaces the tracked entry below.
      //   - Preserve any caller-provided `replayInvalid: true` — never
      //     downgrade an orchestrator-issued safety signal to false.
      //     `decideReplayAction` treats undefined as resumable already.
      //   - On resume failure, `attempt.ts` recovers via the
      //     `replay-shim` (`resumeFailureRecovered:true`) and falls
      //     back to `createSession`, so a stale-session error never
      //     surfaces as a prompt error.
      const currentCompatKey = computeSessionCompatKey(params);
      const tracked = openclawSessionId ? trackedSessions.get(openclawSessionId) : undefined;
      const resumableSessionId =
        tracked && tracked.compatKey === currentCompatKey ? tracked.sdkSessionId : undefined;
      const effectiveParams: AgentHarnessAttemptParams = resumableSessionId
        ? ({
            ...params,
            initialReplayState: {
              ...(params.initialReplayState ?? {}),
              sdkSessionId: resumableSessionId,
            },
          } as AgentHarnessAttemptParams)
        : params;

      const attemptPromise = runCopilotSdkAttempt(effectiveParams, {
        pool,
        onSessionEstablished: openclawSessionId
          ? ({
              sdkSessionId,
              pooledClient,
            }: {
              sdkSessionId: string;
              pooledClient: PooledClient;
            }) => {
              trackedSessions.set(openclawSessionId, {
                sdkSessionId,
                client: pooledClient.client,
                compatKey: currentCompatKey,
              });
            }
          : undefined,
      });
      inFlight.add(attemptPromise);
      try {
        return await attemptPromise;
      } finally {
        inFlight.delete(attemptPromise);
      }
    },

    async runSideQuestion(
      params: AgentHarnessSideQuestionParams,
    ): Promise<AgentHarnessSideQuestionResult> {
      if (disposed) {
        throw new Error("[copilot-sdk] harness has been disposed; cannot run side questions");
      }
      const { runCopilotSdkSideQuestion } = await import("./src/side-question.js");
      const pool = await getPool();
      const sidePromise = runCopilotSdkSideQuestion(params, { pool });
      inFlight.add(sidePromise);
      try {
        return await sidePromise;
      } finally {
        inFlight.delete(sidePromise);
      }
    },

    async reset(params: AgentHarnessResetParams): Promise<void> {
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!openclawSessionId) {
        return;
      }
      const tracked = trackedSessions.get(openclawSessionId);
      if (!tracked) {
        // Session was created by a different harness, or already reset.
        return;
      }
      trackedSessions.delete(openclawSessionId);
      try {
        await tracked.client.deleteSession(tracked.sdkSessionId);
      } catch {
        // Best-effort: client may be stopped, session may not exist
        // server-side, or the SDK may report a transient error. The
        // registry already logs broadcast reset failures; swallow here
        // so one harness cannot block the reset broadcast.
      }
    },

    async compact(
      params: AgentHarnessCompactParams,
    ): Promise<AgentHarnessCompactResult | undefined> {
      // The Copilot SDK manages compaction automatically via
      // `SessionConfig.infiniteSessions` (background-async when
      // utilization crosses `backgroundCompactionThreshold`). There is
      // no synchronous compact RPC, so the harness cannot honour
      // `params.force === true` directly. Instead this method writes
      // an OpenClaw-shaped marker file under
      // `<workspaceDir>/files/openclaw-compaction-<ts>-<sessionId>.json`
      // so existing OpenClaw transcript readers see a familiar
      // compaction artifact when the host calls compact(). See
      // src/compaction-bridge.ts for the bridge boundary.
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const workspaceDir =
        typeof params.workspaceDir === "string" ? params.workspaceDir : undefined;
      if (!openclawSessionId || !workspaceDir) {
        return {
          ok: false,
          compacted: false,
          reason: "missing-required-params",
        };
      }
      const tracked = trackedSessions.get(openclawSessionId);
      const reason = params.force
        ? "force-requested-but-sdk-has-no-synchronous-compact-api"
        : "deferred-to-sdk-infinite-sessions";
      try {
        await writeOpenClawCompactionMarker({
          sessionId: openclawSessionId,
          workspaceDir,
          trigger: params.trigger,
          currentTokenCount: params.currentTokenCount,
          sdkSessionId: tracked?.sdkSessionId,
          force: params.force,
          reason,
        });
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: "marker-write-failed",
          failure: {
            reason: "marker-write-failed",
            rawError: err instanceof Error ? err.message : String(err),
          },
        };
      }
      return {
        ok: true,
        compacted: false,
        reason,
      };
    },

    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        if (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
        trackedSessions.clear();
        if (createdPool) {
          const errors = await createdPool.dispose();
          if (errors.length > 0) {
            throw new AggregateError(errors, "[copilot-sdk] pool disposal errors");
          }
        }
      })();
      return disposePromise;
    },
  };
}
