import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isKnownAgentHarnessRuntimeId,
  KNOWN_AGENT_HARNESS_RUNTIME_IDS,
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
  it("exports known harness runtime ids including copilot-sdk", () => {
    expect(KNOWN_AGENT_HARNESS_RUNTIME_IDS).toEqual(["pi", "auto", "codex", "copilot-sdk"]);
    expect(isKnownAgentHarnessRuntimeId("copilot-sdk")).toBe(true);
    expect(isKnownAgentHarnessRuntimeId("custom-harness")).toBe(false);
  });

  it("passes through explicit copilot-sdk runtime policy", () => {
    expect(
      resolveAgentHarnessPolicy({
        provider: "anthropic",
        modelId: "claude-sonnet-4.6",
        config: providerRuntimeConfig("anthropic", "copilot-sdk"),
      }),
    ).toEqual({
      runtime: "copilot-sdk",
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
        config: providerRuntimeConfig("openai", "copilot-sdk"),
      }),
    ).toEqual({
      runtime: "copilot-sdk",
      runtimeSource: "provider",
    });
  });
});
