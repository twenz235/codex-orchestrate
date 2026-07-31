# Codex Orchestrate

Codex Orchestrate is a reusable Codex Plugin. Its `codex-orchestrate` Skill
turns a feature request into a dependency-aware task plan, simulates two
different failure rounds, and runs isolated Codex workers with verification,
retry, timeout, scope enforcement, resumability, and safe integration.

The repository is the source of truth. The Plugin manifest packages the Skill;
the execution core lives at
`skills/codex-orchestrate/scripts/orchestrator.ts`.

The runner never pushes, deploys, or merges into a shared branch automatically.

## Install in Codex

Add this GitHub repository as a Plugin marketplace, then install the Plugin:

```bash
codex plugin marketplace add twenz235/codex-orchestrate --ref main
codex plugin add codex-orchestrate@codex-orchestrate
```

Verify the marketplace and installed Plugin:

```bash
codex plugin marketplace list
codex plugin list
```

Start a new Codex thread after installing or updating so the Skill index is
refreshed. To update the Git-backed marketplace later:

```bash
codex plugin marketplace upgrade codex-orchestrate
codex plugin add codex-orchestrate@codex-orchestrate
```

For a pinned release, replace `main` with a Git tag such as `v0.1.0` after that
tag has been published.

## Local development

This repository requires Node 22.6 or newer so the runner can execute its
TypeScript source without a project-local runtime dependency.

```bash
pnpm test
pnpm orchestrate -- --plan examples/feature.plan.json --dry-run
pnpm orchestrate -- validate --plan examples/feature.plan.json
```

To run against another repository, pass `--repo` and a plan whose paths and
verification commands belong to that repository:

```bash
pnpm orchestrate -- \
  --repo /path/to/project \
  --plan /path/to/project/.codex-orchestrator/feature.plan.json
```

`codexCommand` may be a command on `PATH` (normally `codex`), an absolute path,
or a path relative to the target repository root.

Each successful task is integrated only after its verification commands pass.
Changes outside a task's `writeScope` fail that task without integration. A
cherry-pick conflict is a hard stop and leaves the integration worktree for
human resolution.

Runtime state and logs are written under the target repository's
`.codex-orchestrator/runs/` directory. The target worktree may be dirty; the
runner uses the selected `baseRef` commit and does not copy uncommitted changes
into workers.

## Repository conventions

Keep project-specific rules in each target repository's `AGENTS.md` or other
local guidance. Do not encode one project's package names, branch names, or
secrets into this Plugin.

Create a tagged release after changing the execution contract. Consumers
should review and pin the Plugin version before enabling unattended runs.
