# Orchestration plan schema

The runner accepts a JSON object with these fields:

```json
{
  "version": 1,
  "name": "feature-name",
  "baseRef": "main",
  "maxConcurrency": 2,
  "maxAttempts": 2,
  "timeoutMs": 900000,
  "setup": [],
  "codexCommand": "codex",
  "approvalPolicy": "never",
  "tasks": [
    {
      "id": "core",
      "title": "Implement the core change",
      "prompt": "Implement the requested core behavior and add focused tests.",
      "dependsOn": [],
      "writeScope": ["src/core/**"],
      "verify": ["pnpm test"],
      "setup": [],
      "maxAttempts": 2,
      "timeoutMs": 900000,
      "commitMessage": "feat: implement core change"
    }
  ]
}
```

`version`, `name`, `baseRef`, `maxConcurrency`, `maxAttempts`, `timeoutMs`,
`setup`, `codexCommand`, `approvalPolicy`, and `tasks` are required. Task
`id`, `title`, `prompt`, `dependsOn`, `writeScope`, `verify`, and `setup` are
required. Task-level attempt and timeout values override plan defaults.

Constraints enforced before execution:

- task IDs use lowercase letters, numbers, `.`, `_`, and `-`; `..` is rejected;
- dependencies must name existing tasks and the graph must be acyclic;
- scopes must be relative, non-empty, and free of `..` or a leading `/`;
- concurrency and attempt counts are positive and capped;
- timeouts must be at least one second;
- successful workers must leave only in-scope changes before integration.

The runner creates a separate worktree for every attempt and an integration
worktree for the run. It writes `plan.json`, `state.json`, event logs, worker
output, and verification logs under `.codex-orchestrator/runs/<run-id>/` in the
target repository.
