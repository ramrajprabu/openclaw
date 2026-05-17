import { beforeEach, describe, expect, it, vitest } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { runAgentAttempt } from "./attempt-execution.js";

const runCliAgentMock = vitest.hoisted(() => vitest.fn());
const runEmbeddedPiAgentMock = vitest.hoisted(() => vitest.fn());

vitest.mock("../cli-runner.js", () => ({
  runCliAgent: runCliAgentMock,
}));

vitest.mock("../pi-embedded.js", () => ({
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
}));

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function firstEmbeddedPiAgentArg() {
  const arg = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
  if (arg === undefined) {
    throw new Error("Expected embedded PI agent argument");
  }
  return requireRecord(arg, "embedded PI agent argument");
}

describe("CLI harness flag attempt plumbing", () => {
  beforeEach(() => {
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
  });

  async function runEmbeddedAttempt(params: {
    harness?: string;
    modelRun?: boolean;
    promptMode?: Parameters<typeof runAgentAttempt>[0]["opts"]["promptMode"];
  }) {
    const sessionEntry: SessionEntry = {
      sessionId: "openclaw-session-harness-flag",
      updatedAt: Date.now(),
    };

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: { durationMs: 1 },
    } satisfies EmbeddedPiRunResult);

    await runAgentAttempt({
      providerOverride: "anthropic",
      originalProvider: "anthropic",
      modelOverride: "claude-opus-4-7",
      cfg: {} as OpenClawConfig,
      sessionEntry,
      sessionId: sessionEntry.sessionId,
      sessionKey: "agent:main:direct:harness-flag",
      sessionAgentId: "main",
      sessionFile: "/dev/null",
      workspaceDir: process.cwd(),
      body: "test harness flag",
      isFallbackRetry: false,
      resolvedThinkLevel: "medium",
      timeoutMs: 1_000,
      runId: "run-harness-flag",
      opts: {
        senderIsOwner: false,
        harness: params.harness,
        modelRun: params.modelRun,
        promptMode: params.promptMode,
      } as Parameters<typeof runAgentAttempt>[0]["opts"],
      runContext: {} as Parameters<typeof runAgentAttempt>[0]["runContext"],
      spawnedBy: undefined,
      messageChannel: undefined,
      skillsSnapshot: undefined,
      resolvedVerboseLevel: undefined,
      agentDir: process.cwd(),
      onAgentEvent: vitest.fn(),
      authProfileProvider: "anthropic",
      sessionHasHistory: false,
    });
  }

  it("forwards a copilot-sdk harness request to embedded attempt execution", async () => {
    await runEmbeddedAttempt({ harness: "copilot-sdk" });

    expect(runCliAgentMock).not.toHaveBeenCalled();
    expect(firstEmbeddedPiAgentArg().agentHarnessId).toBe("copilot-sdk");
  });

  it("trims a harness request before forwarding it", async () => {
    await runEmbeddedAttempt({ harness: "  copilot-sdk  " });

    expect(firstEmbeddedPiAgentArg().agentHarnessId).toBe("copilot-sdk");
  });

  it("treats a blank harness request as unspecified", async () => {
    await runEmbeddedAttempt({ harness: "   " });

    expect(firstEmbeddedPiAgentArg().agentHarnessId).toBeUndefined();
  });

  it("passes unknown harness ids through for the selection layer to reject", async () => {
    await runEmbeddedAttempt({ harness: "third-party-harness" });

    expect(firstEmbeddedPiAgentArg().agentHarnessId).toBe("third-party-harness");
  });

  it("keeps raw model runs pinned to PI even when a harness is requested", async () => {
    await runEmbeddedAttempt({
      harness: "copilot-sdk",
      modelRun: true,
      promptMode: "none",
    });

    const arg = firstEmbeddedPiAgentArg();
    expect(arg.agentHarnessId).toBe("pi");
    expect(arg.modelRun).toBe(true);
    expect(arg.promptMode).toBe("none");
  });
});
