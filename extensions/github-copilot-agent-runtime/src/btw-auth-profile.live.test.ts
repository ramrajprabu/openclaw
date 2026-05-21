import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  AgentHarnessSideQuestionParams,
  AgentHarnessSideQuestionResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { getApiKeyForModel } from "../../../src/agents/model-auth.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { isLiveTestEnabled } from "../../../src/agents/live-test-helpers.js";
import {
  createGithubCopilotAgentHarness,
  type CopilotClientPool,
} from "../harness.js";
import type {
  ClientCreateOptions,
  PoolKey,
  PooledClient,
} from "./runtime.js";

// Live e2e validation for the round-5 G2 fix: when the host has a
// configured `github-copilot` auth profile, headless `/btw` must
// resolve that profile's token via `getApiKeyForModel` and forward
// it through `AgentHarnessSideQuestionParams.resolvedApiKey` into
// the SDK session as `gitHubToken`, so the throwaway side-question
// runs under the same GitHub identity as the main attempt.
//
// The existing live smoke (`attempt.live.test.ts`) only exercises
// the explicit-token branch (`auth: { gitHubToken, profileId,
// profileVersion }`) on the main attempt; the auth-profile +
// side-question chain that the round-5 review flagged was never
// exercised live. This test fills that gap by:
//
//   1. Writing a real `auth-profiles.json` with a token-type profile.
//   2. Calling REAL `getApiKeyForModel` to resolve that profile.
//   3. Building an instrumented `CopilotClientPool` that captures the
//      `PoolKey`, `ClientCreateOptions`, and `SessionConfig` passed
//      into the SDK so the test can assert the auth path actually
//      flowed through `resolvedApiKey` rather than env fallback.
//   4. Calling `harness.runSideQuestion(...)` with `resolvedApiKey`
//      set from step 2, hitting the real Copilot API.
//
// Failure modes this catches that the unit tests cannot:
//   - `getApiKeyForModel` schema / loader regressions for token-type
//     `github-copilot` profiles.
//   - `resolveCopilotAuth` not consuming the contract `resolvedApiKey`
//     field (silently dropping it would have made the env fallback
//     mask the regression — the pool/session-config assertions catch
//     that).
//   - The SDK rejecting the resolved token shape (e.g. needing a
//     different exchange before use).

const LIVE = isLiveTestEnabled(["OPENCLAW_GITHUB_COPILOT_AGENT_LIVE_TEST"]);
const TOKEN =
  process.env.OPENCLAW_GITHUB_COPILOT_AGENT_LIVE_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  "";
const describeLive = LIVE && TOKEN ? describe : describe.skip;

const PROFILE_ID = "github-copilot:live-btw";
const AUTH_STORE_VERSION = 2;

interface AcquireRecord {
  key: PoolKey;
  options: ClientCreateOptions;
}

interface InstrumentedPool extends CopilotClientPool {
  acquired: AcquireRecord[];
  sessionConfigs: unknown[];
}

