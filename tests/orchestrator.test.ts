import assert from "node:assert/strict";
import test from "node:test";
import { blockImpossibleTasks, getReadyTaskIds, pathMatchesScope, validatePlan, type OrchestratorPlan, type RunState } from "../skills/codex-orchestrate/scripts/orchestrator.ts";

function plan(overrides: Partial<OrchestratorPlan> = {}): OrchestratorPlan {
  return {
    version: 1,
    name: "test",
    baseRef: "dev",
    maxConcurrency: 2,
    maxAttempts: 2,
    timeoutMs: 60_000,
    setup: [],
    codexCommand: "codex",
    approvalPolicy: "never",
    tasks: [
      { id: "engine", title: "engine", prompt: "engine", dependsOn: [], writeScope: ["packages/engine/**"], verify: [], setup: [] },
      { id: "api", title: "api", prompt: "api", dependsOn: ["engine"], writeScope: ["apps/api/**"], verify: [], setup: [] },
    ],
    ...overrides,
  };
}

function state(statuses: Record<string, RunState["tasks"][string]["status"]>): RunState {
  return {
    version: 1,
    runId: "test-run",
    name: "test",
    repoRoot: "/tmp/repo",
    planPath: "/tmp/plan.json",
    baseRef: "dev",
    baseSha: "abc",
    integrationBranch: "codex/test/integration",
    integrationPath: "/tmp/integration",
    status: "running",
    tasks: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { id, status, attempt: 0, updatedAt: new Date().toISOString() }])),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("validates a dependency graph and rejects cycles", () => {
  assert.equal(validatePlan(plan()).tasks.length, 2);
  assert.throws(() => validatePlan(plan({
    tasks: [
      { id: "a", title: "a", prompt: "a", dependsOn: ["b"], writeScope: ["a/**"], verify: [], setup: [] },
      { id: "b", title: "b", prompt: "b", dependsOn: ["a"], writeScope: ["b/**"], verify: [], setup: [] },
    ],
  })), /cycle/);
});

test("rejects unsafe and duplicate task ids before execution", () => {
  assert.throws(() => validatePlan(plan({
    tasks: [
      { id: "../escape", title: "bad", prompt: "bad", dependsOn: [], writeScope: ["**"], verify: [], setup: [] },
    ],
  })), /invalid task id/);
  assert.throws(() => validatePlan(plan({
    tasks: [
      { id: "same", title: "one", prompt: "one", dependsOn: [], writeScope: ["a/**"], verify: [], setup: [] },
      { id: "same", title: "two", prompt: "two", dependsOn: [], writeScope: ["b/**"], verify: [], setup: [] },
    ],
  })), /duplicate/);
});

test("schedules only tasks whose dependencies succeeded", () => {
  const testPlan = plan();
  assert.deepEqual(getReadyTaskIds(testPlan, state({ engine: "pending", api: "pending" })), ["engine"]);
  assert.deepEqual(getReadyTaskIds(testPlan, state({ engine: "succeeded", api: "pending" })), ["api"]);
});

test("blocks descendants after a terminal dependency failure", () => {
  const testPlan = plan();
  const testState = state({ engine: "failed", api: "pending" });
  assert.deepEqual(blockImpossibleTasks(testPlan, testState), ["api"]);
  assert.equal(testState.tasks.api.status, "blocked");
});

test("matches scoped paths without allowing sibling packages", () => {
  assert.equal(pathMatchesScope("packages/engine/src/index.ts", ["packages/engine/**"]), true);
  assert.equal(pathMatchesScope("packages/board/src/index.ts", ["packages/engine/**"]), false);
  assert.equal(pathMatchesScope("apps/api/src/index.ts", ["apps/*/src/index.ts"]), true);
});
