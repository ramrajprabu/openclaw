import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CopilotClientPool, CopilotClientPoolOptions } from "./src/runtime.js";

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

    async runAttempt(params) {
      if (disposed) {
        throw new Error("[copilot-sdk] harness has been disposed; cannot start new attempts");
      }
      const { runCopilotSdkAttempt } = await import("./src/attempt.js");
      const pool = await getPool();
      const attemptPromise = runCopilotSdkAttempt(params, { pool });
      inFlight.add(attemptPromise);
      try {
        return await attemptPromise;
      } finally {
        inFlight.delete(attemptPromise);
      }
    },

    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        if (inFlight.size > 0) {
          await Promise.allSettled([...inFlight]);
        }
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
