import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export interface TaskDefinition {
  id: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  writeScope: string[];
  verify: string[];
  setup: string[];
  maxAttempts?: number;
  timeoutMs?: number;
  commitMessage?: string;
}

export interface OrchestratorPlan {
  version: 1;
  name: string;
  baseRef: string;
  maxConcurrency: number;
  maxAttempts: number;
  timeoutMs: number;
  setup: string[];
  codexCommand: string;
  approvalPolicy: ApprovalPolicy;
  tasks: TaskDefinition[];
}

export interface TaskState {
  id: string;
  status: TaskStatus;
  attempt: number;
  baseSha?: string;
  headSha?: string;
  candidateCommits?: string[];
  integratedHead?: string;
  worktreePath?: string;
  pid?: number;
  lastError?: string;
  resultPath?: string;
  updatedAt: string;
}

export interface RunState {
  version: 1;
  runId: string;
  name: string;
  repoRoot: string;
  planPath: string;
  baseRef: string;
  baseSha: string;
  integrationBranch: string;
  integrationPath: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  tasks: Record<string, TaskState>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface CliOptions {
  command: "run" | "validate" | "help";
  planPath?: string;
  resumePath?: string;
  repoPath: string;
  dryRun: boolean;
  maxConcurrency?: number;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: string;
}

interface TaskExecutionResult {
  ok: boolean;
  retryable: boolean;
  reason?: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  commits: string[];
  worktreePath: string;
  resultPath: string;
}

interface RuntimeContext {
  plan: OrchestratorPlan;
  state: RunState;
  runDir: string;
  eventsPath: string;
  cancelled: boolean;
  children: Map<string, ChildProcess>;
}

const RUN_STATE_VERSION = 1;
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((entry) => entry as string);
}

function asPositiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function asTimeout(value: unknown, label: string, fallback: number): number {
  const timeout = asPositiveInteger(value, label, fallback);
  if (timeout < 1_000) throw new Error(`${label} must be at least 1000ms`);
  return timeout;
}

function validateTaskId(id: string): void {
  if (!TASK_ID_RE.test(id) || id.includes("..")) {
    throw new Error(`invalid task id '${id}'; use lowercase letters, numbers, '.', '_' and '-' only`);
  }
}

function validatePattern(pattern: string, label: string): void {
  if (pattern.trim() === "" || pattern.startsWith("/") || pattern.includes("..")) {
    throw new Error(`${label} contains an unsafe path pattern '${pattern}'`);
  }
}

function assertAcyclic(tasks: TaskDefinition[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`dependency cycle detected at task '${id}'`);
    if (visited.has(id)) return;
    const task = byId.get(id);
    if (!task) throw new Error(`unknown dependency '${id}'`);
    visiting.add(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) visit(task.id);
}

export function validatePlan(value: unknown): OrchestratorPlan {
  const input = asRecord(value, "plan");
  if (input.version !== 1) throw new Error("plan.version must be 1");

  const rawTasks = input.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("plan.tasks must contain at least one task");
  }

  const ids = new Set<string>();
  const tasks: TaskDefinition[] = rawTasks.map((rawTask, index) => {
    const task = asRecord(rawTask, `plan.tasks[${index}]`);
    const id = asString(task.id, `plan.tasks[${index}].id`);
    validateTaskId(id);
    if (ids.has(id)) throw new Error(`duplicate task id '${id}'`);
    ids.add(id);

    const writeScope = asStringArray(task.writeScope, `task '${id}'.writeScope`);
    writeScope.forEach((pattern) => validatePattern(pattern, `task '${id}'.writeScope`));
    const commitMessage = task.commitMessage === undefined
      ? undefined
      : asString(task.commitMessage, `task '${id}'.commitMessage`);
    if (commitMessage?.includes("\n")) throw new Error(`task '${id}'.commitMessage cannot contain newlines`);

    return {
      id,
      title: asString(task.title, `task '${id}'.title`),
      prompt: asString(task.prompt, `task '${id}'.prompt`),
      dependsOn: asStringArray(task.dependsOn ?? [], `task '${id}'.dependsOn`),
      writeScope,
      verify: asStringArray(task.verify ?? [], `task '${id}'.verify`),
      setup: asStringArray(task.setup ?? [], `task '${id}'.setup`),
      maxAttempts: task.maxAttempts === undefined
        ? undefined
        : asPositiveInteger(task.maxAttempts, `task '${id}'.maxAttempts`, 1),
      timeoutMs: task.timeoutMs === undefined
        ? undefined
        : asTimeout(task.timeoutMs, `task '${id}'.timeoutMs`, DEFAULT_TIMEOUT_MS),
      commitMessage,
    };
  });

  const plan: OrchestratorPlan = {
    version: 1,
    name: asString(input.name, "plan.name"),
    baseRef: asString(input.baseRef, "plan.baseRef"),
    maxConcurrency: asPositiveInteger(input.maxConcurrency, "plan.maxConcurrency", 2),
    maxAttempts: asPositiveInteger(input.maxAttempts, "plan.maxAttempts", 2),
    timeoutMs: asTimeout(input.timeoutMs, "plan.timeoutMs", DEFAULT_TIMEOUT_MS),
    setup: asStringArray(input.setup ?? [], "plan.setup"),
    codexCommand: asString(input.codexCommand ?? "codex", "plan.codexCommand"),
    approvalPolicy: (input.approvalPolicy ?? "never") as ApprovalPolicy,
    tasks,
  };

  if (!["untrusted", "on-request", "never"].includes(plan.approvalPolicy)) {
    throw new Error("plan.approvalPolicy must be untrusted, on-request, or never");
  }
  if (plan.maxConcurrency > 32) throw new Error("plan.maxConcurrency cannot exceed 32");
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) throw new Error(`task '${task.id}' cannot depend on itself`);
      if (!ids.has(dependency)) throw new Error(`task '${task.id}' depends on unknown task '${dependency}'`);
    }
  }
  assertAcyclic(tasks);
  return plan;
}

