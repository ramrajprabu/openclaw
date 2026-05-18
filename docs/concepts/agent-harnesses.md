---
summary: "How OpenClaw picks between bundled agent harnesses (PI, Codex, GitHub Copilot SDK) and how to opt into a non-default one"
title: "Agent harnesses"
read_when:
  - You are deciding whether to keep PI or switch to Codex or the GitHub Copilot SDK for an agent
  - You are opting an agent or provider into the Copilot SDK harness
  - You need a side-by-side of what each bundled harness owns and how to configure it
---

OpenClaw separates the **model ref** (provider + model id), the **agent runtime**
(the loop that actually executes a prepared turn), and the **harness** (the
plugin that implements a runtime). This page is about choosing a harness.

For the underlying runtime model and selection algorithm, see
[Agent runtimes](/concepts/agent-runtimes). For provider-vs-model-vs-runtime
labels, see [Models CLI](/concepts/models). This page focuses on the user
decision: _which bundled harness should this agent use, and how do I opt in?_

PI is the default. It stays in place for every agent that has not explicitly
opted into another harness. The bundled Codex and GitHub Copilot SDK harnesses
are peer options that handle specific provider / model families.

## At a glance

| Harness        | Runtime id    | Typical model refs                                           | Owns the model loop? | Opt-in mechanism                                                                       |
| -------------- | ------------- | ------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------------------- |
| PI (built-in)  | `pi`          | All providers                                                | OpenClaw             | Default. No action required.                                                           |
| Codex          | `codex`       | `openai/*` (default for that prefix in `auto` mode)          | Codex app-server     | Enable the bundled `codex` plugin. `openai/*` then resolves to it.                     |
| GitHub Copilot | `copilot-sdk` | `github/*`, `openclaw/*`, `copilot/*` (subscription Copilot) | Copilot CLI (SDK)    | Per-agent / per-provider `agentRuntime.id: "copilot-sdk"`. |

`auto` still falls back to PI for anything that is not explicitly claimed.
Selecting `copilot-sdk` is always opt-in; nothing routes there automatically.

## When to pick the Copilot SDK harness

Pick `copilot-sdk` when you want OpenClaw to drive an embedded agent turn
through the GitHub Copilot CLI (via `@github/copilot-sdk`) instead of PI's
in-process loop. The harness is a thin shim over the Copilot CLI subprocess,
so:

- Auth, tool execution, side questions, compaction, and transcript history are
  owned by the Copilot CLI per session.
- OpenClaw retains chat channels, OpenClaw dynamic tools (bridged), policy /
  permission gating, the visible transcript mirror, and `openclaw doctor`
  health checks.
- The harness only claims subscription Copilot providers (`github`,
  `openclaw`, `copilot`) by default. BYOK adapters for other providers are
  framework-only at MVP and have to be registered explicitly; see
  [Copilot SDK harness](/plugins/copilot-sdk-harness) for the registration
  path.

Stay on PI when:

- You need a model ref that is not in the Copilot SDK provider set (most
  Anthropic, Google, local, or BYOK providers).
- You depend on PI-only features such as the legacy `openai-codex` auth path,
  PI tool extensions that have not been bridged, or PI-specific telemetry.
- You need a fully in-process loop (no Copilot CLI subprocess) for deterministic
  testing or restricted runtimes.

Pick Codex when the model ref is `openai/*` and you want Codex app-server to
own the loop (the common ChatGPT / Codex subscription setup); that path is
documented in [Codex harness](/plugins/codex-harness).

## Opting in to the Copilot SDK harness

There are two ways to select `copilot-sdk` for an embedded agent turn. They
follow the same precedence as any other harness selection: model-scoped policy
beats provider-scoped policy beats `auto`.

### 1. Per-model runtime policy (recommended)

Set `agentRuntime.id` on the specific model entry the agent uses:

```json5
{
  agents: {
    defaults: {
      model: "github/gpt-5.5",
      models: {
        "github/gpt-5.5": {
          agentRuntime: { id: "copilot-sdk" },
        },
      },
    },
  },
}
```

This keeps the model ref canonical and pins the harness to that specific
provider/model pair. Other models in the same agent are unaffected.

### 2. Per-provider runtime policy

If every model on a provider should run through the same harness, set the
runtime once at the provider level:

```json5
{
  models: {
    providers: {
      github: {
        agentRuntime: { id: "copilot-sdk" },
      },
    },
  },
}
```

This is convenient when an agent uses several Copilot subscription models and
you do not want to repeat the runtime block per model.

