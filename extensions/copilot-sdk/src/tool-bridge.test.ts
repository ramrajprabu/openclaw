import type { Tool as SdkTool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCopilotSdkToolBridge,
  convertOpenClawToolToSdkTool,
  supportsModelTools,
} from "./tool-bridge.js";

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
  prepareArguments?: ReturnType<typeof vi.fn>;
};

function createDeferred<T>() {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    reject(reason?: unknown) {
      rejectPromise?.(reason);
    },
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

function flushAsync() {
  return Promise.resolve().then(() => Promise.resolve());
}

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    arguments: { value: "input" },
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "tool-a",
    ...overrides,
  };
}

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function getError(result: ToolResultObject): Error | undefined {
  return (result as { error?: Error }).error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supportsModelTools", () => {
  it("returns true for github-copilot and false otherwise", () => {
    expect(supportsModelTools("github-copilot")).toBe(true);
    expect(supportsModelTools("openai")).toBe(false);
    expect(supportsModelTools("github")).toBe(false);
    expect(supportsModelTools("openclaw")).toBe(false);
    expect(supportsModelTools("copilot")).toBe(false);
    expect(supportsModelTools("")).toBe(false);
  });
});

describe("createCopilotSdkToolBridge", () => {
  it("returns empty arrays for unsupported providers without calling the seam", async () => {
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    const result = await createCopilotSdkToolBridge({
      agentId: "agent-1",
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "openai",
      sessionId: "session-1",
    });

    expect(result).toEqual({ sdkTools: [], sourceTools: [] });
    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(0);
  });

  it("forwards supported fields to injected createOpenClawCodingTools", async () => {
    const controller = new AbortController();
    const createOpenClawCodingTools = vi.fn(async () => [makeTool()]);

    await createCopilotSdkToolBridge({
      abortSignal: controller.signal,
      agentDir: "/agent",
      agentId: "agent-1",
      createOpenClawCodingTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
      sessionKey: "session-key",
      workspaceDir: "/workspace",
    });

    expect(createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(createOpenClawCodingTools).toHaveBeenCalledWith({
      abortSignal: controller.signal,
      agentDir: "/agent",
      agentId: "agent-1",
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
      sessionKey: "session-key",
      workspaceDir: "/workspace",
    });
  });

  it("returns sdkTools and sourceTools with matching lengths", async () => {
    const sourceTools = [makeTool(), makeTool({ name: "tool-b" })];

    const result = await createCopilotSdkToolBridge({
      agentId: "agent-1",
      createOpenClawCodingTools: async () => sourceTools,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    });

    expect(result.sourceTools).toBe(sourceTools);
    expect(result.sdkTools).toHaveLength(2);
    expect(result.sdkTools.map((tool) => tool.name)).toEqual(["tool-a", "tool-b"]);
  });

  it("throws when createOpenClawCodingTools returns a non-array", async () => {
    await expect(
      createCopilotSdkToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => ({ tools: [] }) as never,
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("createOpenClawCodingTools must return an array");
  });

  it("throws when createOpenClawCodingTools rejects and includes the cause", async () => {
    await expect(
      createCopilotSdkToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => {
          throw new Error("factory failed");
        },
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("factory failed");
  });

  it("throws on duplicate tool names and lists all duplicates", async () => {
    await expect(
      createCopilotSdkToolBridge({
        agentId: "agent-1",
        createOpenClawCodingTools: async () => [
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
          makeTool({ name: "alpha" }),
          makeTool({ name: "beta" }),
        ],
        modelId: "gpt-4o",
        modelProvider: "github-copilot",
        sessionId: "session-1",
      }),
    ).rejects.toThrow("duplicate tool names: alpha, beta");
  });
});

describe("convertOpenClawToolToSdkTool", () => {
  it("throws on empty and non-string names", () => {
    expect(() => convertOpenClawToolToSdkTool(makeTool({ name: "" as never }), {})).toThrow(
      "tool name must be a non-empty string",
    );
    expect(() => convertOpenClawToolToSdkTool(makeTool({ name: 42 as never }), {})).toThrow(
      "tool name must be a non-empty string",
    );
  });

  it("throws on non-function execute", () => {
    expect(() => convertOpenClawToolToSdkTool(makeTool({ execute: "nope" as never }), {})).toThrow(
      "must define an execute function",
    );
  });

  it("preserves name, description, and parameters exactly", () => {
    const parameters = {
      properties: { path: { type: "string" } },
      type: "object",
    };
    const sourceTool = makeTool({
      description: "Read a file",
      name: "read_file",
      parameters: parameters as never,
    });

    const result = convertOpenClawToolToSdkTool(sourceTool, {});

    expect(result.name).toBe("read_file");
    expect(result.description).toBe("Read a file");
    expect(result.parameters).toBe(parameters);
  });

  it("does not set skipPermission", () => {
    const result = convertOpenClawToolToSdkTool(makeTool(), {}) as SdkTool & {
      skipPermission?: boolean;
    };

    expect(Object.hasOwn(result, "skipPermission")).toBe(false);
  });

  it("marks every bridged tool as overridesBuiltInTool so OpenClaw owns names that collide with Copilot CLI built-ins (edit/read/write/bash/...)", () => {
    // Real-world dogfood found that openclaw's createOpenClawCodingTools
    // returns a tool named `edit`, which the bundled Copilot CLI also ships
    // as a built-in. The SDK rejects the registration unless the external
    // tool is explicitly marked as an override.
    for (const name of ["edit", "read", "write", "bash", "live_echo"]) {
      const result = convertOpenClawToolToSdkTool(makeTool({ name }), {}) as SdkTool & {
        overridesBuiltInTool?: boolean;
      };
      expect(result.overridesBuiltInTool).toBe(true);
    }
  });

  it("returns a failure result when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const sourceTool = makeTool();
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, { abortSignal: controller.signal });

    const result = await sdkTool.handler({}, makeInvocation());

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-sdk-tool-bridge] aborted before execution",
    });
    expect(getError(result as ToolResultObject)?.message).toBe(
      "[copilot-sdk-tool-bridge] aborted before execution",
    );
  });

  it("calls beforeExecute with the invocation context before execute", async () => {
    const beforeExecute = vi.fn(async () => undefined);
    const sourceTool = makeTool();
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, { beforeExecute });
    const invocation = makeInvocation({ toolCallId: "call-42" });
    const args = { value: "input" };

    await sdkTool.handler(args, invocation);

    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(beforeExecute).toHaveBeenCalledWith({
      args,
      invocation,
      sourceTool,
      toolCallId: "call-42",
      toolName: "tool-a",
    });
    expect(beforeExecute.mock.invocationCallOrder[0]).toBeLessThan(
      sourceTool.execute.mock.invocationCallOrder[0],
    );
  });

  it("returns a failure result when beforeExecute throws", async () => {
    const error = new Error("permission denied");
    const sourceTool = makeTool();
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {
      beforeExecute: vi.fn(async () => {
        throw error;
      }),
    });

    const result = await sdkTool.handler({}, makeInvocation());

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm:
        "[copilot-sdk-tool-bridge] beforeExecute failed for tool 'tool-a': permission denied",
    });
    expect(getError(result as ToolResultObject)).toBe(error);
  });

  it("calls prepareArguments and passes the prepared args and toolCallId to execute", async () => {
    const preparedArgs = { value: "prepared" };
    const prepareArguments = vi.fn(() => preparedArgs);
    const sourceTool = makeTool({ prepareArguments });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    await sdkTool.handler({ value: "raw" }, makeInvocation({ toolCallId: "call-99" }));

    expect(prepareArguments).toHaveBeenCalledTimes(1);
    expect(prepareArguments).toHaveBeenCalledWith({ value: "raw" });
    expect(sourceTool.execute).toHaveBeenCalledWith("call-99", preparedArgs, undefined, undefined);
  });

  it("returns a failure result when prepareArguments throws", async () => {
    const error = new Error("bad args");
    const sourceTool = makeTool({
      prepareArguments: vi.fn(() => {
        throw error;
      }),
    });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    const result = await sdkTool.handler({}, makeInvocation());

    expect(sourceTool.execute).toHaveBeenCalledTimes(0);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm:
        "[copilot-sdk-tool-bridge] prepareArguments failed for tool 'tool-a': bad args",
    });
    expect(getError(result as ToolResultObject)).toBe(error);
  });

  it("returns success with empty text when content is missing", async () => {
    const sourceTool = makeTool({}, { details: null });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toEqual({ resultType: "success", textResultForLlm: "" });
  });

  it("converts single text content to an exact textResultForLlm", async () => {
    const sdkTool = convertOpenClawToolToSdkTool(
      makeTool({}, { content: [{ text: "hello", type: "text" }], details: null }),
      {},
    );

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toEqual({ resultType: "success", textResultForLlm: "hello" });
  });

  it("joins multiple text blocks with newlines", async () => {
    const sdkTool = convertOpenClawToolToSdkTool(
      makeTool(
        {},
        {
          content: [
            { text: "first", type: "text" },
            { text: "second", type: "text" },
            { text: "third", type: "text" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toEqual({ resultType: "success", textResultForLlm: "first\nsecond\nthird" });
  });

  it("converts image content into binaryResultsForLlm while preserving text", async () => {
    const sdkTool = convertOpenClawToolToSdkTool(
      makeTool(
        {},
        {
          content: [
            { text: "preview", type: "text" },
            { data: "base64-data", mimeType: "image/png", type: "image" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toEqual({
      binaryResultsForLlm: [
        {
          base64Data: "base64-data",
          data: "base64-data",
          mimeType: "image/png",
          type: "image",
        },
      ],
      resultType: "success",
      textResultForLlm: "preview",
    });
  });

  it("returns a failure result for unsupported content shapes", async () => {
    const sdkTool = convertOpenClawToolToSdkTool(
      makeTool(
        {},
        {
          content: [{ type: "resource" }],
          details: null,
        },
      ),
      {},
    );

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm:
        "[copilot-sdk-tool-bridge] unsupported AgentToolResult content shape: resource",
    });
    expect(getError(result as ToolResultObject)?.message).toBe(
      "[copilot-sdk-tool-bridge] unsupported AgentToolResult content shape: resource",
    );
  });

  it("returns a failure result when execute throws and preserves the error", async () => {
    const error = new Error("tool exploded");
    const sourceTool = makeTool({
      execute: vi.fn(async () => {
        throw error;
      }),
    });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    const result = await sdkTool.handler({}, makeInvocation());

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-sdk-tool-bridge] tool 'tool-a' failed: tool exploded",
    });
    expect(getError(result as ToolResultObject)).toBe(error);
  });

  it("runs default tools in parallel", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    const firstRun = sdkTool.handler({}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = sdkTool.handler({}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(2);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("serializes sequential tools so the second call waits for the first", async () => {
    const first = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const second = createDeferred<{
      content: Array<{ text: string; type: string }>;
      details: null;
    }>();
    const execute = vi
      .fn()
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const sourceTool = makeTool({ execute, executionMode: "sequential" });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, {});

    const firstRun = sdkTool.handler({}, makeInvocation({ toolCallId: "call-1" }));
    const secondRun = sdkTool.handler({}, makeInvocation({ toolCallId: "call-2" }));
    await flushAsync();

    expect(execute).toHaveBeenCalledTimes(1);
    first.resolve({ content: [{ text: "one", type: "text" }], details: null });
    await firstRun;
    await flushAsync();
    expect(execute).toHaveBeenCalledTimes(2);
    second.resolve({ content: [{ text: "two", type: "text" }], details: null });

    await expect(Promise.all([firstRun, secondRun])).resolves.toEqual([
      { resultType: "success", textResultForLlm: "one" },
      { resultType: "success", textResultForLlm: "two" },
    ]);
  });

  it("returns a failure result when execute observes an abort after start", async () => {
    const controller = new AbortController();
    const sourceTool = makeTool({
      execute: vi.fn(
        (_toolCallId: string, _args: unknown, signal?: AbortSignal) =>
          new Promise((_, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted during execute"));
              },
              { once: true },
            );
          }),
      ),
    });
    const sdkTool = convertOpenClawToolToSdkTool(sourceTool, { abortSignal: controller.signal });

    const resultPromise = sdkTool.handler({}, makeInvocation());
    await flushAsync();
    controller.abort();
    const result = await resultPromise;

    expect(sourceTool.execute).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "[copilot-sdk-tool-bridge] tool 'tool-a' failed: aborted during execute",
    });
    expect(getError(result as ToolResultObject)?.message).toBe("aborted during execute");
  });
});
