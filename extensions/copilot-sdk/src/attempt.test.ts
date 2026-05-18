import type { CopilotClient, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCopilotSdkAttempt } from "./attempt.js";
import type { CopilotClientPool } from "./runtime.js";

// Mock the dual-write transcript mirror so attempt tests do not touch the
// real filesystem. The mirror call site is exercised separately in
// dual-write-transcripts.test.ts and by the dedicated attempt
// dual-write tests below; the mocked module here just captures the
// invocation arguments without writing to disk.
const dualWriteMock = vi.hoisted(() => ({
  dualWriteCopilotSdkTranscriptBestEffort: vi.fn().mockResolvedValue(undefined),
  attachCopilotSdkMirrorIdentity: <T>(message: T, identity: string): T => {
    const record = message as unknown as Record<string, unknown>;
    return {
      ...record,
      __openclaw: { ...(record.__openclaw as object | undefined), mirrorIdentity: identity },
    } as unknown as T;
  },
}));
vi.mock("./dual-write-transcripts.js", () => dualWriteMock);

type SessionEventShape = {
  data: Record<string, unknown>;
  id: string;
  parentId: string | null;
  timestamp: string;
  type: string;
};

type FakeSession = {
  abort: ReturnType<typeof vi.fn>;
  cfg: Record<string, unknown>;
  disconnect: ReturnType<typeof vi.fn>;
  emit: (eventType: string, data: Record<string, unknown>) => void;
  id: string;
  off: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  sendAndWait: ReturnType<typeof vi.fn>;
  sessionId: string;
};

type FakeSdk = ReturnType<typeof makeFakeSdk>;

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

function getPromptErrorCode(result: AgentHarnessAttemptResult): string | undefined {
  return (result.promptError as { code?: string } | undefined)?.code;
}

function getSdkSessionId(result: AgentHarnessAttemptResult): string | undefined {
  return (result as AgentHarnessAttemptResult & { sdkSessionId?: string }).sdkSessionId;
}

function makeEvent(type: string, data: Record<string, unknown>): SessionEventShape {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
  };
}

function makeAssistantMessageEvent(
  content = "assistant text",
  overrides: Partial<Record<string, unknown>> = {},
): SessionEventShape {
  return makeEvent("assistant.message", {
    content,
    messageId: "msg-1",
    model: "gpt-4o",
    ...overrides,
  });
}

function createFakeSession(cfg: Record<string, unknown>, id: string): FakeSession {
  const listeners = new Map<string, Array<(event: SessionEventShape) => void>>();
  return {
    abort: vi.fn(async () => undefined),
    cfg,
    disconnect: vi.fn(async () => undefined),
    emit: (eventType: string, data: Record<string, unknown>) => {
      const event = makeEvent(eventType, data);
      for (const listener of listeners.get(eventType) ?? []) {
        listener(event);
      }
    },
    id,
    off: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      listeners.set(
        eventType,
        handlers.filter((existing) => existing !== handler),
      );
    }),
    on: vi.fn((eventType: string, handler: (event: SessionEventShape) => void) => {
      const handlers = listeners.get(eventType) ?? [];
      handlers.push(handler);
      listeners.set(eventType, handlers);
    }),
    sendAndWait: vi.fn(async () => makeAssistantMessageEvent()),
    sessionId: id,
  };
}

function makeFakePool(sdk: FakeSdk) {
  const pool: CopilotClientPool = {
    acquire: vi.fn(async (key, _options) => ({
      client: sdk.client as unknown as CopilotClient,
      key,
    })),
    dispose: vi.fn(async () => []),
    release: vi.fn(async () => undefined),
    size: vi.fn(() => 0),
  };
  return pool;
}

