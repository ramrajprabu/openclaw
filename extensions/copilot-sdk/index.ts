import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCopilotSdkAgentHarness } from "./harness.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPoolOptions(pluginConfig: unknown): { idleTtlMs: number } | undefined {
  if (!isRecord(pluginConfig)) return undefined;

  const pool = pluginConfig.pool;
  if (!isRecord(pool)) return undefined;

  const idleTtlMs = pool.idleTtlMs;
  if (typeof idleTtlMs !== "number" || !Number.isFinite(idleTtlMs) || idleTtlMs < 1) {
    return undefined;
  }

  return { idleTtlMs };
}

export default definePluginEntry({
  id: "copilot-sdk",
  name: "GitHub Copilot SDK",
  description: "Registers the GitHub Copilot SDK agent harness.",
  register(api) {
    const poolOptions = readPoolOptions(api.pluginConfig);

    api.registerAgentHarness(
      createCopilotSdkAgentHarness(poolOptions ? { poolOptions } : undefined),
    );
  },
});
