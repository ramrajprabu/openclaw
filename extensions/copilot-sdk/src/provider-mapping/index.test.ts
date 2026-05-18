import type { ProviderConfig as SdkProviderConfig } from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  __clearCopilotSdkProviderMappingRegistryForTests,
  __unregisterCopilotSdkProviderMappingForTests,
  getCopilotSdkProviderMapping,
  listRegisteredCopilotSdkProviderIds,
  registerCopilotSdkProviderMapping,
  resolveCopilotSdkProviderConfig,
  supportsCopilotSdkByokProvider,
  type CopilotSdkProviderMapping,
  type CopilotSdkProviderMappingContext,
} from "./index.js";

function makeStubMapping(
  overrides: Partial<CopilotSdkProviderMapping> = {},
): CopilotSdkProviderMapping {
  return {
    providerId: "azure-openai",
    label: "Azure OpenAI",
    buildProviderConfig: (ctx) => ({
      type: "azure",
      baseUrl: ctx.baseUrl ?? "https://example.openai.azure.com",
      apiKey: ctx.apiKey ?? "stub-key",
    }),
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<CopilotSdkProviderMappingContext> = {},
): CopilotSdkProviderMappingContext {
  return {
    modelId: "gpt-4o",
    providerId: "azure-openai",
    ...overrides,
  };
}

afterEach(() => {
  __clearCopilotSdkProviderMappingRegistryForTests();
});

describe("provider-mapping registry (BYOK skeleton)", () => {
  it("starts empty so supportsCopilotSdkByokProvider returns false for any provider at MVP", () => {
    expect(supportsCopilotSdkByokProvider("azure-openai")).toBe(false);
    expect(supportsCopilotSdkByokProvider("ollama")).toBe(false);
    expect(supportsCopilotSdkByokProvider("anthropic")).toBe(false);
    // Subscription Copilot providers are NOT BYOK; they live in
    // attempt.ts SUPPORTED_PROVIDERS, not here.
    expect(supportsCopilotSdkByokProvider("github")).toBe(false);
    expect(supportsCopilotSdkByokProvider("copilot")).toBe(false);
    expect(supportsCopilotSdkByokProvider("openclaw")).toBe(false);
  });

  it("registers a mapping and surfaces it via getCopilotSdkProviderMapping (case-insensitive lookup)", () => {
    const mapping = makeStubMapping();
    registerCopilotSdkProviderMapping(mapping);
    expect(getCopilotSdkProviderMapping("azure-openai")).toBe(mapping);
    expect(getCopilotSdkProviderMapping("Azure-OpenAI")).toBe(mapping);
    expect(getCopilotSdkProviderMapping("AZURE-OPENAI")).toBe(mapping);
  });

  it("supportsCopilotSdkByokProvider returns true after registration", () => {
    expect(supportsCopilotSdkByokProvider("azure-openai")).toBe(false);
    registerCopilotSdkProviderMapping(makeStubMapping());
    expect(supportsCopilotSdkByokProvider("azure-openai")).toBe(true);
    expect(supportsCopilotSdkByokProvider("AZURE-OPENAI")).toBe(true);
  });

  it("throws when registering the same providerId twice (programmer error)", () => {
    registerCopilotSdkProviderMapping(makeStubMapping({ label: "first" }));
    expect(() =>
      registerCopilotSdkProviderMapping(makeStubMapping({ label: "second" })),
    ).toThrowError(/already registered/u);
  });

  it("treats casing differences as the same provider when checking duplicates", () => {
    registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "azure-openai" }));
    expect(() =>
      registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "Azure-OpenAI" })),
    ).toThrowError(/already registered/u);
  });

  it("throws when providerId is empty or whitespace", () => {
    expect(() =>
      registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "" })),
    ).toThrowError(/non-empty/u);
    expect(() =>
      registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "   " })),
    ).toThrowError(/non-empty/u);
  });

  it("getCopilotSdkProviderMapping returns undefined for unknown, empty, or non-string providerIds", () => {
    expect(getCopilotSdkProviderMapping("unknown")).toBeUndefined();
    expect(getCopilotSdkProviderMapping("")).toBeUndefined();
    expect(getCopilotSdkProviderMapping("   ")).toBeUndefined();
    // Non-string input is a programmer error elsewhere, but the
    // registry guards against it to make BYOK code-paths safe.
    expect(getCopilotSdkProviderMapping(undefined as unknown as string)).toBeUndefined();
  });

  it("resolveCopilotSdkProviderConfig returns undefined when no adapter is registered", () => {
    expect(resolveCopilotSdkProviderConfig(makeCtx())).toBeUndefined();
  });

  it("resolveCopilotSdkProviderConfig delegates to the registered adapter", () => {
    const built: SdkProviderConfig = {
      type: "openai",
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
    };
    registerCopilotSdkProviderMapping(makeStubMapping({ buildProviderConfig: () => built }));
    expect(resolveCopilotSdkProviderConfig(makeCtx())).toBe(built);
  });

  it("passes the resolution context through to the adapter without mutation", () => {
    let received: CopilotSdkProviderMappingContext | undefined;
    registerCopilotSdkProviderMapping(
      makeStubMapping({
        buildProviderConfig: (ctx) => {
          received = ctx;
          return undefined;
        },
      }),
    );
    const ctx = makeCtx({
      apiKey: "ak",
      bearerToken: "bt",
      baseUrl: "https://x/v1",
      headers: { "x-trace": "abc" },
      extra: { deployment: "gpt-4o-prod" },
    });
    resolveCopilotSdkProviderConfig(ctx);
    expect(received).toBe(ctx);
  });

  it("resolveCopilotSdkProviderConfig returns undefined when the adapter cannot serve the request", () => {
    registerCopilotSdkProviderMapping(makeStubMapping({ buildProviderConfig: () => undefined }));
    expect(resolveCopilotSdkProviderConfig(makeCtx())).toBeUndefined();
  });

  it("propagates adapter exceptions (programmer errors are not swallowed)", () => {
    registerCopilotSdkProviderMapping(
      makeStubMapping({
        buildProviderConfig: () => {
          throw new Error("adapter bug");
        },
      }),
    );
    expect(() => resolveCopilotSdkProviderConfig(makeCtx())).toThrowError("adapter bug");
  });

  it("listRegisteredCopilotSdkProviderIds preserves declared casing", () => {
    registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "Azure-OpenAI" }));
    registerCopilotSdkProviderMapping(
      makeStubMapping({ providerId: "Ollama", buildProviderConfig: () => undefined }),
    );
    expect(listRegisteredCopilotSdkProviderIds()).toEqual(["Azure-OpenAI", "Ollama"]);
  });

  it("__unregisterCopilotSdkProviderMappingForTests removes an adapter", () => {
    registerCopilotSdkProviderMapping(makeStubMapping());
    expect(supportsCopilotSdkByokProvider("azure-openai")).toBe(true);
    expect(__unregisterCopilotSdkProviderMappingForTests("azure-openai")).toBe(true);
    expect(supportsCopilotSdkByokProvider("azure-openai")).toBe(false);
    expect(__unregisterCopilotSdkProviderMappingForTests("azure-openai")).toBe(false);
  });

  it("__clearCopilotSdkProviderMappingRegistryForTests wipes all adapters", () => {
    registerCopilotSdkProviderMapping(makeStubMapping({ providerId: "azure-openai" }));
    registerCopilotSdkProviderMapping(
      makeStubMapping({ providerId: "ollama", buildProviderConfig: () => undefined }),
    );
    expect(listRegisteredCopilotSdkProviderIds()).toHaveLength(2);
    __clearCopilotSdkProviderMappingRegistryForTests();
    expect(listRegisteredCopilotSdkProviderIds()).toHaveLength(0);
  });
});
