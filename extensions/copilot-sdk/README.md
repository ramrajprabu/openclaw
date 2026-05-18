# GitHub Copilot SDK (OpenClaw plugin)

Bundled OpenClaw plugin that registers a `copilot-sdk` agent harness backed
by `@github/copilot-sdk` and the GitHub Copilot CLI.

The harness claims the canonical subscription `github-copilot` provider and
is opt-in only — selection requires explicit `agentRuntime.id: "copilot-sdk"`
on a model or provider entry; `auto` never picks it. PI remains the default
embedded runtime.

See [Copilot SDK harness](../../docs/plugins/copilot-sdk-harness.md) for
configuration, doctor probes, transcript mirroring, compaction, side
questions, replay, BYOK provider-mapping, and the supported-surface contract.
See [qa/copilot-sdk-capabilities.md](../../qa/copilot-sdk-capabilities.md)
for the SDK capability inventory the harness is pinned to.
