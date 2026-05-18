/**
 * Doctor contract for the copilot-sdk extension.
 *
 * Mirrors {@link ../codex/doctor-contract-api.ts} so `openclaw doctor`
 * can:
 *   - Reason about which session-state belongs to this extension
 *     (sessionRouteStateOwners) for cleanup of stale state across
 *     runtime swaps.
 *   - Detect retired config fields and migrate them
 *     (legacyConfigRules + normalizeCompatibilityConfig). No retired
 *     fields exist for copilot-sdk yet; the array is empty by design
 *     and normalizeCompatibilityConfig is a structural no-op so
 *     future retirements have a stable in-tree home.
 *
 * The deeper runtime probes (copilot CLI version, copilot auth,
 * copilotHome writability) live in {@link ./src/doctor-probes.ts}
 * because they have side effects (subprocess spawn, fs touch) and
 * need to be invoked imperatively, not declaratively, from the
 * doctor command. They are exported separately so callers can opt
 * in. Auto-discovery of doctor-contract-api.ts at the plugin root
 * keeps this file purely declarative.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[] = [];

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return { config: cfg, changes: [] };
}

/**
 * Session-state ownership claim for the copilot-sdk harness.
 *
 * - id / label: Identify the extension in doctor output.
 * - providerIds: The subscription Copilot providers (kept in sync
 *   with `SUPPORTED_PROVIDERS` in attempt.ts). BYOK provider ids
 *   that get registered via `provider-mapping/` are NOT listed here;
 *   they belong to whichever extension registered them.
 * - runtimeIds: Our harness id (matches harness.ts `id` field).
 * - cliSessionKeys: Session keys this harness writes; doctor uses
 *   this when pruning stale CLI session state.
 * - authProfilePrefixes: Conventional prefix for any auth profile
 *   created/consumed by this extension.
 */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "copilot-sdk",
    label: "GitHub Copilot SDK",
    providerIds: ["github", "openclaw", "copilot"],
    runtimeIds: ["copilot-sdk"],
    cliSessionKeys: ["copilot-sdk"],
    authProfilePrefixes: ["copilot-sdk:"],
  },
];
