/**
 * BYOK provider-mapping registry for the copilot-sdk harness.
 *
 * At MVP no adapters are registered (per proposal Q2). The registry
 * exists so that:
 *   1. A future PR can land one BYOK adapter (e.g. Azure-OpenAI,
 *      Ollama) without touching attempt.ts again — it just calls
 *      `registerCopilotSdkProviderMapping(adapter)`.
 *   2. The harness's `supports()` gate (extensions/copilot-sdk/
 *      harness.ts) can extend its provider allow-list with the
 *      registered BYOK provider ids by consulting
 *      `supportsCopilotSdkByokProvider(providerId)`.
 *   3. `attempt.ts` can call `resolveCopilotSdkProviderConfig(ctx)`
 *      to materialize an SDK `ProviderConfig` from a host context.
 *
 * Registry semantics:
 *   - One mapping per `providerId` (case-insensitive). Re-registering
 *     the same `providerId` throws — that is always a programmer
 *     error (two adapters fighting for the same provider). Callers
 *     that need to swap an adapter should call
 *     `__unregisterCopilotSdkProviderMappingForTests(providerId)`
 *     first; that helper is test-only.
 *   - Lookup is case-insensitive but the registry preserves the
 *     adapter's declared `providerId` casing for diagnostics.
 *
 * Thread-model: module-singleton. The registry is process-global by
 * design so a host-side `register*` call in app startup is visible to
 * every `runCopilotSdkAttempt` invocation in the process.
 */

import type { ProviderConfig as SdkProviderConfig } from "@github/copilot-sdk";
import type { CopilotSdkProviderMapping, CopilotSdkProviderMappingContext } from "./types.js";

export type { CopilotSdkProviderMapping, CopilotSdkProviderMappingContext } from "./types.js";

const registry = new Map<string, CopilotSdkProviderMapping>();

function normalizeProviderId(providerId: string): string {
  return providerId.trim().toLowerCase();
}

/**
 * Register a BYOK adapter. Re-registering the same providerId throws
 * (programmer error). Returns the registered mapping for chaining.
 */
export function registerCopilotSdkProviderMapping(
  mapping: CopilotSdkProviderMapping,
): CopilotSdkProviderMapping {
  const key = normalizeProviderId(mapping.providerId);
  if (!key) {
    throw new Error("[copilot-sdk:provider-mapping] providerId must be a non-empty string");
  }
  if (registry.has(key)) {
    const existing = registry.get(key);
    throw new Error(
      `[copilot-sdk:provider-mapping] provider "${mapping.providerId}" is already registered` +
        (existing?.label ? ` (existing label: ${existing.label})` : ""),
    );
  }
  registry.set(key, mapping);
  return mapping;
}

/**
 * Look up a registered BYOK adapter by providerId. Case-insensitive.
 * Returns `undefined` when no adapter is registered for that provider.
 */
export function getCopilotSdkProviderMapping(
  providerId: string,
): CopilotSdkProviderMapping | undefined {
  if (typeof providerId !== "string" || providerId.trim() === "") {
    return undefined;
  }
  return registry.get(normalizeProviderId(providerId));
}

/**
 * True when a BYOK adapter is registered for `providerId`. Used by
 * the harness's `supports()` gate to extend the allow-list beyond
 * the subscription-Copilot provider trio.
 */
export function supportsCopilotSdkByokProvider(providerId: string): boolean {
  return getCopilotSdkProviderMapping(providerId) !== undefined;
}

/**
 * Materialize an SDK `ProviderConfig` from a resolution context using
 * the registered adapter. Returns `undefined` when no adapter is
 * registered or the adapter cannot serve the request. Adapter
 * exceptions are intentionally NOT swallowed — they indicate
 * programmer errors (e.g. malformed adapter implementation) and
 * should surface so the host can diagnose.
 */
export function resolveCopilotSdkProviderConfig(
  ctx: CopilotSdkProviderMappingContext,
): SdkProviderConfig | undefined {
  const mapping = getCopilotSdkProviderMapping(ctx.providerId);
  if (!mapping) {
    return undefined;
  }
  return mapping.buildProviderConfig(ctx);
}

/**
 * Snapshot of registered provider ids (preserving declared casing).
 * Useful for diagnostics, doctor hooks, and the rare host that needs
 * to enumerate registered adapters for logging.
 */
export function listRegisteredCopilotSdkProviderIds(): string[] {
  return Array.from(registry.values()).map((m) => m.providerId);
}

/**
 * Test-only: remove a single adapter from the registry. Production
 * code must NOT call this — adapter registration is meant to be
 * append-only at startup. Reserved-name prefix `__` and explicit
 * `ForTests` suffix to discourage misuse.
 */
export function __unregisterCopilotSdkProviderMappingForTests(providerId: string): boolean {
  return registry.delete(normalizeProviderId(providerId));
}

/**
 * Test-only: clear all adapters. See
 * {@link __unregisterCopilotSdkProviderMappingForTests} for rationale.
 */
export function __clearCopilotSdkProviderMappingRegistryForTests(): void {
  registry.clear();
}
