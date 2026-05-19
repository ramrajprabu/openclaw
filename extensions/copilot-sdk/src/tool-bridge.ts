import type { Tool as SdkTool, ToolInvocation, ToolResultObject } from "@github/copilot-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";

type CreateOpenClawCodingTools =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type OpenClawCodingToolsOptions = Parameters<CreateOpenClawCodingTools>[0];

type AgentToolResultLike = {
  content?: unknown;
};

export interface CopilotSdkToolBridgeInput {
  modelProvider: string;
  modelId: string;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  abortSignal?: AbortSignal;
  createOpenClawCodingTools?: (opts: unknown) => AnyAgentTool[] | Promise<AnyAgentTool[]>;
  beforeExecute?: (ctx: {
    toolName: string;
    toolCallId: string;
    args: unknown;
    sourceTool: AnyAgentTool;
    invocation: ToolInvocation;
  }) => void | Promise<void>;
}

export interface CopilotSdkToolBridge {
  sdkTools: SdkTool[];
  sourceTools: AnyAgentTool[];
}

export const SUPPORTED_TOOL_PROVIDERS: ReadonlySet<string> = new Set([
  "github-copilot",
]);

export function supportsModelTools(modelProvider: string): boolean {
  return SUPPORTED_TOOL_PROVIDERS.has(modelProvider);
}

export async function createCopilotSdkToolBridge(
  input: CopilotSdkToolBridgeInput,
): Promise<CopilotSdkToolBridge> {
  if (!supportsModelTools(input.modelProvider)) {
    return { sdkTools: [], sourceTools: [] };
  }

  const createOpenClawCodingTools =
    input.createOpenClawCodingTools ??
    (await import("openclaw/plugin-sdk/agent-harness")).createOpenClawCodingTools;

  const toolOptions: OpenClawCodingToolsOptions = {
    agentDir: input.agentDir,
    agentId: input.agentId,
    abortSignal: input.abortSignal,
    modelId: input.modelId,
    modelProvider: input.modelProvider,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    workspaceDir: input.workspaceDir,
  };

  let sourceTools: unknown;
  try {
    sourceTools = await createOpenClawCodingTools(toolOptions);
  } catch (error: unknown) {
    throw createError(
      `[copilot-sdk-tool-bridge] createOpenClawCodingTools failed: ${toError(error).message}`,
      error,
    );
  }

  if (!Array.isArray(sourceTools)) {
    throw new Error(
      "[copilot-sdk-tool-bridge] createOpenClawCodingTools must return an array of tools",
    );
  }

  const duplicateNames = findDuplicateToolNames(sourceTools as AnyAgentTool[]);
  if (duplicateNames.length > 0) {
    throw new Error(`[copilot-sdk-tool-bridge] duplicate tool names: ${duplicateNames.join(", ")}`);
  }

  const tools = sourceTools as AnyAgentTool[];
  return {
    sdkTools: tools.map((sourceTool) =>
      convertOpenClawToolToSdkTool(sourceTool, {
        abortSignal: input.abortSignal,
        beforeExecute: input.beforeExecute,
      }),
    ),
    sourceTools: tools,
  };
}