There is no whole-agent or whole-session env knob for harness selection, and
no CLI flag either. `OPENCLAW_AGENT_RUNTIME` and other session-wide harness
pins are ignored. Use per-provider or per-model `agentRuntime.id`. Run
`openclaw doctor --fix` to remove legacy whole-agent runtime config.

## What each harness owns

The split below summarises which surface drives which lifecycle. The Codex
column is the same as in [Agent runtimes](/concepts/agent-runtimes); the
Copilot SDK column is what the bundled `copilot-sdk` extension contributes.

| Surface                     | OpenClaw PI (default)               | Codex app-server                                           | Copilot SDK (`copilot-sdk`)                                                     |
| --------------------------- | ----------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Model loop owner            | OpenClaw PI runner                  | Codex app-server                                           | Copilot CLI session (`@github/copilot-sdk`)                                     |
| Canonical thread state      | OpenClaw transcript                 | Codex thread + OpenClaw mirror                             | Copilot CLI session under `copilotHome` + OpenClaw mirror                       |
| OpenClaw dynamic tools      | Native OpenClaw tool loop           | Bridged through the Codex adapter                          | Bridged into SDK `tools` with policy / permission gating                        |
| Native shell / file tools   | PI / OpenClaw path                  | Codex-native tools                                         | Copilot CLI tools (gated by the permission bridge)                              |
| Compaction                  | OpenClaw or selected context engine | Codex-native compaction                                    | Copilot SDK `infiniteSessions` + an OpenClaw-shaped workspace marker file       |
| Side questions              | PI inline                           | Codex thread                                               | Pooled transient SDK session per agent                                          |
| Auth                        | `AuthProfileStore` per agent        | Codex OAuth / `openai-codex` profile or app-server account | `useLoggedInUser` / `gitHubToken` / BYOK provider per agent under `copilotHome` |
| Channel delivery            | OpenClaw                            | OpenClaw                                                   | OpenClaw                                                                        |
| `openclaw doctor` ownership | PI built-in                         | `extensions/codex` doctor contract                         | `extensions/copilot-sdk` doctor contract (auto-loaded) + probes                 |

PI keeps its full footprint when other harnesses are enabled. Switching an
agent to `copilot-sdk` or `codex` does not migrate PI sessions or auth state;
selection happens per attempt.

## Trade-offs

- **Subprocess vs in-process.** PI runs in-process; `copilot-sdk` and `codex`
  spawn a subprocess per pool key. That adds a small startup cost but isolates
  state and crash domains.
- **Compaction.** PI compacts inside OpenClaw and writes a `compactionSummary`
  custom message. `copilot-sdk` enables SDK `infiniteSessions` and writes a
  workspace marker file (`workspacePath/files/openclaw-compaction-<ts>.json`)
  so existing OpenClaw transcript readers still see a familiar artifact.
- **Tooling parity.** OpenClaw dynamic tools work under all three harnesses
  via bridges; PI-only tool extensions are not automatically available under
  Codex or Copilot SDK.
- **Auth isolation.** `copilot-sdk` puts each agent's Copilot CLI state in its
  own `copilotHome` (default: `~/.openclaw/agents/<agentId>/copilot`).
  Agents are auth-isolated by default.
- **BYOK.** The Copilot SDK harness ships a framework-only BYOK provider
  mapping registry with no adapters at MVP. Subscription Copilot providers
  (`github`, `openclaw`, `copilot`) are claimed by the harness itself, not by
  that registry.

## Doctor and diagnostics

`openclaw doctor` auto-loads each bundled harness's doctor contract and asks
each one which providers / runtimes / CLI session keys / auth profile prefixes
it owns. For `copilot-sdk` that contract claims:

- Provider ids: `github`, `openclaw`, `copilot`.
- Runtime id: `copilot-sdk`.
- CLI session key: `copilot-sdk`.
- Auth profile prefix: `copilot-sdk:`.

The `copilot-sdk` extension also exports imperative runtime probes
(`probeCopilotCliVersion`, `probeCopilotHomeWritable`, `probeCopilotAuthShape`)
that doctor and other tools can call to verify that the Copilot CLI is on
`PATH`, that `copilotHome` is writable, and that the resolved auth shape is
usable. See [Copilot SDK harness](/plugins/copilot-sdk-harness) for the
probes module path and the configuration surface they validate.

## Related

- [Copilot SDK harness](/plugins/copilot-sdk-harness)
- [Codex harness](/plugins/codex-harness)
- [Agent runtimes](/concepts/agent-runtimes)
- [Models CLI](/concepts/models)
- [Agent harness plugins (SDK reference)](/plugins/sdk-agent-harness)
