import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelRuntimePolicy } from "../model-runtime-policy.js";
import {
  isOpenAICodexProvider,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../openai-codex-routing.js";
import {
  normalizeEmbeddedAgentRuntime,
  type EmbeddedAgentRuntime,
} from "../pi-embedded-runner/runtime.js";

/** Semantic discriminator for harness runtime ids. */
export type AgentHarnessRuntimeKind =
  | "builtin-harness"
  | "fallback"
  | "internal-runtime-alias"
  | "plugin-harness";

export type AgentHarnessRuntimeDescriptor = {
  /** Runtime id as it appears in config (`agentRuntime.id`). */
  readonly id: string;
  /** Semantic category (see AgentHarnessRuntimeKind). */
  readonly kind: AgentHarnessRuntimeKind;
  /** Human-readable label for wizards / future help surfaces. */
  readonly label: string;
  /**
   * Plugin package id when `kind === "plugin-harness"`. Undefined for all
   * other kinds. Future install/resolve consumers can key off this.
   */
  readonly builtinPluginId?: string;
};

export const AGENT_HARNESS_RUNTIME_DESCRIPTORS = [
  { id: "pi", kind: "builtin-harness", label: "Built-in PI" },
  { id: "auto", kind: "fallback", label: "Auto (default; falls back to PI)" },
  {
    id: "codex",
    kind: "internal-runtime-alias",
    label: "OpenAI Codex (PI runtime alias)",
  },
  {
    id: "github-copilot",
    kind: "plugin-harness",
    label: "GitHub Copilot agent runtime",
    builtinPluginId: "@openclaw/github-copilot-agent-runtime",
  },
] as const satisfies readonly AgentHarnessRuntimeDescriptor[];

export type KnownAgentHarnessRuntimeId = (typeof AGENT_HARNESS_RUNTIME_DESCRIPTORS)[number]["id"];

export const KNOWN_AGENT_HARNESS_RUNTIME_IDS: readonly KnownAgentHarnessRuntimeId[] =
  AGENT_HARNESS_RUNTIME_DESCRIPTORS.map((d) => d.id);

const descriptorById: ReadonlyMap<string, AgentHarnessRuntimeDescriptor> = new Map(
  AGENT_HARNESS_RUNTIME_DESCRIPTORS.map((d) => [d.id, d]),
);

export function isKnownAgentHarnessRuntimeId(id: string): id is KnownAgentHarnessRuntimeId {
  return descriptorById.has(id);
}

export function getAgentHarnessRuntimeDescriptor(
  id: string,
): AgentHarnessRuntimeDescriptor | undefined {
  return descriptorById.get(id);
}

export function listAgentHarnessRuntimeDescriptors(): readonly AgentHarnessRuntimeDescriptor[] {
  return AGENT_HARNESS_RUNTIME_DESCRIPTORS;
}

export type AgentHarnessPolicy = {
  runtime: EmbeddedAgentRuntime;
  runtimeSource?: "model" | "provider" | "implicit";
};

export function resolveAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  const configured = resolveModelRuntimePolicy({
    config: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const configuredRuntime = configured.policy?.id?.trim();
  const runtimeSource = configured.source ?? "implicit";
  const runtime =
    configuredRuntime && configuredRuntime !== "default"
      ? normalizeEmbeddedAgentRuntime(configuredRuntime)
      : "auto";
  if (
    openAIProviderUsesCodexRuntimeByDefault({ provider: params.provider, config: params.config })
  ) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  if (isOpenAICodexProvider(params.provider)) {
    if (runtime === "auto") {
      return { runtime: "codex", runtimeSource };
    }
    return { runtime, runtimeSource };
  }
  return {
    runtime,
    runtimeSource,
  };
}