export function getReadyTaskIds(plan: OrchestratorPlan, state: RunState): string[] {
  return plan.tasks
    .filter((task) => state.tasks[task.id]?.status === "pending")
    .filter((task) => task.dependsOn.every((dependency) => state.tasks[dependency]?.status === "succeeded"))
    .map((task) => task.id);
}

export function blockImpossibleTasks(plan: OrchestratorPlan, state: RunState): string[] {
  const blocked: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      const taskState = state.tasks[task.id];
      if (!taskState || taskState.status !== "pending") continue;
      const impossible = task.dependsOn.some((dependency) => {
        const dependencyState = state.tasks[dependency];
        return dependencyState.status === "failed"
          || dependencyState.status === "blocked"
          || dependencyState.status === "cancelled";
      });
      if (impossible) {
        taskState.status = "blocked";
        taskState.lastError = "dependency did not succeed";
        taskState.updatedAt = now();
        blocked.push(task.id);
        changed = true;
      }
    }
  }
  return blocked;
}

export function pathMatchesScope(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "**" || pattern === "*") return true;
    if (pattern.endsWith("/**")) return file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2));
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`).test(file);
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitTry(args: string[], cwd: string): { ok: true; output: string } | { ok: false; error: string } {
  try {
    return { ok: true, output: git(args, cwd) };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }
  setTimeout(() => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid!, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }, 2_000).unref();
}

function runLoggedProcess(
  command: string,
  args: string[],
  cwd: string,
  stdoutPath: string,
  stderrPath: string,
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void,
): Promise<ProcessResult> {
  mkdirSync(dirname(stdoutPath), { recursive: true });
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, CODEX_ORCHESTRATOR: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  onSpawn?.(child);
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);

  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      resolveResult({ ...result, timedOut });
    };

    child.once("error", (error) => finish({ code: null, signal: null, timedOut, error: formatError(error) }));
    child.once("close", (code, signal) => finish({ code, signal, timedOut }));
  });
}

function runShellLogged(
  command: string,
  cwd: string,
  logPath: string,
  timeoutMs: number,
  onSpawn?: (child: ChildProcess) => void,
): Promise<ProcessResult> {
  return runLoggedProcess("/bin/sh", ["-lc", command], cwd, logPath, logPath, timeoutMs, onSpawn);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function appendEvent(context: RuntimeContext, type: string, data: Record<string, unknown> = {}): void {
  appendFileSync(context.eventsPath, `${JSON.stringify({ at: now(), type, ...data })}\n`, "utf8");
}

function persistState(context: RuntimeContext): void {
  context.state.updatedAt = now();
  writeJsonAtomic(join(context.runDir, "state.json"), context.state);
}

function createRunId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function safeRunPath(repoRoot: string, runId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) throw new Error(`unsafe run id '${runId}'`);
  return join(repoRoot, ".codex-orchestrator", "runs", runId);
}

function acquireRunLock(runDir: string): () => void {
  const lockPath = join(runDir, "run.lock");
  mkdirSync(runDir, { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (isPidAlive(lock.pid)) throw new Error(`run is already active under pid ${lock.pid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("run is already active")) throw error;
      rmSync(lockPath, { force: true });
    }
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: now() })}\n`, "utf8");
  closeSync(fd);
  return () => rmSync(lockPath, { force: true });
}

function initializeTaskStates(plan: OrchestratorPlan): Record<string, TaskState> {
  return Object.fromEntries(plan.tasks.map((task) => [task.id, {
    id: task.id,
    status: "pending" as const,
    attempt: 0,
    updatedAt: now(),
  }]));
}

function validateCodex(command: string, repoRoot: string): void {
  const result = spawnSync(command, ["--version"], { cwd: repoRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`cannot run '${command} --version': ${result.error?.message ?? result.stderr ?? "unknown error"}`);
  }
}

function resolveCommand(command: string, repoRoot: string): string {
  return command.includes("/") && !command.startsWith("/") ? resolve(repoRoot, command) : command;
}

function ensureGitRepo(repoPath: string): string {
  const repoRoot = resolve(git(["rev-parse", "--show-toplevel"], repoPath));
  if (!existsSync(join(repoRoot, ".git"))) throw new Error(`not a git repository: ${repoPath}`);
  return repoRoot;
}

function createIntegrationWorktree(state: RunState): void {
  mkdirSync(dirname(state.integrationPath), { recursive: true });
  const result = gitTry(["worktree", "add", "-b", state.integrationBranch, state.integrationPath, state.baseSha], state.repoRoot);
  if (!result.ok) throw new Error(`cannot create integration worktree: ${result.error}`);
}

function createTaskWorktree(context: RuntimeContext, task: TaskDefinition, attempt: number): {
  path: string;
  branch: string;
  baseSha: string;
} {
  const baseSha = git(["rev-parse", "HEAD"], context.state.integrationPath);
  const taskDir = join(context.runDir, "tasks", task.id, `attempt-${attempt}`);
  const worktreePath = join(taskDir, "worktree");
  const branch = `codex/orchestrator/${context.state.runId}/${task.id}-a${attempt}`;
  mkdirSync(taskDir, { recursive: true });
  const result = gitTry(["worktree", "add", "-b", branch, worktreePath, baseSha], context.state.repoRoot);
  if (!result.ok) throw new Error(`cannot create worktree for ${task.id}: ${result.error}`);
  return { path: worktreePath, branch, baseSha };
}

function splitGitLines(output: string): string[] {
  return [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))];
}

function getUncommittedFiles(worktreePath: string): string[] {
  const tracked = splitGitLines(git(["diff", "--name-only"], worktreePath));
  const staged = splitGitLines(git(["diff", "--cached", "--name-only"], worktreePath));
  const untracked = splitGitLines(git(["ls-files", "--others", "--exclude-standard"], worktreePath));
  return [...new Set([...tracked, ...staged, ...untracked])];
}

function getCommittedFiles(baseSha: string, worktreePath: string): string[] {
  return splitGitLines(git(["diff", "--name-only", `${baseSha}..HEAD`], worktreePath));
}

function getCommitRange(baseSha: string, worktreePath: string): string[] {
  return splitGitLines(git(["log", "--reverse", "--format=%H", `${baseSha}..HEAD`], worktreePath));
}

function ensureScope(files: string[], task: TaskDefinition): string | undefined {
  const outside = files.filter((file) => !pathMatchesScope(file, task.writeScope));
  return outside.length > 0 ? `changed files outside writeScope: ${outside.join(", ")}` : undefined;
}

function commitUncommittedChanges(worktreePath: string, task: TaskDefinition, files: string[]): void {
  if (files.length === 0) return;
  const addResult = gitTry(["add", "--all", "--", ...files], worktreePath);
  if (!addResult.ok) throw new Error(`git add failed: ${addResult.error}`);
  const staged = gitTry(["diff", "--cached", "--name-only"], worktreePath);
  if (!staged.ok) throw new Error(`cannot inspect staged changes: ${staged.error}`);
  if (staged.output.trim() === "") return;
  const message = task.commitMessage ?? `chore: orchestrator task ${task.id}`;
  const commitResult = gitTry(["commit", "-m", message], worktreePath);
  if (!commitResult.ok) throw new Error(`git commit failed: ${commitResult.error}`);
}

function buildWorkerPrompt(context: RuntimeContext, task: TaskDefinition, baseSha: string): string {
  return [
    `You are the Codex worker for task '${task.id}' in orchestrator run '${context.state.runId}'.`,
    `Task: ${task.title}`,
    `Base commit: ${baseSha}`,
    `Write scope: ${task.writeScope.join(", ")}`,
    "Read AGENTS.md before changing code and follow its repository rules.",
    "Work only within the declared write scope. Do not push, deploy, modify secrets, or start a long-running server.",
    "Implement the task, run the requested verification commands when practical, and leave the worktree in a reviewable state.",
    "The orchestrator captures uncommitted changes and creates a commit, so do not reset or discard work.",
    "Task-specific instructions:",
    task.prompt,
  ].join("\n\n");
}

async function executeTask(context: RuntimeContext, task: TaskDefinition): Promise<TaskExecutionResult> {
  const taskState = context.state.tasks[task.id];
  const attempt = taskState.attempt + 1;
  taskState.attempt = attempt;
  taskState.status = "running";
  taskState.updatedAt = now();
  persistState(context);
  appendEvent(context, "task_started", { taskId: task.id, attempt });
  console.log(`[orchestrator] start ${task.id} attempt ${attempt}`);

  let worktree: { path: string; branch: string; baseSha: string };
  try {
    worktree = createTaskWorktree(context, task, attempt);
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      reason: formatError(error),
      baseSha: git(["rev-parse", "HEAD"], context.state.integrationPath),
      headSha: git(["rev-parse", "HEAD"], context.state.integrationPath),
      changedFiles: [],
      commits: [],
      worktreePath: "",
      resultPath: join(context.runDir, "tasks", task.id, `attempt-${attempt}`, "result.json"),
    };
  }

  const attemptDir = dirname(worktree.path);
  const resultPath = join(attemptDir, "result.json");
  const taskStateNow = context.state.tasks[task.id];
  taskStateNow.baseSha = worktree.baseSha;
  taskStateNow.worktreePath = worktree.path;
  taskStateNow.updatedAt = now();
  persistState(context);

  const setupCommands = [...context.plan.setup, ...task.setup];
  for (let index = 0; index < setupCommands.length; index += 1) {
    const command = setupCommands[index];
    const childKey = `${task.id}:setup:${index}`;
    const setupResult = await runShellLogged(
      command,
      worktree.path,
      join(attemptDir, `setup-${index + 1}.log`),
      task.timeoutMs ?? context.plan.timeoutMs,
      (child) => context.children.set(childKey, child),
    );
    context.children.delete(childKey);
    if (setupResult.code !== 0) {
      const result: TaskExecutionResult = {
        ok: false,
        retryable: true,
        reason: `setup command failed: ${command}`,
        baseSha: worktree.baseSha,
        headSha: worktree.baseSha,
        changedFiles: [],
        commits: [],
        worktreePath: worktree.path,
        resultPath,
      };
      writeJsonAtomic(resultPath, result);
      return result;
    }
  }

  const outputPath = join(attemptDir, "codex.events.jsonl");
  const errorPath = join(attemptDir, "codex.stderr.log");
  const lastMessagePath = join(attemptDir, "codex.last-message.txt");
  const codexArgs = [
    "--ask-for-approval",
    context.plan.approvalPolicy,
    "exec",
    "--cd",
    worktree.path,
    "--sandbox",
    "workspace-write",
    "--json",
    "--color",
    "never",
    "--output-last-message",
    lastMessagePath,
    buildWorkerPrompt(context, task, worktree.baseSha),
  ];
  const codexResult = await runLoggedProcess(
    context.plan.codexCommand,
    codexArgs,
    worktree.path,
    outputPath,
    errorPath,
    task.timeoutMs ?? context.plan.timeoutMs,
    (child) => {
      taskStateNow.pid = child.pid;
      context.children.set(task.id, child);
      taskStateNow.updatedAt = now();
      persistState(context);
    },
  );
  context.children.delete(task.id);
  delete taskStateNow.pid;
  taskStateNow.updatedAt = now();
  persistState(context);

  if (codexResult.code !== 0) {
    const reason = codexResult.timedOut
      ? `codex timed out after ${task.timeoutMs ?? context.plan.timeoutMs}ms`
      : `codex exited with code ${codexResult.code ?? "unknown"}${codexResult.signal ? ` (${codexResult.signal})` : ""}${codexResult.error ? `: ${codexResult.error}` : ""}`;
    const result: TaskExecutionResult = {
      ok: false,
      retryable: true,
      reason,
      baseSha: worktree.baseSha,
      headSha: git(["rev-parse", "HEAD"], worktree.path),
      changedFiles: [...new Set([...getCommittedFiles(worktree.baseSha, worktree.path), ...getUncommittedFiles(worktree.path)])],
      commits: getCommitRange(worktree.baseSha, worktree.path),
      worktreePath: worktree.path,
      resultPath,
    };
    writeJsonAtomic(resultPath, result);
    return result;
  }

  let changedFiles = [...new Set([...getCommittedFiles(worktree.baseSha, worktree.path), ...getUncommittedFiles(worktree.path)])];
  let scopeError = ensureScope(changedFiles, task);
  if (scopeError) {
    const result: TaskExecutionResult = {
      ok: false,
      retryable: false,
      reason: scopeError,
      baseSha: worktree.baseSha,
      headSha: git(["rev-parse", "HEAD"], worktree.path),
      changedFiles,
      commits: getCommitRange(worktree.baseSha, worktree.path),
      worktreePath: worktree.path,
      resultPath,
    };
    writeJsonAtomic(resultPath, result);
    return result;
  }

  for (let index = 0; index < task.verify.length; index += 1) {
    const command = task.verify[index];
    const childKey = `${task.id}:verify:${index}`;
    const verifyResult = await runShellLogged(
      command,
      worktree.path,
      join(attemptDir, `verify-${index + 1}.log`),
      task.timeoutMs ?? context.plan.timeoutMs,
      (child) => context.children.set(childKey, child),
    );
    context.children.delete(childKey);
    if (verifyResult.code !== 0) {
      const result: TaskExecutionResult = {
        ok: false,
        retryable: true,
        reason: `verification command failed: ${command}`,
        baseSha: worktree.baseSha,
        headSha: git(["rev-parse", "HEAD"], worktree.path),
        changedFiles: [...new Set([...getCommittedFiles(worktree.baseSha, worktree.path), ...getUncommittedFiles(worktree.path)])],
        commits: getCommitRange(worktree.baseSha, worktree.path),
        worktreePath: worktree.path,
        resultPath,
      };
      writeJsonAtomic(resultPath, result);
      return result;
    }
  }

  changedFiles = [...new Set([...getCommittedFiles(worktree.baseSha, worktree.path), ...getUncommittedFiles(worktree.path)])];
  scopeError = ensureScope(changedFiles, task);
  if (scopeError) {
    const result: TaskExecutionResult = {
      ok: false,
      retryable: false,
      reason: scopeError,
      baseSha: worktree.baseSha,
      headSha: git(["rev-parse", "HEAD"], worktree.path),
      changedFiles,
      commits: getCommitRange(worktree.baseSha, worktree.path),
      worktreePath: worktree.path,
      resultPath,
    };
    writeJsonAtomic(resultPath, result);
    return result;
  }

  try {
    commitUncommittedChanges(worktree.path, task, getUncommittedFiles(worktree.path));
  } catch (error) {
    const result: TaskExecutionResult = {
      ok: false,
      retryable: false,
      reason: formatError(error),
      baseSha: worktree.baseSha,
      headSha: git(["rev-parse", "HEAD"], worktree.path),
      changedFiles,
      commits: getCommitRange(worktree.baseSha, worktree.path),
      worktreePath: worktree.path,
      resultPath,
    };
    writeJsonAtomic(resultPath, result);
    return result;
  }

  const headSha = git(["rev-parse", "HEAD"], worktree.path);
  const commits = getCommitRange(worktree.baseSha, worktree.path);
  const result: TaskExecutionResult = {
    ok: true,
    retryable: false,
    baseSha: worktree.baseSha,
    headSha,
    changedFiles: getCommittedFiles(worktree.baseSha, worktree.path),
    commits,
    worktreePath: worktree.path,
    resultPath,
  };
  writeJsonAtomic(resultPath, result);
  return result;
}

function integrateTask(context: RuntimeContext, task: TaskDefinition, result: TaskExecutionResult): { ok: true; head: string } | { ok: false; error: string } {
  if (result.commits.length === 0) return { ok: true, head: git(["rev-parse", "HEAD"], context.state.integrationPath) };
  if (git(["status", "--porcelain"], context.state.integrationPath) !== "") return { ok: false, error: "integration worktree is not clean" };
  for (const commit of result.commits) {
    const cherryPick = gitTry(["cherry-pick", commit], context.state.integrationPath);
    if (!cherryPick.ok) {
      gitTry(["cherry-pick", "--abort"], context.state.integrationPath);
      return { ok: false, error: `cherry-pick conflict for ${task.id} at ${commit}: ${cherryPick.error}` };
    }
  }
  return { ok: true, head: git(["rev-parse", "HEAD"], context.state.integrationPath) };
}

function maxAttemptsFor(plan: OrchestratorPlan, task: TaskDefinition): number {
  return task.maxAttempts ?? plan.maxAttempts;
}

function markBlocked(context: RuntimeContext): void {
  const blocked = blockImpossibleTasks(context.plan, context.state);
  for (const taskId of blocked) {
    appendEvent(context, "task_blocked", { taskId, reason: context.state.tasks[taskId].lastError });
    console.log(`[orchestrator] blocked ${taskId}: ${context.state.tasks[taskId].lastError}`);
  }
  if (blocked.length > 0) persistState(context);
}

async function runScheduler(context: RuntimeContext): Promise<void> {
  const active = new Map<string, Promise<{ taskId: string; result: TaskExecutionResult }>>();
  const schedule = (): void => {
    markBlocked(context);
    for (const taskId of getReadyTaskIds(context.plan, context.state)) {
      if (active.size >= context.plan.maxConcurrency) break;
      if (active.has(taskId)) continue;
      const task = context.plan.tasks.find((entry) => entry.id === taskId)!;
      const promise = executeTask(context, task)
        .catch((error): TaskExecutionResult => ({
          ok: false,
          retryable: true,
          reason: formatError(error),
          baseSha: git(["rev-parse", "HEAD"], context.state.integrationPath),
          headSha: git(["rev-parse", "HEAD"], context.state.integrationPath),
          changedFiles: [],
          commits: [],
          worktreePath: "",
          resultPath: join(context.runDir, "tasks", taskId, "unexpected-result.json"),
        }))
        .then((result) => ({ taskId, result }));
      active.set(taskId, promise);
    }
  };

  while (true) {
    if (context.cancelled) break;
    schedule();
    if (active.size === 0) {
      markBlocked(context);
      const pending = Object.values(context.state.tasks).filter((task) => task.status === "pending");
      if (pending.length === 0) break;
      throw new Error(`scheduler deadlock; pending tasks: ${pending.map((task) => task.id).join(", ")}`);
    }

    const completed = await Promise.race(active.values());
    active.delete(completed.taskId);
    const taskState = context.state.tasks[completed.taskId];
    const task = context.plan.tasks.find((entry) => entry.id === completed.taskId)!;
    const result = completed.result;
    delete taskState.pid;
    taskState.baseSha = result.baseSha;
    taskState.headSha = result.headSha;
    taskState.candidateCommits = result.commits;
    taskState.worktreePath = result.worktreePath || taskState.worktreePath;
    taskState.resultPath = result.resultPath;
    taskState.lastError = result.reason;
    taskState.updatedAt = now();
    persistState(context);

    if (result.ok) {
      const integrated = integrateTask(context, task, result);
      if (integrated.ok) {
        taskState.status = "succeeded";
        taskState.integratedHead = integrated.head;
        taskState.lastError = undefined;
        appendEvent(context, "task_succeeded", { taskId: task.id, commits: result.commits, head: integrated.head });
        console.log(`[orchestrator] succeeded ${task.id}`);
      } else {
        taskState.status = "failed";
        taskState.lastError = `integration conflict: ${integrated.error}`;
        appendEvent(context, "task_failed", { taskId: task.id, retryable: false, reason: taskState.lastError });
        console.log(`[orchestrator] failed ${task.id}: ${taskState.lastError}`);
      }
    } else if (result.retryable && taskState.attempt < maxAttemptsFor(context.plan, task)) {
      taskState.status = "pending";
      appendEvent(context, "task_retrying", { taskId: task.id, attempt: taskState.attempt, nextAttempt: taskState.attempt + 1, reason: result.reason });
      console.log(`[orchestrator] retry ${task.id}: ${result.reason}`);
    } else {
      taskState.status = context.cancelled ? "cancelled" : "failed";
      appendEvent(context, "task_failed", { taskId: task.id, retryable: result.retryable, reason: result.reason });
      console.log(`[orchestrator] failed ${task.id}: ${result.reason}`);
    }
    taskState.updatedAt = now();
    persistState(context);
  }

  if (context.cancelled) {
    for (const taskState of Object.values(context.state.tasks)) {
      if (taskState.status === "pending" || taskState.status === "running") taskState.status = "cancelled";
    }
    context.state.status = "cancelled";
  } else {
    const failed = Object.values(context.state.tasks).some((task) => task.status === "failed" || task.status === "blocked");
    context.state.status = failed ? "failed" : "succeeded";
  }
  context.state.finishedAt = now();
  persistState(context);
}

function loadJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

function createNewContext(plan: OrchestratorPlan, planPath: string, repoRoot: string, maxConcurrency?: number): RuntimeContext {
  const runId = createRunId();
  const runDir = safeRunPath(repoRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const baseSha = git(["rev-parse", `${plan.baseRef}^{commit}`], repoRoot);
  const integrationBranch = `codex/orchestrator/${runId}/integration`;
  const state: RunState = {
    version: RUN_STATE_VERSION,
    runId,
    name: plan.name,
    repoRoot,
    planPath: resolve(planPath),
    baseRef: plan.baseRef,
    baseSha,
    integrationBranch,
    integrationPath: join(runDir, "integration"),
    status: "running",
    tasks: initializeTaskStates(plan),
    startedAt: now(),
    updatedAt: now(),
  };
  const effectivePlan = maxConcurrency === undefined ? plan : { ...plan, maxConcurrency };
  const context: RuntimeContext = { plan: effectivePlan, state, runDir, eventsPath: join(runDir, "events.jsonl"), cancelled: false, children: new Map() };
  writeJsonAtomic(join(runDir, "plan.json"), effectivePlan);
  writeJsonAtomic(join(runDir, "state.json"), state);
  writeFileSync(context.eventsPath, "", "utf8");
  appendEvent(context, "run_created", { baseRef: plan.baseRef, baseSha, maxConcurrency: effectivePlan.maxConcurrency });
  return context;
}

function recoverContext(runDir: string): RuntimeContext {
  const state = loadJson(join(runDir, "state.json")) as RunState;
  if (state.version !== RUN_STATE_VERSION) throw new Error(`unsupported run state version ${state.version}`);
  const plan = validatePlan(loadJson(join(runDir, "plan.json")));
  const context: RuntimeContext = { plan, state, runDir, eventsPath: join(runDir, "events.jsonl"), cancelled: false, children: new Map() };
  const gitDir = resolve(state.integrationPath, git(["rev-parse", "--git-dir"], state.integrationPath));
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) {
    gitTry(["cherry-pick", "--abort"], state.integrationPath);
    appendEvent(context, "recovery_aborted_cherry_pick");
  }
  for (const taskState of Object.values(state.tasks)) {
    if (taskState.status === "running") {
      if (isPidAlive(taskState.pid)) throw new Error(`task '${taskState.id}' still has a live worker pid ${taskState.pid}; stop it before resume`);
      delete taskState.pid;
      const task = plan.tasks.find((entry) => entry.id === taskState.id)!;
      if (taskState.candidateCommits?.length && taskState.candidateCommits.every((commit) => gitTry(["merge-base", "--is-ancestor", commit, state.integrationBranch], state.repoRoot).ok)) {
        taskState.status = "succeeded";
        taskState.integratedHead = git(["rev-parse", state.integrationBranch], state.repoRoot);
      } else if (taskState.attempt < maxAttemptsFor(plan, task)) {
        taskState.status = "pending";
        taskState.lastError = "coordinator resumed after interrupted worker";
      } else {
        taskState.status = "failed";
        taskState.lastError = "worker interrupted and retry budget exhausted";
      }
      taskState.updatedAt = now();
    } else if (taskState.status === "failed") {
      const task = plan.tasks.find((entry) => entry.id === taskState.id)!;
      if (taskState.attempt < maxAttemptsFor(plan, task)) taskState.status = "pending";
    } else if (taskState.status === "blocked") {
      taskState.status = "pending";
      taskState.lastError = undefined;
    }
  }
  state.status = "running";
  state.finishedAt = undefined;
  persistState(context);
  appendEvent(context, "run_resumed");
  return context;
}

function printDryRun(plan: OrchestratorPlan): void {
  const remaining = new Set(plan.tasks.map((task) => task.id));
  const done = new Set<string>();
  let wave = 0;
  console.log(`Plan: ${plan.name}`);
  console.log(`Base: ${plan.baseRef}`);
  console.log(`Concurrency: ${plan.maxConcurrency}`);
  while (remaining.size > 0) {
    const ready = plan.tasks.filter((task) => remaining.has(task.id) && task.dependsOn.every((dependency) => done.has(dependency)));
    if (ready.length === 0) throw new Error("cannot produce dry-run schedule; dependency graph is cyclic");
    wave += 1;
    console.log(`Wave ${wave}: ${ready.map((task) => task.id).join(", ")}`);
    for (const task of ready) {
      remaining.delete(task.id);
      done.add(task.id);
    }
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: "run", repoPath: process.cwd(), dryRun: false };
  let index = 0;
  if (argv[0] === "run" || argv[0] === "validate" || argv[0] === "help") {
    options.command = argv[0];
    index = 1;
  }
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--plan") options.planPath = argv[++index];
    else if (arg === "--resume") options.resumePath = argv[++index];
    else if (arg === "--repo") options.repoPath = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--max-concurrency") options.maxConcurrency = Number(argv[++index]);
    else throw new Error(`unknown argument '${arg}'`);
  }
  if (options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)) {
    throw new Error("--max-concurrency must be a positive integer");
  }
  return options;
}

function printHelp(): void {
  console.log(`Codex Orchestrate\n\nUsage:\n  node --experimental-strip-types <skill-root>/scripts/orchestrator.ts --repo <repo> --plan <plan.json>\n  node --experimental-strip-types <skill-root>/scripts/orchestrator.ts --repo <repo> --plan <plan.json> --dry-run\n  node --experimental-strip-types <skill-root>/scripts/orchestrator.ts validate --repo <repo> --plan <plan.json>\n  node --experimental-strip-types <skill-root>/scripts/orchestrator.ts --resume <run-dir>\n\nThe runner creates isolated worktrees, runs codex exec workers, validates scope,\ncherry-picks successful commits into a temporary integration branch, and never\npushes, deploys, or merges into a shared branch automatically.`);
}

async function run(options: CliOptions): Promise<number> {
  if (options.command === "help") {
    printHelp();
    return 0;
  }

  if (options.resumePath) {
    const runDir = resolve(options.resumePath);
    const releaseLock = acquireRunLock(runDir);
    try {
      const context = recoverContext(runDir);
      const onSignal = (): void => {
        context.cancelled = true;
        for (const child of context.children.values()) killProcessTree(child);
        appendEvent(context, "cancel_requested");
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        await runScheduler(context);
        console.log(`Run ${context.state.runId}: ${context.state.status}`);
        console.log(`Integration worktree: ${context.state.integrationPath}`);
        return context.state.status === "succeeded" ? 0 : 1;
      } catch (error) {
        context.state.status = "failed";
        context.state.finishedAt = now();
        appendEvent(context, "run_failed", { reason: formatError(error) });
        persistState(context);
        throw error;
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    } finally {
      releaseLock();
    }
  }

  if (!options.planPath) throw new Error("--plan is required unless --resume is used");
  const planPath = resolve(options.planPath);
  const plan = validatePlan(loadJson(planPath));
  if (options.command === "validate") {
    console.log(`Valid plan: ${plan.name} (${plan.tasks.length} tasks)`);
    return 0;
  }
  if (options.dryRun) {
    printDryRun(options.maxConcurrency === undefined ? plan : { ...plan, maxConcurrency: options.maxConcurrency });
    return 0;
  }

  const repoRoot = ensureGitRepo(options.repoPath);
  const codexCommand = resolveCommand(plan.codexCommand, repoRoot);
  validateCodex(codexCommand, repoRoot);
  const context = createNewContext({ ...plan, codexCommand }, planPath, repoRoot, options.maxConcurrency);
  const releaseLock = acquireRunLock(context.runDir);
  try {
    createIntegrationWorktree(context.state);
    appendEvent(context, "integration_worktree_created", { path: context.state.integrationPath });
    persistState(context);
    const baseStatus = git(["status", "--porcelain"], repoRoot);
    if (baseStatus !== "") appendEvent(context, "warning", { message: "base worktree has uncommitted changes; run uses baseRef commit only" });
    const onSignal = (): void => {
      context.cancelled = true;
      for (const child of context.children.values()) killProcessTree(child);
      appendEvent(context, "cancel_requested");
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      await runScheduler(context);
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    console.log(`Run ${context.state.runId}: ${context.state.status}`);
    console.log(`Integration branch: ${context.state.integrationBranch}`);
    console.log(`Integration worktree: ${context.state.integrationPath}`);
    console.log(`State: ${join(context.runDir, "state.json")}`);
    return context.state.status === "succeeded" ? 0 : 1;
  } catch (error) {
    context.state.status = "failed";
    context.state.finishedAt = now();
    appendEvent(context, "run_failed", { reason: formatError(error) });
    persistState(context);
    throw error;
  } finally {
    releaseLock();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    return await run(parseArgs(argv));
  } catch (error) {
    console.error(`orchestrator error: ${formatError(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
