import { describe, expect, it, vi } from "vitest";
import { extractAssistantText, runCopilotSdkSideQuestion } from "./side-question.js";

function makeAssistantMessage(content: string | undefined): any {
  return { type: "assistant.message", data: { content } };
}

function makeDelta(text: string): any {
  return { type: "assistant.message_delta", data: { deltaContent: text } };
}

function makeFakeSession(opts?: {
  sendResult?: any;
  sendError?: unknown;
  emitDeltas?: string[];
  id?: string;
}) {
  let listener: ((event: any) => void) | undefined;
  const session: any = {
    id: opts?.id ?? "sdk-side-1",
    sendAndWait: vi.fn(async () => {
      if (opts?.emitDeltas && listener) {
        for (const delta of opts.emitDeltas) {
          listener(makeDelta(delta));
        }
      }
      if (opts?.sendError) {
        throw opts.sendError;
      }
      return opts && Object.prototype.hasOwnProperty.call(opts, "sendResult")
        ? opts.sendResult
        : makeAssistantMessage("hello world");
    }),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    on: vi.fn((handler: any) => {
      listener = handler;
      return () => {
        listener = undefined;
      };
    }),
  };
  return session;
}

function makeFakeClient(session: any, opts?: { createError?: unknown; deleteError?: unknown }) {
  return {
    createSession: vi.fn(async () => {
      if (opts?.createError) {
        throw opts.createError;
      }
      return session;
    }),
    deleteSession: vi.fn(async () => {
      if (opts?.deleteError) {
        throw opts.deleteError;
      }
    }),
  };
}

function makeFakePool(client: any, opts?: { acquireError?: unknown; releaseError?: unknown }) {
  return {
    acquire: vi.fn(async () => {
      if (opts?.acquireError) {
        throw opts.acquireError;
      }
      return { key: {} as any, client };
    }),
    release: vi.fn(async () => {
      if (opts?.releaseError) {
        throw opts.releaseError;
      }
    }),
    dispose: vi.fn().mockResolvedValue([]),
    size: vi.fn().mockReturnValue(1),
  };
}

function makeParams(overrides: Record<string, unknown> = {}): any {
  return {
    cfg: {},
    agentDir: "/agents",
    provider: "github-copilot",
    model: "gpt-4.1",
    question: "what is the capital of france?",
    sessionEntry: {} as any,
    isNewSession: true,
    sessionId: "oc-sess-1",
    sessionFile: "/sessions/oc-sess-1.json",
    workspaceDir: "/ws",
    resolvedReasoningLevel: "medium",
    ...overrides,
  };
}

describe("extractAssistantText", () => {
  it("returns the final assistant message content when present", () => {
    expect(extractAssistantText(makeAssistantMessage("final-text"), "delta")).toBe("final-text");
  });

  it("falls back to accumulated delta text when final content is empty", () => {
    expect(extractAssistantText(makeAssistantMessage(""), "from-deltas")).toBe("from-deltas");
  });

  it("falls back to delta text when final content is missing", () => {
    expect(extractAssistantText(makeAssistantMessage(undefined), "from-deltas")).toBe(
      "from-deltas",
    );
  });

  it("returns empty string when nothing is available", () => {
    expect(extractAssistantText(undefined, "")).toBe("");
  });

  it("ignores non-assistant.message events and uses delta fallback", () => {
    expect(extractAssistantText({ type: "session.start" } as any, "delta-only")).toBe("delta-only");
  });
});