function makeFakeSdk(
  options: {
    onCreateSession?: (session: FakeSession, cfg: Record<string, unknown>) => void | Promise<void>;
    onResumeSession?: (
      session: FakeSession,
      sessionId: string,
      cfg: Record<string, unknown>,
    ) => void | Promise<void>;
  } = {},
) {
  const sessions: FakeSession[] = [];

  const createSession = vi.fn(async (cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, `sess-${sessions.length + 1}`);
    await options.onCreateSession?.(session, cfg);
    sessions.push(session);
    return session;
  });

  const resumeSession = vi.fn(async (sessionId: string, cfg: Record<string, unknown>) => {
    const session = createFakeSession(cfg, sessionId);
    await options.onResumeSession?.(session, sessionId, cfg);
    sessions.push(session);
    return session;
  });

  return {
    client: {
      createSession,
      resumeSession,
      stop: vi.fn(async () => []),
    },
    createSession,
    resumeSession,
    sessions,
  };
}

function makeParams(
  overrides: Partial<
    AgentHarnessAttemptParams & {
      auth: {
        gitHubToken?: string;
        profileId?: string;
        profileVersion?: string;
        useLoggedInUser?: boolean;
      };
      initialReplayState: { sdkSessionId?: string };
      messages: Array<{ content: string; role: "user"; timestamp: number }>;
      model: { api: string; id: string; provider: string };
      onAssistantDelta: (payload: { delta: string; text: string }) => void | Promise<void>;
      profileVersion: string;
    }
  > = {},
): AgentHarnessAttemptParams {
  return {
    agentDir: "C:\\copilot-home",
    agentId: "agent-1",
    auth: { useLoggedInUser: true, ...(overrides as { auth?: object }).auth },
    initialReplayState: undefined,
    messages: [{ content: "hello", role: "user", timestamp: 1 }],
    model: {
      api: "openai-responses",
      id: "gpt-4o",
      provider: "github-copilot",
      ...(typeof overrides.model === "object" ? overrides.model : {}),
    },
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runCopilotSdkAttempt", () => {
  it("happy path", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(sdk.sessions[0]?.sendAndWait).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.promptError).toBeUndefined();
    expect(result.lastAssistant?.role).toBe("assistant");
    expect(result.assistantTexts).toEqual(["done"]);
    expect(result.messagesSnapshot.length).toBe(2);
    expect(getSdkSessionId(result)).toBe("sess-1");
  });

  it("subscribe-before-send", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.on.mock.calls[0]?.[0]).toBe("assistant.message_delta");
    expect(session.on.mock.invocationCallOrder[0]).toBeLessThan(
      session.sendAndWait.mock.invocationCallOrder[0],
    );
  });

  it("deltas forwarded in order via promise chain", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const onAssistantDelta = vi.fn(async (payload: { delta: string }) => {
      order.push(`start:${payload.delta}`);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          order.push(`end:${payload.delta}`);
          resolve();
        });
      });
    });
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotSdkAttempt(makeParams({ onAssistantDelta }), {
      createToolBridge,
      pool,
    });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    await flushAsync();

    expect(onAssistantDelta).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(2);
    releases[1]?.();
    await flushAsync();
    expect(onAssistantDelta).toHaveBeenCalledTimes(3);
    releases[2]?.();
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("deltas forwarded even when no consumer", async () => {
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotSdkAttempt(makeParams(), { createToolBridge, pool });
    await flushAsync();

    const session = sdk.sessions[0];
    session.emit("assistant.message_delta", { deltaContent: "a", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "b", messageId: "msg-1" });
    session.emit("assistant.message_delta", { deltaContent: "c", messageId: "msg-1" });
    sendDeferred.resolve(makeAssistantMessageEvent("abc"));

    const result = await runPromise;
    expect(result.assistantTexts).toEqual(["abc"]);
  });

  it("resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-1" } as never }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(sdk.resumeSession.mock.calls[0]?.[0]).toBe("resume-1");
    expect(
      (sdk.resumeSession.mock.calls[0]?.[1] as { continuePendingWork?: boolean })
        .continuePendingWork,
    ).toBe(false);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("replay-shim: replayInvalid:true forces createSession even when sdkSessionId is present", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({
        initialReplayState: {
          sdkSessionId: "resume-stale",
          replayInvalid: true,
        } as never,
      }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    // Downgrade invalidates replay even when no side effects occurred.
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
  });

  it("replay-shim: recovers from missing-session resume failure by downgrading to createSession", async () => {
    let resumeCalls = 0;
    const sdk = makeFakeSdk({
      onResumeSession: () => {
        resumeCalls += 1;
        throw Object.assign(new Error("session not found"), { status: 404 });
      },
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("fresh"));
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-gone" } as never }),
      { pool },
    );

    expect(resumeCalls).toBe(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(1);
    expect(result.promptError).toBeUndefined();
    // Recovery invalidates replay even though no side effects occurred.
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: false,
      replaySafe: false,
    });
    // The freshly-created session id is reported, not the stale resume id.
    expect(getSdkSessionId(result)).not.toBe("resume-gone");
  });

  it("replay-shim: unrecoverable resume failure surfaces as promptError (no downgrade)", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: () => {
        throw new Error("ECONNRESET network failure");
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({ initialReplayState: { sdkSessionId: "resume-x" } as never }),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(result.promptError?.message).toContain("ECONNRESET");
  });

  it("replay-shim: prior hadPotentialSideEffects propagates into result replayMetadata", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({
        initialReplayState: { hadPotentialSideEffects: true } as never,
      }),
      { pool },
    );

    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("replay-shim: prior replayInvalid propagates even on an early-return failure", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
        initialReplayState: {
          replayInvalid: true,
          hadPotentialSideEffects: true,
        } as never,
      }),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(result.replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("abort path (mid-stream)", async () => {
    const controller = new AbortController();
    const sendDeferred = createDeferred<SessionEventShape | undefined>();
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockReturnValue(sendDeferred.promise);
        session.abort.mockImplementationOnce(async () => {
          sendDeferred.resolve(undefined);
        });
      },
    });
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const runPromise = runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      createToolBridge,
      pool,
    });
    await flushAsync();

    controller.abort();
    const result = await runPromise;

    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
  });

  it("abort path (signal already aborted)", async () => {
    const controller = new AbortController();
    controller.abort();
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });

    expect(result.aborted).toBe(true);
    expect(result.externalAbort).toBe(true);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.acquire).toHaveBeenCalledTimes(0);
  });

  it("abort path (signal fires after settled)", async () => {
    const controller = new AbortController();
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams({ abortSignal: controller.signal }), {
      pool,
    });
    controller.abort();

    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("tool bridge wiring: injected tools populate session config", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const sdkTools: SdkTool[] = [
      {
        description: "Fake SDK tool",
        handler: async () => ({ resultType: "success", textResultForLlm: "ok" }),
        name: "fake_sdk_tool",
        parameters: { type: "object" },
      },
    ];
    const createToolBridge = vi.fn(async () => ({ sdkTools, sourceTools: [] }));

    await runCopilotSdkAttempt(makeParams(), { createToolBridge, pool });

    expect(createToolBridge).toHaveBeenCalledTimes(1);
    expect(createToolBridge).toHaveBeenCalledWith({
      abortSignal: undefined,
      agentDir: "C:\\copilot-home",
      agentId: "agent-1",
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
      sessionKey: undefined,
      workspaceDir: "C:\\workspace",
    });
    expect((sdk.createSession.mock.calls[0]?.[0] as { tools?: unknown[] }).tools).toBe(sdkTools);
  });

  it("tool bridge failures become prompt errors", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => {
      throw new Error("bridge failed");
    });

    const result = await runCopilotSdkAttempt(makeParams(), { createToolBridge, pool });

    expect(getPromptErrorCode(result)).toBe("tool_bridge_failure");
    expect((result.promptError as Error | undefined)?.message).toBe(
      "[copilot-sdk-attempt] tool-bridge construction failed: bridge failed",
    );
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.acquire).toHaveBeenCalledTimes(0);
    expect(pool.release).toHaveBeenCalledTimes(0);
  });

  it("unsupported providers skip injected tool bridge wiring", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const createToolBridge = vi.fn(async () => ({ sdkTools: [], sourceTools: [] }));

    const result = await runCopilotSdkAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
      }),
      { createToolBridge, pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(createToolBridge).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("default permission policy rejects fail-closed", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const handler = (
      sdk.createSession.mock.calls[0]?.[0] as {
        onPermissionRequest: (
          request: { kind: string },
          invocation: { sessionId: string },
        ) => Promise<{ kind: string; feedback?: string }>;
      }
    ).onPermissionRequest;
    const result = await handler({ kind: "write" }, { sessionId: "sess-1" });
    expect(result.kind).toBe("reject");
    expect(result.feedback).toContain("no permission policy installed");
  });

  it("default user-input policy returns synthetic deny-all answer", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const handler = (
      sdk.createSession.mock.calls[0]?.[0] as {
        onUserInputRequest: (
          request: { question: string },
          invocation: { sessionId: string },
        ) => Promise<{ answer: string; wasFreeform: boolean }>;
      }
    ).onUserInputRequest;
    const response = await handler({ question: "name?" }, { sessionId: "sess-1" });
    expect(response.wasFreeform).toBe(true);
    expect(response.answer).toContain("no user-input policy installed");
  });

  it("enableSessionTelemetry is omitted from createSession when undefined (SDK default)", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("enableSessionTelemetry" in cfg).toBe(false);
  });

  it("enableSessionTelemetry: true is propagated to createSession", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams({ enableSessionTelemetry: true } as never), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0] as { enableSessionTelemetry?: boolean };
    expect(cfg.enableSessionTelemetry).toBe(true);
  });

  it("enableSessionTelemetry: false is propagated to createSession", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams({ enableSessionTelemetry: false } as never), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0] as { enableSessionTelemetry?: boolean };
    expect(cfg.enableSessionTelemetry).toBe(false);
  });

  it("enableSessionTelemetry is propagated to resumeSession on resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({
        enableSessionTelemetry: false,
        initialReplayState: { sdkSessionId: "resume-2" },
      } as never),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    const cfg = sdk.resumeSession.mock.calls[0]?.[1] as { enableSessionTelemetry?: boolean };
    expect(cfg.enableSessionTelemetry).toBe(false);
  });

  it("infiniteSessions is omitted from createSession when host did not supply config", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const cfg = sdk.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("infiniteSessions" in cfg).toBe(false);
  });

  it("infiniteSessions config is propagated to createSession when host supplies it", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({
        infiniteSessionConfig: {
          enabled: true,
          backgroundCompactionThreshold: 0.7,
          bufferExhaustionThreshold: 0.9,
        },
      } as never),
      { pool },
    );

    const cfg = sdk.createSession.mock.calls[0]?.[0] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({
      enabled: true,
      backgroundCompactionThreshold: 0.7,
      bufferExhaustionThreshold: 0.9,
    });
  });

  it("infiniteSessions enabled:false explicitly disables infinite sessions", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams({ infiniteSessionConfig: { enabled: false } } as never), {
      pool,
    });

    const cfg = sdk.createSession.mock.calls[0]?.[0] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({ enabled: false });
  });

  it("infiniteSessions is propagated to resumeSession on resume path", async () => {
    const sdk = makeFakeSdk({
      onResumeSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("resumed"));
      },
    });
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({
        infiniteSessionConfig: { backgroundCompactionThreshold: 0.5 },
        initialReplayState: { sdkSessionId: "resume-3" },
      } as never),
      { pool },
    );

    expect(sdk.resumeSession).toHaveBeenCalledTimes(1);
    const cfg = sdk.resumeSession.mock.calls[0]?.[1] as {
      infiniteSessions?: Record<string, unknown>;
    };
    expect(cfg.infiniteSessions).toEqual({ backgroundCompactionThreshold: 0.5 });
  });

  it("timeout", async () => {
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockResolvedValueOnce(undefined);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(getSdkSessionId(result)).toBe("sess-1");
    expect(sdk.sessions[0]?.abort).toHaveBeenCalledTimes(0);
  });

  it("model translation: unsupported provider", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({
        model: { api: "openai-responses", id: "claude", provider: "anthropic" } as never,
      }),
      { pool },
    );

    expect(getPromptErrorCode(result)).toBe("model_not_supported");
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.acquire).toHaveBeenCalledTimes(0);
    expect(pool.release).toHaveBeenCalledTimes(0);
  });

  it("acquire failure", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    const error = new Error("acquire failed");
    pool.acquire = vi.fn(async () => {
      throw error;
    });

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(result.promptError).toBe(error);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
    expect(pool.release).toHaveBeenCalledTimes(0);
  });

  it("release failure after a successful send rejects the attempt", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);
    pool.release = vi.fn(async () => {
      throw "release failed";
    });

    await expect(runCopilotSdkAttempt(makeParams(), { pool })).rejects.toThrow("release failed");

    expect(sdk.sessions[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("release failure after a primary prompt error warns without masking the error", async () => {
    const primaryError = new Error("send failed");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(primaryError);
      },
    });
    const pool = makeFakePool(sdk);
    pool.release = vi.fn(async () => {
      throw "release failed";
    });

    const result = await runCopilotSdkAttempt(makeParams(), { pool });

    expect(result.promptError).toBe(primaryError);
    expect(warnSpy).toHaveBeenCalledWith(
      "[copilot-sdk-attempt] pool.release failed after primary error",
      expect.objectContaining({ message: "release failed" }),
    );
  });

  it("accepts string model ids and falls back to top-level provider metadata", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(
      makeParams({ model: "gpt-4.1" as never, provider: "github-copilot" } as never),
      { now: () => 123, pool },
    );

    expect(getPromptErrorCode(result)).toBeUndefined();
    expect(sdk.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-4.1" }));
    expect(result.currentAttemptAssistant).toEqual(
      expect.objectContaining({ provider: "github-copilot", timestamp: 123 }),
    );
  });

  it("cleanup on success", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(makeParams(), { pool });

    const session = sdk.sessions[0];
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("cleanup on send error", async () => {
    const error = new Error("send failed");
    const sdk = makeFakeSdk({
      onCreateSession: (session) => {
        session.sendAndWait.mockRejectedValueOnce(error);
      },
    });
    const pool = makeFakePool(sdk);

    const result = await runCopilotSdkAttempt(makeParams(), { pool });
    const session = sdk.sessions[0];

    expect(result.promptError).toBe(error);
    expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("cleanup on disconnect throw", async () => {
    const primaryError = new Error("send failed");
    const sdkWithPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockRejectedValueOnce(primaryError);
      },
    });
    const poolWithPrimaryError = makeFakePool(sdkWithPrimaryError);

    const first = await runCopilotSdkAttempt(makeParams(), { pool: poolWithPrimaryError });
    expect(first.promptError).toBe(primaryError);

    const sdkWithoutPrimaryError = makeFakeSdk({
      onCreateSession: (session) => {
        session.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
        session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
      },
    });
    const poolWithoutPrimaryError = makeFakePool(sdkWithoutPrimaryError);

    const second = await runCopilotSdkAttempt(makeParams(), { pool: poolWithoutPrimaryError });
    expect((second.promptError as Error | undefined)?.message).toBe("disconnect failed");
  });

  it("pool keying: useLoggedInUser", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({ auth: { gitHubToken: "ignored", useLoggedInUser: true } as never }),
      { pool },
    );

    const key = pool.acquire.mock.calls[0]?.[0] as { authMode: string };
    const options = pool.acquire.mock.calls[0]?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("useLoggedInUser");
    expect(options.useLoggedInUser).toBe(true);
    expect(options.gitHubToken).toBeUndefined();
  });

  it("pool keying: gitHubToken requires profileId+profileVersion", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await expect(
      runCopilotSdkAttempt(makeParams({ auth: { gitHubToken: "token" } as never }), { pool }),
    ).rejects.toThrow(
      "[copilot-sdk-attempt] gitHubToken auth requires profileId+profileVersion (pool keying safety; per Q5/Q1 decisions)",
    );
    expect(pool.acquire).toHaveBeenCalledTimes(0);
    expect(sdk.createSession).toHaveBeenCalledTimes(0);
  });

  it("pool keying: gitHubToken with profile", async () => {
    const sdk = makeFakeSdk();
    const pool = makeFakePool(sdk);

    await runCopilotSdkAttempt(
      makeParams({
        auth: { gitHubToken: "token", profileId: "profile-1", profileVersion: "v1" } as never,
      }),
      { pool },
    );

    const key = pool.acquire.mock.calls[0]?.[0] as {
      authMode: string;
      authProfileId?: string;
      authProfileVersion?: string;
    };
    const options = pool.acquire.mock.calls[0]?.[1] as {
      gitHubToken?: string;
      useLoggedInUser?: boolean;
    };
    expect(key.authMode).toBe("gitHubToken");
    expect(key.authProfileId).toBe("profile-1");
    expect(key.authProfileVersion).toBe("v1");
    expect(options.gitHubToken).toBe("token");
    expect(options.useLoggedInUser).toBe(false);
  });

  describe("dual-write transcript mirror", () => {
    afterEach(() => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockResolvedValue(undefined);
    });

    it("invokes dual-write mirror with sessionFile and scoped idempotencyScope when sessionFile is set", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotSdkAttempt(makeParams(), { pool });

      expect(dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort).toHaveBeenCalledTimes(1);
      const args = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls[0]?.[0] as {
        sessionFile: string;
        messages: Array<{ role: string }>;
        idempotencyScope?: string;
      };
      expect(args.sessionFile).toBe("session.json");
      expect(args.idempotencyScope).toMatch(/^copilot-sdk:/u);
      expect(args.messages.length).toBeGreaterThan(0);
      const roles = args.messages.map((m) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });

    it("does not invoke dual-write mirror when sessionFile is absent", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams() as unknown as Record<string, unknown>;
      delete params.sessionFile;

      await runCopilotSdkAttempt(params as never, { pool });

      expect(dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort).not.toHaveBeenCalled();
    });

    it("tags mirrored messages with copilot-sdk mirror identity per role and position", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotSdkAttempt(makeParams(), { pool });

      const args = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
      };
      for (const [index, message] of args.messages.entries()) {
        if (
          message.role !== "user" &&
          message.role !== "assistant" &&
          message.role !== "toolResult"
        ) {
          continue;
        }
        const identity = message.__openclaw?.mirrorIdentity ?? "";
        // The terminal assistant carries the turn-stable
        // `${runId}:assistant:final` identity attached by attempt.ts
        // (rubber-duck-validated identity scheme — survives SDK session
        // reuse across turns). Caller-passed history without an
        // identity falls through to the positional `${scope}:role:idx`
        // fingerprint that the existing tagging map applies.
        if (message.role === "assistant" && index === args.messages.length - 1) {
          expect(identity).toMatch(/:assistant:final$/u);
          expect(identity).toContain("run-1");
        } else {
          expect(identity).toMatch(new RegExp(`:${message.role}:${index}$`, "u"));
        }
      }
    });

    it("dual-write failure does not surface from runCopilotSdkAttempt", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockRejectedValueOnce(
        new Error("mirror boom"),
      );
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);

      // dualWriteCopilotSdkTranscriptBestEffort is already best-effort
      // internally; this test asserts attempt.ts also awaits it without
      // letting an unexpected rejection escape.
      await expect(runCopilotSdkAttempt(makeParams(), { pool })).resolves.toBeDefined();
    });

    // ---------------------------------------------------------------
    // Dogfood finding #3: synthetic current-turn user message in the
    // OpenClaw audit transcript (mirrors codex event-projector pattern).
    //
    // Without this synthesis the dashboard / CLI history shows only
    // assistant bubbles — the user's typed turn is lost — because the
    // OpenClaw shell's `persistTextTurnTranscript` skips its own user
    // write when `embeddedAssistantGapFill` is true, trusting the
    // harness to mirror the user turn.
    // ---------------------------------------------------------------
    it("injects synthetic user message with runId:prompt identity when caller passes no history", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams({
        messages: [],
        prompt: "what's my name?",
        runId: "run-A",
      } as never);

      await runCopilotSdkAttempt(params, { pool });

      const args = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{
          role: string;
          content: unknown;
          __openclaw?: { mirrorIdentity?: string };
        }>;
      };
      expect(args.messages.length).toBe(2);
      expect(args.messages[0]?.role).toBe("user");
      expect(args.messages[0]?.content).toBe("what's my name?");
      expect(args.messages[0]?.__openclaw?.mirrorIdentity).toBe("run-A:prompt");
      expect(args.messages[1]?.role).toBe("assistant");
      expect(args.messages[1]?.__openclaw?.mirrorIdentity).toBe("run-A:assistant:final");
    });

    it("does not duplicate synthetic user when caller passed the same prompt as the messages tail", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      // Default makeParams() seeds messages with the same text as
      // prompt, so the synthetic user should be suppressed and the
      // mirrored payload should contain exactly one user entry.
      await runCopilotSdkAttempt(makeParams(), { pool });

      const args = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{ role: string }>;
      };
      const userCount = args.messages.filter((m) => m.role === "user").length;
      expect(userCount).toBe(1);
    });

    it("prefers transcriptPrompt over prompt for the synthetic user body", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("done"));
        },
      });
      const pool = makeFakePool(sdk);
      const params = makeParams({
        messages: [],
        prompt: "EXPANDED: please answer with your real name",
        transcriptPrompt: "what's your name?",
        runId: "run-B",
      } as never);

      await runCopilotSdkAttempt(params, { pool });

      const args = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const user = args.messages.find((m) => m.role === "user");
      expect(user?.content).toBe("what's your name?");
    });

    it("two attempts that share the same sdkSessionId but differ by runId produce distinct user/assistant mirror identities", async () => {
      // Simulates session reuse (Fix B): the SDK keeps `sess-1` across
      // both turns, so a session-relative `${sdkSessionId}:user:0`
      // identity would collide and drop the second turn's user message.
      // The runId-stable identity scheme avoids that collision.
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("turn-1-reply"));
        },
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("turn-2-reply"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotSdkAttempt(
        makeParams({
          messages: [],
          prompt: "turn 1",
          runId: "run-1",
        } as never),
        { pool },
      );
      await runCopilotSdkAttempt(
        makeParams({
          messages: [],
          prompt: "turn 2",
          runId: "run-2",
          initialReplayState: { sdkSessionId: "sess-1" },
        } as never),
        { pool },
      );

      const calls = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls;
      expect(calls.length).toBe(2);
      const turn1 = calls[0]?.[0] as {
        messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
      };
      const turn2 = calls[1]?.[0] as {
        messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }>;
      };
      const turn1User = turn1.messages.find((m) => m.role === "user");
      const turn2User = turn2.messages.find((m) => m.role === "user");
      const turn1Assistant = turn1.messages.find((m) => m.role === "assistant");
      const turn2Assistant = turn2.messages.find((m) => m.role === "assistant");
      expect(turn1User?.__openclaw?.mirrorIdentity).toBe("run-1:prompt");
      expect(turn2User?.__openclaw?.mirrorIdentity).toBe("run-2:prompt");
      expect(turn1Assistant?.__openclaw?.mirrorIdentity).toBe("run-1:assistant:final");
      expect(turn2Assistant?.__openclaw?.mirrorIdentity).toBe("run-2:assistant:final");
    });

    it("two attempts with identical prompts but different runIds remain distinct (no content-fingerprint collapse)", async () => {
      dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mockClear();
      const sdk = makeFakeSdk({
        onCreateSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("first"));
        },
        onResumeSession: (session) => {
          session.sendAndWait.mockResolvedValueOnce(makeAssistantMessageEvent("second"));
        },
      });
      const pool = makeFakePool(sdk);

      await runCopilotSdkAttempt(
        makeParams({ messages: [], prompt: "same question", runId: "run-X" } as never),
        { pool },
      );
      await runCopilotSdkAttempt(
        makeParams({
          messages: [],
          prompt: "same question",
          runId: "run-Y",
          initialReplayState: { sdkSessionId: "sess-1" },
        } as never),
        { pool },
      );

      const calls = dualWriteMock.dualWriteCopilotSdkTranscriptBestEffort.mock.calls;
      const id1 = (
        calls[0]?.[0] as { messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }> }
      ).messages.find((m) => m.role === "user")?.__openclaw?.mirrorIdentity;
      const id2 = (
        calls[1]?.[0] as { messages: Array<{ role: string; __openclaw?: { mirrorIdentity?: string } }> }
      ).messages.find((m) => m.role === "user")?.__openclaw?.mirrorIdentity;
      expect(id1).toBe("run-X:prompt");
      expect(id2).toBe("run-Y:prompt");
      expect(id1).not.toBe(id2);
    });
  });
});
