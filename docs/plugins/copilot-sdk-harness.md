---
summary: "Run OpenClaw embedded agent turns through the bundled GitHub Copilot SDK harness"
title: "Copilot SDK harness"
read_when:
  - You want to use the bundled GitHub Copilot SDK harness for an agent
  - You need configuration examples for the `copilot-sdk` runtime
  - You are wiring an agent to subscription Copilot (github / openclaw / copilot) and want it to run through the Copilot CLI
---

The bundled `copilot-sdk` extension lets OpenClaw run embedded subscription
Copilot agent turns through the GitHub Copilot CLI (`@github/copilot-sdk`)
instead of the built-in PI harness.

Use the Copilot SDK harness when you want the Copilot CLI session to own the
low-level agent loop: native tool execution, native side questions, native
compaction (`infiniteSessions`), and CLI-managed thread state under
`copilotHome`. OpenClaw still owns chat channels, session files, model
selection, OpenClaw dynamic tools (bridged), approvals, media delivery, the
visible transcript mirror, and `openclaw doctor`.

For the broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes).

## Requirements

- OpenClaw with the bundled `copilot-sdk` extension available.
- If your config uses `plugins.allow`, include `@openclaw/copilot-sdk-harness`.
- A GitHub Copilot subscription that can drive the Copilot CLI (or a
  `gitHubToken` env / auth-profile entry for headless / cron runs).
- A writable `copilotHome` directory. The harness defaults to
  `~/.openclaw/agents/<agentId>/copilot` for full per-agent isolation. The
  platform default (`%APPDATA%\copilot` on Windows, `$XDG_CONFIG_HOME/copilot`
  or `~/.config/copilot` elsewhere) is used as the doctor probe fallback when
  no explicit home is set.

