import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { createRunPaths, listRunStatuses, readResult, writeResult, writeStatus } from "./files.ts";
import { createRunId } from "./ids.ts";
import { interruptProcess, type RunnerOverrides, startAgentRun } from "./runner.ts";
import { getResultOutput } from "./status.ts";
import { type BackgroundJob, emptyUsage, type RunStatus, type SingleResult } from "./types.ts";

const jobs = new Map<string, BackgroundJob>();

export function makeRunStatus(options: {
  id: string;
  mode?: "single";
  agentName: string;
  agentSource: AgentConfig["source"] | "unknown";
  description?: string;
  task: string;
  cwd: string;
  artifactDir: string;
  sessionFile: string;
}): RunStatus {
  const now = Date.now();
  return {
    id: options.id,
    mode: options.mode ?? "single",
    agent: options.agentName,
    agentSource: options.agentSource,
    description: options.description,
    task: options.task,
    cwd: options.cwd,
    state: "queued",
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    exitCode: null,
    stopReason: null,
    errorMessage: null,
    pid: null,
    sessionFile: options.sessionFile,
    artifactDir: options.artifactDir,
    usage: emptyUsage(),
  };
}

export async function createForegroundStatus(options: {
  cwd: string;
  agent: AgentConfig;
  task: string;
  description?: string;
}): Promise<{ id: string; status: RunStatus; paths: Awaited<ReturnType<typeof createRunPaths>> }> {
  const id = createRunId();
  const paths = await createRunPaths(options.cwd, id);
  const status = makeRunStatus({
    id,
    agentName: options.agent.name,
    agentSource: options.agent.source,
    description: options.description,
    task: options.task,
    cwd: options.cwd,
    artifactDir: paths.artifactDir,
    sessionFile: paths.sessionFile,
  });
  await writeStatus(status);
  return { id, status, paths };
}

export async function startBackgroundRun(options: {
  defaultCwd: string;
  agent: AgentConfig;
  task: string;
  cwd?: string;
  description?: string;
  overrides?: RunnerOverrides;
  onComplete?: (status: RunStatus, result: SingleResult) => void;
}): Promise<RunStatus> {
  const runCwd = options.cwd ?? options.defaultCwd;
  const id = createRunId();
  const paths = await createRunPaths(runCwd, id);
  const status = makeRunStatus({
    id,
    agentName: options.agent.name,
    agentSource: options.agent.source,
    description: options.description,
    task: options.task,
    cwd: runCwd,
    artifactDir: paths.artifactDir,
    sessionFile: paths.sessionFile,
  });
  await writeStatus(status);
  const started = await startAgentRun({
    id,
    defaultCwd: options.defaultCwd,
    agent: options.agent,
    task: options.task,
    cwd: options.cwd,
    paths,
    status,
    overrides: options.overrides,
  });
  const job: BackgroundJob = { id, proc: started.proc, status, result: started.result, artifactDir: paths.artifactDir };
  jobs.set(id, job);
  void started.done.then((result) => {
    jobs.delete(id);
    options.onComplete?.(status, result);
  });
  return status;
}

export async function listStatuses(cwd: string): Promise<RunStatus[]> {
  const fromDisk = await listRunStatuses(cwd);
  const byId = new Map(fromDisk.map((status) => [status.id, status]));
  for (const job of jobs.values()) byId.set(job.id, job.status);
  return Array.from(byId.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export async function getStatus(cwd: string, id: string): Promise<RunStatus | null> {
  const job = jobs.get(id);
  if (job) return job.status;
  const status = (await listStatuses(cwd)).find((candidate) => candidate.id === id) ?? null;
  if (status?.state === "running") return { ...status, pid: null };
  return status;
}

export async function getResult(cwd: string, id: string): Promise<{ status: RunStatus; output: string } | null> {
  const status = await getStatus(cwd, id);
  if (!status) return null;
  const job = jobs.get(id);
  if (job) return { status, output: getResultOutput(job.result) };
  return { status, output: await readResult(status.artifactDir) };
}

export async function interruptRun(cwd: string, id: string): Promise<RunStatus | null> {
  const job = jobs.get(id);
  if (!job) {
    const status = await getStatus(cwd, id);
    if (status?.state === "running") {
      return { ...status, pid: null, errorMessage: "Cannot interrupt stale run from this Pi process." };
    }
    return status;
  }

  job.status.state = "interrupted";
  job.status.stopReason = "interrupted";
  job.status.updatedAt = Date.now();
  job.status.completedAt = job.status.completedAt ?? job.status.updatedAt;
  await writeStatus(job.status);
  await writeResult(job.artifactDir, getResultOutput(job.result));
  interruptProcess(job.proc);
  return job.status;
}

export async function notifyCompletion(pi: ExtensionAPI, status: RunStatus, result: SingleResult): Promise<void> {
  const text = `Subagent ${status.id} ${status.state}: ${status.agent}\n${getResultOutput(result).split("\n").slice(0, 8).join("\n")}`;
  const maybePi = pi as ExtensionAPI & { sendMessage?: (message: string, options?: { deliverAs?: string }) => void | Promise<void> };
  if (typeof maybePi.sendMessage === "function") {
    await maybePi.sendMessage(text, { deliverAs: "followUp" });
  }
}
