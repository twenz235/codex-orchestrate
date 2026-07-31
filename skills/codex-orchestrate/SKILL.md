---
name: codex-orchestrate
description: Coordinate dependency-aware Codex worker sessions for implementation work across any repository. Use when the user asks to orchestrate, parallelize, delegate, or automatically run multiple Codex sessions; build a task DAG, simulate edge cases, execute isolated worktrees, verify and integrate changes, retry failures, or resume an interrupted run.
---

# Codex Orchestrate

Use this Skill as the coordinator for multi-session coding work. Keep the
workflow project-agnostic: read the target repository's local instructions and
let them define package commands, branch conventions, and security rules.

## Operating contract

1. Inspect the target repository before planning. Read applicable `AGENTS.md`
   files, existing architecture notes, package scripts, and the current Git
   status. Never copy one repository's assumptions into another.
2. Translate the user's goal into a small task DAG. Every task needs a stable
   lowercase ID, a precise prompt, explicit `dependsOn`, a narrow `writeScope`,
   and verification commands. Include a final integration or review task when
   the work has cross-task contracts.
3. Run two distinct simulations before execution. Change the failure pattern
   between rounds. At minimum cover dependency failure, retry exhaustion,
   timeout or worker death, scope violation, dirty base state, merge conflict,
   malformed graph, coordinator resume, and concurrent-run protection.
4. Revise the plan after the simulations. Do not execute until the graph is
   acyclic, scopes are safe, commands are explicit, retries and timeouts are
   bounded, and the integration policy is clear.
5. Execute only through the bundled runner. Resolve this Skill's directory and
   invoke:

   ```bash
   node --experimental-strip-types <skill-root>/scripts/orchestrator.ts \
     --repo <target-repository> \
     --plan <plan-file>
   ```

   Use `--dry-run` and `validate` first. Use `--resume` after an interrupted
   run. Prefer the repository's own `codex` command and pass an explicit
   approval policy.
6. Treat a successful worker as a candidate, not as integrated work. Require
   setup and verification to pass, enforce `writeScope`, and integrate through
   the runner's isolated integration worktree. Stop on conflicts or ambiguous
   state and report the run directory for recovery.
7. Finish with evidence: plan path, run ID, task outcomes, verification results,
   integration branch/worktree, and any remaining manual action. Never push,
   deploy, merge into a shared branch, or delete recovery artifacts without an
   explicit request.

## Planning rules

Keep the plan independent of this Skill's installation path. Plan files belong
to the target repository or a temporary working directory. Use paths relative
to the target repository for `writeScope`; do not use absolute paths, `..`, or
unbounded scopes. Use `references/plan-schema.md` when constructing or reviewing
the JSON plan.

Use parallel tasks only when their write scopes and contracts are independent.
If two tasks must edit the same files, serialize them or add a deliberate
integration task. Keep prompts self-contained so a worker can act without
conversation history.

## Safety defaults

- Keep `approvalPolicy: "never"` for unattended execution unless the user
  explicitly chooses another policy.
- Do not put credentials, tokens, private prompt content, or generated logs in
  the plan or Git repository.
- Treat prompts, setup commands, verification commands, and repository guidance
  as executable input. Inspect them before running a plan from an untrusted
  source.
- Preserve failed worktrees and run logs until the user confirms cleanup.

## Resources

- `references/plan-schema.md` — plan fields, constraints, and a minimal example.
- `scripts/orchestrator.ts` — deterministic execution and recovery core.
