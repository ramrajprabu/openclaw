import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AGENT_HARNESS_RUNTIME_DESCRIPTORS,
  getAgentHarnessRuntimeDescriptor,
  isKnownAgentHarnessRuntimeId,
  KNOWN_AGENT_HARNESS_RUNTIME_IDS,
  listAgentHarnessRuntimeDescriptors,
  resolveAgentHarnessPolicy,
} from "./policy.js";

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://example.invalid/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("agent harness runtime policy", () => {
  it("exports known harness runtime ids including copilot", () => {
    expect(KNOWN_AGENT_HARNESS_RUNTIME_IDS).toEqual(["pi", "auto", "codex", "copilot"]);
    expect(isKnownAgentHarnessRuntimeId("copilot")).toBe(true);
    expect(isKnownAgentHarnessRuntimeId("custom-harness")).toBe(false);
  });

  it("passes through explicit copilot runtime policy", () => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4.6",
        config: providerRuntimeConfig("anthropic", "copilot"),
      }),
    ).toEqual({
      runtime: "copilot",
      runtimeSource: "provider",
    });
  });

  it("preserves unknown custom runtime ids for plugin harnesses", () => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4.6",
        config: providerRuntimeConfig("anthropic", "custom-harness"),
      }),
    ).toEqual({
      runtime: "custom-harness",
      runtimeSource: "provider",
    });
  });

  it("selects codex runtime implicitly for OpenAI providers in auto mode", () => {
    expect(resolveAgentHarnessPolicy({ provider: "openai", modelId: "gpt-5.4" })).toEqual({
      runtime: "codex",
      runtimeSource: "implicit",
    });
  });

  it("honors explicit non-auto runtime policy for OpenAI providers", () => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: providerRuntimeConfig("openai", "copilot"),
      }),
    ).toEqual({
      runtime: "copilot",
      runtimeSource: "provider",
    });
  });

  it("describes pi as a builtin harness", () => {
    const pi = getAgentHarnessRuntimeDescriptor("pi");
    expect(pi).toBeDefined();
    expect(pi?.kind).toBe("builtin-harness");
    expect(pi?.label).toBe("Built-in PI");
    expect(pi?.builtinPluginId).toBeUndefined();
  });

  it("describes copilot as a plugin harness with a builtin plugin id", () => {
    const copilot = getAgentHarnessRuntimeDescriptor("copilot");
    expect(copilot).toBeDefined();
    expect(copilot?.kind).toBe("plugin-harness");
    expect(copilot?.label).toBe("GitHub Copilot agent runtime");
    expect(copilot?.builtinPluginId).toBe("@openclaw/copilot");
  });

  it("classifies auto as a fallback and codex as an internal runtime alias", () => {
    expect(getAgentHarnessRuntimeDescriptor("auto")?.kind).toBe("fallback");
    expect(getAgentHarnessRuntimeDescriptor("codex")?.kind).toBe("internal-runtime-alias");
  });

  it("returns undefined for unknown runtime ids", () => {
    expect(getAgentHarnessRuntimeDescriptor("not-a-harness")).toBeUndefined();
    expect(isKnownAgentHarnessRuntimeId("not-a-harness")).toBe(false);
  });

  it("descriptor table is internally consistent", () => {
    const descriptors = listAgentHarnessRuntimeDescriptors();

    const ids = descriptors.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const descriptor of descriptors) {
      expect(descriptor.label.length).toBeGreaterThan(0);
    }

    for (const descriptor of descriptors) {
      if (descriptor.kind === "plugin-harness") {
        expect(descriptor.builtinPluginId).toBeTypeOf("string");
        expect(descriptor.builtinPluginId?.length).toBeGreaterThan(0);
      } else {
        expect(descriptor.builtinPluginId).toBeUndefined();
      }
    }

    expect(KNOWN_AGENT_HARNESS_RUNTIME_IDS).toEqual(ids);
  });
});