`openclaw doctor` runs the bundled
[doctor contract](#doctor-and-probes) for the extension; failures there are
the canonical way to confirm the environment is ready before opting an agent
in.

## Quickstart

Pin one model (or one provider) to the harness:

```json5
{
  agents: {
    defaults: {
      model: "github-copilot/gpt-5.5",
      models: {
        "github-copilot/gpt-5.5": {
          agentRuntime: { id: "copilot-sdk" },
        },
      },
    },
  },
}
```

Both routes are equivalent. Use `agentRuntime.id` on a single model entry
when only that model should be routed through the harness; set
`runtime.id` on a provider when every model under that provider should use
it.

## Supported providers

The harness advertises support for the canonical `github-copilot` provider
(the same id owned by `extensions/github-copilot`):

- `github-copilot`

Anything outside that set falls through `selection.ts`'s `auto_pi` branch back
to PI. BYOK provider adapters can be registered through the harness's
provider-mapping registry, but at MVP the registry ships with no adapters; see
[BYOK provider mapping](#byok-provider-mapping) below.

Subscription Copilot providers are **not** registered through the BYOK
provider-mapping registry. They are claimed by the harness itself and listed
in `extensions/copilot-sdk/doctor-contract-api.ts` under
`sessionRouteStateOwners[0].providerIds`.

## Auth

Per-agent precedence, applied during `runCopilotSdkAttempt`:

1. **Explicit `useLoggedInUser: true`** on the attempt input. Uses the Copilot
   CLI's logged-in user resolved under the agent's `copilotHome`.
2. **`gitHubToken`** from the attempt input or resolved from an auth profile
   on the agent's `AuthProfileStore` (`copilot-sdk:` prefix). Headless and cron
   runs typically use this path with a token from `GITHUB_TOKEN` /
   `OPENCLAW_GITHUB_TOKEN` env.
3. **`profileId` + `profileVersion`** from the attempt input, which resolves
   to an `AuthProfileStore` entry.
4. **BYOK provider** when the model ref is in a registered BYOK adapter (see
   below). At MVP no adapters are registered, so this path is reserved.

Each agent gets a dedicated `copilotHome` so Copilot CLI tokens, sessions, and
config do not leak between agents on the same machine. The default is
`~/.openclaw/agents/<agentId>/copilot`. Override with
`copilotHome: <path>` on the attempt input when you need a custom location
(for example, a shared mount for migration).

`probeCopilotAuthShape` (see [Doctor and probes](#doctor-and-probes)) is the
pure shape check that validates which of the four modes above will be used.
It does not perform a live SDK handshake.

## Configuration surface

The harness reads its config from per-attempt input
(`runCopilotSdkAttempt({...})`) plus a small set of env defaults inside
`extensions/copilot-sdk/src/`:

- `copilotHome` — per-agent CLI state directory (defaults documented above).
- `model` — string or `{ provider, id, api? }`. When omitted, OpenClaw uses
  the agent's normal model selection and the harness verifies the resolved
  provider is in the supported set.
- `reasoningEffort` — `"low" | "medium" | "high" | "xhigh"`. Maps from
  OpenClaw's `ThinkLevel` / `ReasoningLevel` resolution in
  `auto-reply/thinking.ts`.
- `infiniteSessionConfig` — optional override for the SDK
  `infiniteSessions` block driven by `harness.compact`. Defaults are safe to
  leave as-is.
- `hooksConfig` — optional bridge config exposing OpenClaw
  before/after-message-write hooks to the SDK loop.
- `permissionPolicy` — overrides for the policy bridge (defaults to OpenClaw's
  shared `effective-tool-policy` logic, copied into `permission-bridge.ts`).
- `userInputPolicy` — overrides for `onUserInputRequest` (defaults to OpenClaw's
  channel / TUI prompt flow via the existing commitments runtime).
- `enableSessionTelemetry` — opt-in OpenTelemetry routing via
  `telemetry-bridge.ts`.

Nothing in the rest of OpenClaw needs to know about these fields. Other
plugins, channels, and core code only see the standard
`AgentHarnessAttemptParams` / `AgentHarnessAttemptResult` shape.

## Compaction

When `harness.compact` runs, the Copilot SDK harness:

1. Enables `infiniteSessions` on the SDK session.
2. Lets the SDK perform its native compaction.
3. Writes an OpenClaw-shaped marker at
   `workspacePath/files/openclaw-compaction-<ts>.json` so existing OpenClaw
   transcript readers still see a familiar artifact.

The OpenClaw side transcript mirror (see below) continues to receive the
post-compaction messages, so user-facing chat history stays consistent.

## Transcript mirroring

`runCopilotSdkAttempt` dual-writes each turn's mirrorable messages into the
OpenClaw audit transcript via
`extensions/copilot-sdk/src/dual-write-transcripts.ts`. The mirror is
per-session scoped (`copilot-sdk:${sessionId}`) and uses a per-message
identity (`${role}:${sha256_16(role,content)}`) so re-emits of prior-turn
entries collide with existing on-disk keys and do not duplicate.

The mirror is wrapped in two layers of failure containment so a transcript
write failure cannot fail the attempt: an internal best-effort wrapper and a
defense-in-depth `.catch(...)` at the attempt level. Failures are logged but
not surfaced.

## Side questions

`harness.runSideQuestion` uses a pooled transient SDK session per agent:
`client.createSession({ infiniteSessions: false, tools: [] })` →
`sendAndWait(...)` → `disconnect`. The session is held in `inFlight` until the
side question settles, so harness `dispose` waits for in-flight side questions
to drain before tearing the pool down.

## BYOK provider mapping

`extensions/copilot-sdk/src/provider-mapping/` exposes a process-singleton
registry for BYOK provider adapters. Adapters can be registered at app startup
to expose non-subscription providers (Anthropic, OpenAI direct, local models,
etc.) through the Copilot SDK harness path. The registry is:

- Case-insensitive on provider id lookups.
- Append-only (`registerCopilotSdkProviderMapping` throws on duplicate
  registrations; treat as programmer error).
- Distinct from the subscription `github-copilot` provider — that id is
  claimed by the harness, not the registry.

At MVP the registry ships with no adapters, so
`supportsCopilotSdkByokProvider(<any-id>)` returns `false`. Use the
`__resetCopilotSdkProviderMappingsForTests` / `__listCopilotSdkProviderMappingsForTests`
test helpers when writing adapter PRs.

## Doctor and probes

`extensions/copilot-sdk/doctor-contract-api.ts` is auto-loaded by
`src/plugins/doctor-contract-registry.ts`. It contributes:

- An empty `legacyConfigRules` (no retired fields at MVP).
- A no-op `normalizeCompatibilityConfig` (kept so future field retirements
  have a stable in-tree home).
- One `sessionRouteStateOwners` entry claiming provider `github-copilot`;
  runtime `copilot-sdk`; CLI session key `copilot-sdk`; auth profile
  prefix `copilot-sdk:`.

`extensions/copilot-sdk/src/doctor-probes.ts` exports three imperative probes
that hosts (including `openclaw doctor`) can call to verify the environment:

| Probe                      | What it checks                                                                    | Reasons it can fail                                                              |
| -------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `probeCopilotCliVersion`   | `copilot --version` exits 0 with a non-empty version string                       | `non-zero-exit`, `empty-version`, `spawn-failed`, `spawn-error`, `probe-timeout` |
| `probeCopilotHomeWritable` | `mkdir -p copilotHome` + write + rm a marker file                                 | `copilothome-not-writable` (with the underlying fs error in `details.rawError`)  |
| `probeCopilotAuthShape`    | At least one of `useLoggedInUser`, `gitHubToken`, or `profileId`+`profileVersion` | `no-auth-source`                                                                 |

Each probe accepts a DI seam (`spawnFn`, `fsApi`) so tests do not spawn the
real Copilot CLI or touch the host fs.

## Limitations

- The harness only claims subscription Copilot providers at MVP. BYOK is
  framework-only; expect adapter PRs to land incrementally.
- The harness does not deliver TUI; PI's TUI is unaffected and remains the
  fallback for whatever runtimes do not have a peer surface.
- PI session state is not migrated when an agent switches to `copilot-sdk`.
  Selection is per attempt; existing PI sessions remain valid.

## Related

- [Agent runtimes](/concepts/agent-runtimes)
- [Codex harness](/plugins/codex-harness)
- [Agent harness plugins (SDK reference)](/plugins/sdk-agent-harness)
