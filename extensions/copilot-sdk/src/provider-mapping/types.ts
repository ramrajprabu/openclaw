/**
 * Public types for the BYOK provider-mapping framework.
 *
 * The copilot-sdk harness ships with `supports(ctx) === false` for any
 * provider that is not in the subscription-Copilot allow-list
 * (`github`, `openclaw`, `copilot` — see attempt.ts SUPPORTED_PROVIDERS).
 * This is intentional at MVP per the proposal's Q2 decision: BYOK
 * adapters land on-demand, not as a fan-out.
 *
 * When a BYOK adapter is added, it should:
 *   1. Implement {@link CopilotSdkProviderMapping}.
 *   2. Register itself with `registerCopilotSdkProviderMapping`
 *      in its own module-init code (or be wired by the harness host).
 *   3. Be reachable by `getCopilotSdkProviderMapping` via its
 *      `providerId` (case-insensitive match).
 *
 * The mapping is what would let the harness produce a SDK
 * `ProviderConfig` from a provider-agnostic auth/resolved-model
 * context, so that `attempt.ts` can pass `provider` through to
 * `client.createSession`. Until at least one mapping is registered,
 * `supportsCopilotSdkByokProvider` returns false for everything and
 * the harness keeps falling through to the existing PI extensions
 * (anthropic, amazon-bedrock, etc.) for any non-subscription model.
 */

import type { ProviderConfig as SdkProviderConfig } from "@github/copilot-sdk";

/**
 * Resolution context passed to a BYOK adapter when the harness asks
 * it to materialize an SDK `ProviderConfig`. Intentionally minimal at
 * MVP; widen on real adapter need rather than speculation.
 */
export interface CopilotSdkProviderMappingContext {
  /** Resolved model id (post-fallback). */
  modelId: string;
  /** Resolved provider id (case-insensitive match against mapping). */
  providerId: string;
  /** Optional API endpoint override from the host config. */
  baseUrl?: string;
  /** Optional API key from a configured auth profile. */
  apiKey?: string;
  /** Optional bearer token from a configured auth profile. */
  bearerToken?: string;
  /** Custom headers from host config. */
  headers?: Record<string, string>;
  /**
   * Free-form metadata the host may pass through (e.g. Azure
   * deployment name, profile id). Adapters MUST NOT throw on
   * unknown keys; treat the bag as forward-compatible.
   */
  extra?: Record<string, unknown>;
}

/**
 * A BYOK provider adapter. Each mapping owns one provider id.
 *
 * The `buildProviderConfig` function returns an SDK
 * {@link SdkProviderConfig} or `undefined` if the context is
 * insufficient to build a valid config (missing required credentials,
 * unsupported wire-api combination, etc.). Returning `undefined` is
 * how an adapter says "I recognize this provider but cannot serve
 * this request" without throwing.
 */
export interface CopilotSdkProviderMapping {
  /** Provider id this mapping owns. Matched case-insensitively. */
  readonly providerId: string;
  /** Human-readable label for logging/diagnostics. */
  readonly label?: string;
  /**
   * Build an SDK `ProviderConfig` from the resolution context, or
   * return `undefined` if this adapter cannot serve the request.
   * Adapters MUST NOT throw on a clean "cannot serve" path; reserve
   * exceptions for programmer errors.
   */
  buildProviderConfig(ctx: CopilotSdkProviderMappingContext): SdkProviderConfig | undefined;
}