function createInstrumentedApproveAllPool(): InstrumentedPool {
  const activeClients = new Set<CopilotClient>();
  const acquired: AcquireRecord[] = [];
  const sessionConfigs: unknown[] = [];

  const pool: InstrumentedPool = {
    acquired,
    sessionConfigs,
    async acquire(key: PoolKey, options: ClientCreateOptions): Promise<PooledClient> {
      acquired.push({ key, options });
      const client = new CopilotClient(options);
      activeClients.add(client);
      return {
        key,
        client: {
          createSession: (config: unknown) => {
            sessionConfigs.push(config);
            const merged = { ...(config as object), onPermissionRequest: approveAll };
            return (client as unknown as { createSession: (c: unknown) => unknown })
              .createSession(merged);
          },
          resumeSession: (sessionId: string, config: unknown) => {
            const merged = { ...(config as object), onPermissionRequest: approveAll };
            return (
              client as unknown as {
                resumeSession: (id: string, c: unknown) => unknown;
              }
            ).resumeSession(sessionId, merged);
          },
          stop: () => client.stop(),
        } as unknown as CopilotClient,
      };
    },
    async dispose() {
      const errors: Error[] = [];
      for (const client of activeClients) {
        try {
          errors.push(...(await client.stop()));
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      activeClients.clear();
      return errors;
    },
    async release() {},
    size() {
      return activeClients.size;
    },
  };

  return pool;
}

function buildModel(): Model<Api> {
  return {
    api: "openai-responses",
    id: "gpt-4.1",
    provider: "github-copilot",
  } as unknown as Model<Api>;
}

describeLive("github-copilot agent runtime /btw with real github-copilot auth profile (round-5 G2)", () => {
  it("loads the profile via getApiKeyForModel, forwards resolvedApiKey, and hits Copilot with that token", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "openclaw-github-copilot-btw-auth-"));
    const authProfilesPath = join(agentDir, "auth-profiles.json");
    const pool = createInstrumentedApproveAllPool();
    const harness = createGithubCopilotAgentHarness({ pool });

    try {
      const store = {
        version: AUTH_STORE_VERSION,
        profiles: {
          [PROFILE_ID]: {
            type: "token" as const,
            provider: "github-copilot",
            token: TOKEN,
          },
        },
      };
      await writeFile(authProfilesPath, JSON.stringify(store, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });

      const model = buildModel();
      const cfg: OpenClawConfig = {} as OpenClawConfig;

      // ---- Step 1: real auth-profile lookup via openclaw core ----
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg,
        profileId: PROFILE_ID,
        agentDir,
        workspaceDir: process.cwd(),
      });
      expect(apiKeyInfo.apiKey).toBe(TOKEN);
      expect(apiKeyInfo.profileId).toBe(PROFILE_ID);
      expect(apiKeyInfo.mode).toBe("token");

      // ---- Step 2: side-question call with resolvedApiKey populated ----
      const now = Date.now();
      const sideParams: AgentHarnessSideQuestionParams = {
        cfg,
        agentDir,
        provider: "github-copilot",
        model: "gpt-4.1",
        runtimeModel: model,
        question: "Respond with exactly the single lowercase word: live",
        sessionEntry: {} as never,
        resolvedReasoningLevel: "off",
        isNewSession: false,
        sessionId: `btw-auth-live-${now}`,
        sessionFile: `btw-auth-live-${now}.session.json`,
        agentId: "github-copilot-btw-auth-live",
        workspaceDir: process.cwd(),
        authProfileId: PROFILE_ID,
        resolvedApiKey: apiKeyInfo.apiKey,
      };

      const result: AgentHarnessSideQuestionResult = await harness.runSideQuestion!(
        sideParams,
      );

      // ---- Step 3: response shape sanity ----
      expect(result.text.trim().length).toBeGreaterThan(0);
      expect(result.text.toLowerCase()).toContain("live");

      // ---- Step 4: prove the auth path actually went through
      // resolvedApiKey, not env fallback. PoolKey records the
      // resolved auth identity; ClientCreateOptions and SessionConfig
      // both carry the token bytes. If any one of these is wrong the
      // env fallback masked the regression. ----
      expect(pool.acquired.length).toBeGreaterThanOrEqual(1);
      const firstAcquire = pool.acquired[0];
      expect(firstAcquire?.key.authMode).toBe("gitHubToken");
      expect(firstAcquire?.key.authProfileId).toBe(PROFILE_ID);
      expect(firstAcquire?.options.gitHubToken).toBe(TOKEN);

      expect(pool.sessionConfigs.length).toBeGreaterThanOrEqual(1);
      const firstSessionConfig = pool.sessionConfigs[0] as { gitHubToken?: string };
      expect(firstSessionConfig.gitHubToken).toBe(TOKEN);
    } finally {
      await harness.dispose?.();
      await rm(agentDir, { recursive: true, force: true });
    }
  }, 90_000);
});
