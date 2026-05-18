import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotClientPool } from "./harness.js";
import { createCopilotSdkAgentHarness } from "./harness.js";

const mocks = vi.hoisted(() => ({
  runCopilotSdkAttempt: vi.fn(),
  createCopilotClientPool: vi.fn(),
}));

vi.mock("./src/attempt.js", () => ({
  runCopilotSdkAttempt: mocks.runCopilotSdkAttempt,
}));

vi.mock("./src/runtime.js", () => ({
  createCopilotClientPool: mocks.createCopilotClientPool,
}));

const ATTEMPT_PARAMS = { provider: "github", model: "gpt-4.1" } as any;
const ATTEMPT_RESULT = { ok: true } as any;

function makePoolMock(): CopilotClientPool {
  return {
    acquire: vi.fn(),
    release: vi.fn(),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(0),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createCopilotSdkAgentHarness", () => {
  beforeEach(() => {
    mocks.runCopilotSdkAttempt.mockReset();
    mocks.createCopilotClientPool.mockReset();
    mocks.runCopilotSdkAttempt.mockResolvedValue(ATTEMPT_RESULT);
    mocks.createCopilotClientPool.mockImplementation(() => makePoolMock());
  });

  it("returns the copilot-sdk id and default label", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(harness.id).toBe("copilot-sdk");
    expect(harness.label).toBe("GitHub Copilot SDK");
  });

  it("accepts custom id and label from options", () => {
    const harness = createCopilotSdkAgentHarness({ id: "sdk", label: "SDK Harness" });

    expect(harness.id).toBe("sdk");
    expect(harness.label).toBe("SDK Harness");
  });

  it("supports returns false in auto runtime even for github provider", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({ provider: "github", modelId: "gpt-4.1", requestedRuntime: "auto" }),
    ).toEqual({
      supported: false,
      reason: "copilot-sdk is opt-in only",
    });
  });

  it("supports returns false in pi runtime", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({ provider: "github", modelId: "gpt-4.1", requestedRuntime: "pi" }),
    ).toEqual({
      supported: false,
      reason: "copilot-sdk is opt-in only",
    });
  });

  it("supports returns true for requestedRuntime copilot-sdk with github provider", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({
        provider: "github",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports returns true for openclaw and copilot providers", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({
        provider: "openclaw",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({ supported: true, priority: 100 });
    expect(
      harness.supports({
        provider: "copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes provider casing and whitespace", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({
        provider: "  GitHub  ",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports normalizes requestedRuntime casing", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({
        provider: "github",
        modelId: "gpt-4.1",
        requestedRuntime: "  COPILOT-SDK  " as any,
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it("supports rejects providers outside the whitelist", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(
      harness.supports({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({
      supported: false,
      reason: "provider is not one of: copilot, github, openclaw",
    });
  });

  it("supports accepts custom providerIds from options", () => {
    const harness = createCopilotSdkAgentHarness({ providerIds: [" Anthropic ", "OpenAI"] });

    expect(
      harness.supports({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({ supported: true, priority: 100 });
    expect(
      harness.supports({
        provider: "github",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot-sdk",
      }),
    ).toEqual({
      supported: false,
      reason: "provider is not one of: anthropic, openai",
    });
  });

  it("runAttempt lazy-imports attempt by waiting until invocation to create a pool", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotSdkAgentHarness();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotSdkAttempt).not.toHaveBeenCalled();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotSdkAttempt).toHaveBeenCalledTimes(1);
  });

  it("runAttempt creates one pool lazily and reuses it across two attempts on the same harness", async () => {
    const pool = makePoolMock();
    const firstResult = { attempt: 1 } as any;
    const secondResult = { attempt: 2 } as any;
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotSdkAttempt
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(secondResult);
    const harness = createCopilotSdkAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotSdkAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
    expect(mocks.runCopilotSdkAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  it("multiple harness instances create independent pools", async () => {
    const poolOne = makePoolMock();
    const poolTwo = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValueOnce(poolOne).mockReturnValueOnce(poolTwo);
    const firstHarness = createCopilotSdkAgentHarness();
    const secondHarness = createCopilotSdkAgentHarness();

    await expect(firstHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);
    await expect(secondHarness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(2);
    expect(mocks.runCopilotSdkAttempt).toHaveBeenNthCalledWith(
      1,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolOne }),
    );
    expect(mocks.runCopilotSdkAttempt).toHaveBeenNthCalledWith(
      2,
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool: poolTwo }),
    );
  });

  it("runAttempt does not serialize concurrent attempts", async () => {
    const pool = makePoolMock();
    const firstResult = { attempt: 1 } as any;
    const secondResult = { attempt: 2 } as any;
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotSdkAttempt
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(secondResult);
    const harness = createCopilotSdkAgentHarness();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(firstResult);
    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(secondResult);

    expect(mocks.createCopilotClientPool).toHaveBeenCalledTimes(1);
    expect(mocks.runCopilotSdkAttempt).toHaveBeenCalledTimes(2);
  });

  it("dispose before first runAttempt does not create a pool", async () => {
    const harness = createCopilotSdkAgentHarness();

    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose after pool creation calls pool.dispose once even when called twice", async () => {
    const pool = makePoolMock();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotSdkAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    const firstDispose = harness.dispose?.();
    const secondDispose = harness.dispose?.();

    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose waits for in-flight runAttempt before disposing", async () => {
    const pool = makePoolMock();
    const deferred = createDeferred<any>();
    mocks.createCopilotClientPool.mockReturnValue(pool);
    mocks.runCopilotSdkAttempt.mockImplementation(() => deferred.promise);
    const harness = createCopilotSdkAgentHarness();

    const attemptPromise = harness.runAttempt(ATTEMPT_PARAMS);
    await flushAsyncWork();

    const disposePromise = harness.dispose?.();
    let disposeSettled = false;
    void disposePromise?.then(() => {
      disposeSettled = true;
    });

    await flushAsyncWork();

    expect(pool.dispose).not.toHaveBeenCalled();
    expect(disposeSettled).toBe(false);

    deferred.resolve(ATTEMPT_RESULT);

    await expect(attemptPromise).resolves.toBe(ATTEMPT_RESULT);
    await expect(disposePromise).resolves.toBeUndefined();
    expect(pool.dispose).toHaveBeenCalledTimes(1);
  });

  it("runAttempt after dispose rejects without creating a new pool", async () => {
    const harness = createCopilotSdkAgentHarness();

    await harness.dispose?.();

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).rejects.toThrow(
      "[copilot-sdk] harness has been disposed; cannot start new attempts",
    );
    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
  });

  it("dispose surfaces pool.dispose errors as AggregateError", async () => {
    const pool = makePoolMock();
    const errors = [new Error("first"), new Error("second")];
    pool.dispose = vi.fn().mockResolvedValue(errors);
    mocks.createCopilotClientPool.mockReturnValue(pool);
    const harness = createCopilotSdkAgentHarness();

    await harness.runAttempt(ATTEMPT_PARAMS);

    try {
      await harness.dispose?.();
      throw new Error("expected dispose to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe("[copilot-sdk] pool disposal errors");
      expect((error as AggregateError).errors).toEqual(errors);
    }
  });

  it("dispose does not dispose a caller-supplied pool", async () => {
    const pool = makePoolMock();
    const harness = createCopilotSdkAgentHarness({ pool });

    await harness.runAttempt(ATTEMPT_PARAMS);
    await expect(harness.dispose?.()).resolves.toBeUndefined();

    expect(pool.dispose).not.toHaveBeenCalled();
  });

  it("uses options.pool when supplied", async () => {
    const pool = makePoolMock();
    const harness = createCopilotSdkAgentHarness({ pool });

    await expect(harness.runAttempt(ATTEMPT_PARAMS)).resolves.toBe(ATTEMPT_RESULT);

    expect(mocks.createCopilotClientPool).not.toHaveBeenCalled();
    expect(mocks.runCopilotSdkAttempt).toHaveBeenCalledWith(
      ATTEMPT_PARAMS,
      expect.objectContaining({ pool }),
    );
  });

  describe("reset", () => {
    it("is a no-op when params.sessionId is missing", async () => {
      const pool = makePoolMock();
      const harness = createCopilotSdkAgentHarness({ pool });

      await expect(harness.reset?.({})).resolves.toBeUndefined();
    });

    it("is a no-op when the session was never tracked", async () => {
      const pool = makePoolMock();
      const harness = createCopilotSdkAgentHarness({ pool });

      await expect(harness.reset?.({ sessionId: "unknown" })).resolves.toBeUndefined();
    });

    it("calls deleteSession on the client that created the session", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotSdkAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-123",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotSdkAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-1" } as any);
      await harness.reset?.({ sessionId: "oc-sess-1" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
      expect(deleteSession).toHaveBeenCalledWith("sdk-sess-123");
    });

    it("does not call deleteSession when no sdkSessionId was reported", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      mocks.runCopilotSdkAttempt.mockImplementation(async (_params, _deps) => ATTEMPT_RESULT);
      const harness = createCopilotSdkAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-2" } as any);
      await harness.reset?.({ sessionId: "oc-sess-2" });

      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by client.deleteSession", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockRejectedValue(new Error("session not found"));
      const client = { deleteSession } as any;
      mocks.runCopilotSdkAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-err",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotSdkAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-3" } as any);

      await expect(harness.reset?.({ sessionId: "oc-sess-3" })).resolves.toBeUndefined();
      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("forgets the session after reset; a second reset is a no-op", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotSdkAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-x",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotSdkAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-sess-4" } as any);
      await harness.reset?.({ sessionId: "oc-sess-4" });
      await harness.reset?.({ sessionId: "oc-sess-4" });

      expect(deleteSession).toHaveBeenCalledTimes(1);
    });

    it("does not invoke deleteSession for a session belonging to a different openclawSessionId", async () => {
      const pool = makePoolMock();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const client = { deleteSession } as any;
      mocks.runCopilotSdkAttempt.mockImplementation(async (params, deps) => {
        deps.onSessionEstablished?.({
          sdkSessionId: "sdk-sess-y",
          pooledClient: { key: {} as any, client },
        });
        return ATTEMPT_RESULT;
      });
      const harness = createCopilotSdkAgentHarness({ pool });

      await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-A" } as any);
      await harness.reset?.({ sessionId: "oc-B" });

      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  it("dispose clears tracked sessions so subsequent reset is a no-op", async () => {
    const pool = makePoolMock();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const client = { deleteSession } as any;
    mocks.runCopilotSdkAttempt.mockImplementation(async (params, deps) => {
      deps.onSessionEstablished?.({
        sdkSessionId: "sdk-sess-d",
        pooledClient: { key: {} as any, client },
      });
      return ATTEMPT_RESULT;
    });
    const harness = createCopilotSdkAgentHarness({ pool });

    await harness.runAttempt({ ...ATTEMPT_PARAMS, sessionId: "oc-disp" } as any);
    await harness.dispose?.();
    await harness.reset?.({ sessionId: "oc-disp" });

    expect(deleteSession).not.toHaveBeenCalled();
  });
});