describe("runCopilotSdkSideQuestion", () => {
  it("throws when question is empty or whitespace-only", async () => {
    const pool = makeFakePool(makeFakeClient(makeFakeSession()));
    await expect(
      runCopilotSdkSideQuestion(makeParams({ question: "   " }), { pool: pool as any }),
    ).rejects.toThrow(/question is empty/);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("throws when provider is not supported", async () => {
    const pool = makeFakePool(makeFakeClient(makeFakeSession()));
    await expect(
      runCopilotSdkSideQuestion(makeParams({ provider: "anthropic" }), { pool: pool as any }),
    ).rejects.toThrow(/provider anthropic is not supported/);
    expect(pool.acquire).not.toHaveBeenCalled();
  });

  it("returns extracted assistant text on the happy path", async () => {
    const session = makeFakeSession({ sendResult: makeAssistantMessage("Paris.") });
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    const result = await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any });

    expect(result).toEqual({ text: "Paris." });
    expect(client.createSession).toHaveBeenCalledTimes(1);
    expect(session.sendAndWait).toHaveBeenCalledWith(
      { prompt: "what is the capital of france?" },
      60_000,
    );
  });

  it("forwards a custom timeoutMs from deps", async () => {
    const session = makeFakeSession();
    const pool = makeFakePool(makeFakeClient(session));
    await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any, timeoutMs: 5_000 });
    expect(session.sendAndWait).toHaveBeenCalledWith(expect.any(Object), 5_000);
  });

  it("falls back to streaming deltas when the final event has no content", async () => {
    const session = makeFakeSession({
      sendResult: makeAssistantMessage(""),
      emitDeltas: ["Hello ", "World"],
    });
    const pool = makeFakePool(makeFakeClient(session));

    const result = await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any });
    expect(result.text).toBe("Hello World");
  });

  it("times out, aborts the session, then disconnects and deletes", async () => {
    const session = makeFakeSession({ sendResult: undefined });
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    await expect(
      runCopilotSdkSideQuestion(makeParams(), { pool: pool as any, timeoutMs: 1_000 }),
    ).rejects.toThrow(/timed out after 1000ms/);

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledWith("sdk-side-1");
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("does not call abort on a normal completion", async () => {
    const session = makeFakeSession();
    const pool = makeFakePool(makeFakeClient(session));
    await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any });
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("propagates sendAndWait errors and still disconnects + deletes + releases", async () => {
    const error = new Error("model exploded");
    const session = makeFakeSession({ sendError: error });
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toBe(
      error,
    );

    expect(session.disconnect).toHaveBeenCalledTimes(1);
    expect(client.deleteSession).toHaveBeenCalledTimes(1);
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("does not mask the primary error when disconnect throws", async () => {
    const primary = new Error("model exploded");
    const session = makeFakeSession({ sendError: primary });
    session.disconnect = vi.fn(async () => {
      throw new Error("disconnect failed");
    });
    const pool = makeFakePool(makeFakeClient(session));
    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toBe(
      primary,
    );
  });

  it("does not mask the primary error when deleteSession throws", async () => {
    const primary = new Error("model exploded");
    const session = makeFakeSession({ sendError: primary });
    const client = makeFakeClient(session, { deleteError: new Error("delete failed") });
    const pool = makeFakePool(client);
    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toBe(
      primary,
    );
  });

  it("does not mask the primary error when pool.release throws", async () => {
    const primary = new Error("model exploded");
    const session = makeFakeSession({ sendError: primary });
    const pool = makeFakePool(makeFakeClient(session), {
      releaseError: new Error("release failed"),
    });
    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toBe(
      primary,
    );
  });

  it("propagates createSession failures and still releases the pool handle", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient(session, {});
    client.createSession = vi.fn(async () => {
      throw new Error("createSession failed");
    });
    const pool = makeFakePool(client);

    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toThrow(
      /createSession failed/,
    );

    expect(session.disconnect).not.toHaveBeenCalled();
    expect(client.deleteSession).not.toHaveBeenCalled();
    expect(pool.release).toHaveBeenCalledTimes(1);
  });

  it("propagates pool.acquire failures without creating a session", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient(session);
    const pool = makeFakePool(client, { acquireError: new Error("acquire failed") });

    await expect(runCopilotSdkSideQuestion(makeParams(), { pool: pool as any })).rejects.toThrow(
      /acquire failed/,
    );

    expect(client.createSession).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
  });

  it("uses reject-all permission bridge and does not register onUserInputRequest", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any });

    const cfg = client.createSession.mock.calls[0]?.[0] as {
      tools: unknown[];
      onPermissionRequest: (...args: any[]) => Promise<any>;
    } & Record<string, unknown>;
    expect(cfg.tools).toEqual([]);
    expect(typeof cfg.onPermissionRequest).toBe("function");
    // ask_user is intentionally hidden from the model (matches the
    // primary attempt path). See attempt.ts and
    // docs/plugins/copilot-sdk-harness.md.
    expect("onUserInputRequest" in cfg).toBe(false);

    const permDecision = await cfg.onPermissionRequest(
      {
        toolName: "shell",
        toolInput: {},
        sessionId: "sdk-side-1",
        agentId: "copilot-sdk",
        requestId: "r1",
      } as any,
      { sessionId: "sdk-side-1" } as any,
    );
    // permission-bridge wraps the policy decision in {kind:"reject", feedback}
    expect(permDecision.kind).toBe("reject");
  });

  it("does not pass an SDK reasoningEffort (OpenClaw ReasoningLevel is not aligned)", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    await runCopilotSdkSideQuestion(makeParams({ resolvedReasoningLevel: "on" }), {
      pool: pool as any,
    });

    const cfg = client.createSession.mock.calls[0]?.[0] as { reasoningEffort?: string };
    expect(cfg.reasoningEffort).toBeUndefined();
  });

  it("trims whitespace from the question before sending", async () => {
    const session = makeFakeSession();
    const client = makeFakeClient(session);
    const pool = makeFakePool(client);

    await runCopilotSdkSideQuestion(makeParams({ question: "  hello?  " }), { pool: pool as any });

    expect(session.sendAndWait).toHaveBeenCalledWith({ prompt: "hello?" }, expect.any(Number));
  });

  it("works when session.on is unavailable (no streaming subscription)", async () => {
    const session = makeFakeSession();
    delete (session as any).on;
    const pool = makeFakePool(makeFakeClient(session));
    const result = await runCopilotSdkSideQuestion(makeParams(), { pool: pool as any });
    expect(result.text).toBe("hello world");
  });

  describe("session-level gitHubToken (independent of client-level)", () => {
    // Per the SDK contract (@github/copilot-sdk/dist/types.d.ts:1168-1178),
    // SessionConfig.gitHubToken is independent of the client-level token
    // and determines the identity used for content exclusion, model
    // routing, and quota. The side-question session is throwaway but
    // shares identity with the main attempt, so it must carry the same
    // token when one is resolved.

    it("contract resolvedApiKey populates SessionConfig.gitHubToken", async () => {
      const session = makeFakeSession();
      const client = makeFakeClient(session);
      const pool = makeFakePool(client);

      await runCopilotSdkSideQuestion(
        makeParams({ resolvedApiKey: "btw-contract-token", authProfileId: "github-copilot:main" }),
        { pool: pool as any },
      );

      const cfg = client.createSession.mock.calls[0]?.[0] as { gitHubToken?: string };
      expect(cfg.gitHubToken).toBe("btw-contract-token");
    });

    it("explicit auth.gitHubToken populates SessionConfig.gitHubToken", async () => {
      const session = makeFakeSession();
      const client = makeFakeClient(session);
      const pool = makeFakePool(client);

      await runCopilotSdkSideQuestion(
        makeParams({
          auth: { gitHubToken: "explicit-btw", profileId: "p", profileVersion: "v1" },
        }),
        { pool: pool as any },
      );

      const cfg = client.createSession.mock.calls[0]?.[0] as { gitHubToken?: string };
      expect(cfg.gitHubToken).toBe("explicit-btw");
    });

    it("SessionConfig.gitHubToken is omitted in useLoggedInUser mode", async () => {
      const session = makeFakeSession();
      const client = makeFakeClient(session);
      const pool = makeFakePool(client);

      await runCopilotSdkSideQuestion(
        makeParams({ auth: { useLoggedInUser: true } }),
        { pool: pool as any },
      );

      const cfg = client.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
      expect("gitHubToken" in cfg).toBe(false);
    });
  });
});
