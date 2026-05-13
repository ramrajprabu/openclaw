import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { exportTrajectoryCommand } from "./export-trajectory.js";

const mocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn(),
}));

vi.mock("../config/sessions/store.js", () => ({
  getSessionEntry: mocks.getSessionEntry,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("exportTrajectoryCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionEntry.mockReturnValue(undefined);
  });

  it("points missing session key users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({}, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "--session-key is required. Run openclaw sessions to choose a session.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports malformed encoded request JSON without leaking parser output", async () => {
    const runtime = createRuntime();
    const requestJsonBase64 = Buffer.from("not json", "utf8").toString("base64url");

    await exportTrajectoryCommand({ requestJsonBase64 }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Failed to decode trajectory export request: Encoded trajectory export request is invalid JSON",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("points missing session users at the sessions command", async () => {
    const runtime = createRuntime();

    await exportTrajectoryCommand({ sessionKey: "agent:main:telegram:direct:123" }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      "Session not found: agent:main:telegram:direct:123. Run openclaw sessions to see available sessions.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