export function convertOpenClawToolToSdkTool(
  sourceTool: AnyAgentTool,
  ctx: {
    abortSignal?: AbortSignal;
    beforeExecute?: CopilotSdkToolBridgeInput["beforeExecute"];
  },
): SdkTool {
  if (typeof sourceTool.name !== "string" || sourceTool.name.trim().length === 0) {
    throw new Error("[copilot-sdk-tool-bridge] tool name must be a non-empty string");
  }

  if (typeof sourceTool.execute !== "function") {
    throw new Error(
      `[copilot-sdk-tool-bridge] tool '${sourceTool.name}' must define an execute function`,
    );
  }

  let sequentialLock = Promise.resolve();
  const executeOnce = async (
    args: unknown,
    invocation: ToolInvocation,
  ): Promise<ToolResultObject> => {
    if (ctx.abortSignal?.aborted) {
      const error = new Error("[copilot-sdk-tool-bridge] aborted before execution");
      return createFailureResult(error.message, error);
    }

    try {
      await ctx.beforeExecute?.({
        args,
        invocation,
        sourceTool,
        toolCallId: invocation.toolCallId,
        toolName: sourceTool.name,
      });
    } catch (error: unknown) {
      return createFailureResult(
        `[copilot-sdk-tool-bridge] beforeExecute failed for tool '${sourceTool.name}': ${toError(error).message}`,
        error,
      );
    }

    let preparedArgs = args;
    try {
      preparedArgs = sourceTool.prepareArguments ? sourceTool.prepareArguments(args) : args;
    } catch (error: unknown) {
      return createFailureResult(
        `[copilot-sdk-tool-bridge] prepareArguments failed for tool '${sourceTool.name}': ${toError(error).message}`,
        error,
      );
    }

    let result: AgentToolResultLike;
    try {
      result = await sourceTool.execute(
        invocation.toolCallId,
        preparedArgs,
        ctx.abortSignal,
        undefined,
      );
    } catch (error: unknown) {
      return createFailureResult(
        `[copilot-sdk-tool-bridge] tool '${sourceTool.name}' failed: ${toError(error).message}`,
        error,
      );
    }

    return agentToolResultToSdk(result);
  };

  const handler =
    sourceTool.executionMode === "sequential"
      ? (args: unknown, invocation: ToolInvocation) => {
          const run = sequentialLock.then(
            () => executeOnce(args, invocation),
            () => executeOnce(args, invocation),
          );
          sequentialLock = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        }
      : executeOnce;

  return {
    description: sourceTool.description,
    handler,
    name: sourceTool.name,
    // OpenClaw owns its bridged tools by design (the harness docs:
    // "OpenClaw still owns ... OpenClaw dynamic tools (bridged)"). The bundled
    // Copilot CLI ships built-in tools whose names (edit, read, write, bash,
    // ...) collide with OpenClaw's coding-tool set. Mark every bridged tool as
    // an explicit override so the SDK accepts the registration rather than
    // throwing "External tool 'edit' conflicts with a built-in tool of the
    // same name." OpenClaw's tool layer is the source of truth for these
    // names within a copilot-sdk attempt.
    overridesBuiltInTool: true,
    parameters: sourceTool.parameters as Record<string, unknown> | undefined,
    // Bridged OpenClaw tools enforce their own permission/policy decisions
    // inside `wrapToolWithBeforeToolCallHook` (see
    // `src/agents/pi-tools.before-tool-call.ts` — the same hook PI itself
    // uses, providing loop detection, trusted plugin policies,
    // before-tool-call hooks, and two-phase plugin approvals via the
    // gateway). Asking the SDK to fire `onPermissionRequest` for
    // `kind: "custom-tool"` would either short-circuit OpenClaw's richer
    // enforcement (if we allow-all) or block every call (if we
    // reject-all) — neither matches PI parity. The in-tree codex harness
    // takes the same approach: bridged OpenClaw tools are wrapped with
    // `wrapToolWithBeforeToolCallHook` and the SDK gate is bypassed
    // (see `extensions/codex/src/app-server/dynamic-tools.ts`).
    skipPermission: true,
  };
}

function agentToolResultToSdk(result: AgentToolResultLike | undefined): ToolResultObject {
  const content = result?.content;
  if (content == null) {
    return createSuccessResult("");
  }

  if (!Array.isArray(content)) {
    return createUnsupportedContentFailure(typeof content);
  }

  const textParts: string[] = [];
  const binaryResults: Array<Record<string, string>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      return createUnsupportedContentFailure(typeof block);
    }

    const kind = readString((block as { type?: unknown }).type);
    if (kind === "text") {
      const text = readString((block as { text?: unknown }).text, { allowEmpty: true });
      if (text === undefined) {
        return createUnsupportedContentFailure(kind);
      }
      textParts.push(text);
      continue;
    }

    if (kind === "image") {
      const base64Data = readString((block as { data?: unknown }).data);
      const mimeType = readString((block as { mimeType?: unknown }).mimeType);
      if (!base64Data || !mimeType) {
        return createUnsupportedContentFailure(kind);
      }
      binaryResults.push({
        base64Data,
        data: base64Data,
        mimeType,
        type: "image",
      });
      continue;
    }

    return createUnsupportedContentFailure(kind ?? typeof block);
  }

  return {
    ...(binaryResults.length > 0
      ? { binaryResultsForLlm: binaryResults as ToolResultObject["binaryResultsForLlm"] }
      : {}),
    resultType: "success",
    textResultForLlm: textParts.join("\n"),
  };
}

function createUnsupportedContentFailure(kind: string): ToolResultObject {
  const message = `[copilot-sdk-tool-bridge] unsupported AgentToolResult content shape: ${kind}`;
  return createFailureResult(message, new Error(message));
}

function createSuccessResult(textResultForLlm: string): ToolResultObject {
  return {
    resultType: "success",
    textResultForLlm,
  };
}

function createFailureResult(message: string, error: unknown): ToolResultObject {
  // ToolResultObject.error is typed as `string | undefined` in the SDK contract
  // (see `node_modules/@github/copilot-sdk/dist/types.d.ts`). Returning an
  // Error object would produce a non-serializable JSON-RPC payload, so we
  // surface the message string instead.
  return {
    error: toError(error).message,
    resultType: "failure",
    textResultForLlm: message,
  };
}

function createError(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
}

function findDuplicateToolNames(sourceTools: AnyAgentTool[]): string[] {
  const counts = new Map<string, number>();
  for (const sourceTool of sourceTools) {
    if (typeof sourceTool.name !== "string" || sourceTool.name.length === 0) {
      continue;
    }
    counts.set(sourceTool.name, (counts.get(sourceTool.name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

function readString(value: unknown, options: { allowEmpty?: boolean } = {}): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (options.allowEmpty || value.length > 0) {
    return value;
  }
  return undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
