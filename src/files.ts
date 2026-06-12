import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RunStatus } from "./types.ts";

export type RunPaths = {
  artifactDir: string;
  statusFile: string;
  eventsFile: string;
  stdoutFile: string;
  stderrFile: string;
  resultFile: string;
  sessionFile: string;
};

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function createRunPaths(cwd: string, id: string): Promise<RunPaths> {
  const projectDir = path.join(cwd, ".pi", "subagents", "runs", id);
  try {
    await ensureDir(projectDir);
    return makePaths(projectDir);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Operation not permitted")) throw error;
  }

  const fallbackDir = path.join(getAgentDir(), "subagents", fnv1a(cwd), "runs", id);
  await ensureDir(fallbackDir);
  return makePaths(fallbackDir);
}

function makePaths(artifactDir: string): RunPaths {
  return {
    artifactDir,
    statusFile: path.join(artifactDir, "status.json"),
    eventsFile: path.join(artifactDir, "events.jsonl"),
    stdoutFile: path.join(artifactDir, "stdout.jsonl"),
    stderrFile: path.join(artifactDir, "stderr.log"),
    resultFile: path.join(artifactDir, "result.md"),
    sessionFile: path.join(artifactDir, "session.jsonl"),
  };
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

export async function writeStatus(status: RunStatus): Promise<void> {
  await writeJsonAtomic(path.join(status.artifactDir, "status.json"), status);
}

export async function readStatusFile(filePath: string): Promise<RunStatus | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as RunStatus;
  } catch {
    return null;
  }
}

export async function appendFile(filePath: string, text: string): Promise<void> {
  await fs.appendFile(filePath, text, { encoding: "utf-8", mode: 0o600 });
}

export async function writeResult(artifactDir: string, output: string): Promise<void> {
  await fs.writeFile(path.join(artifactDir, "result.md"), output, { encoding: "utf-8", mode: 0o600 });
}

export async function readResult(artifactDir: string): Promise<string> {
  try {
    return await fs.readFile(path.join(artifactDir, "result.md"), "utf-8");
  } catch {
    return "";
  }
}

export async function listRunStatuses(cwd: string): Promise<RunStatus[]> {
  const dirs = [path.join(cwd, ".pi", "subagents", "runs"), path.join(getAgentDir(), "subagents", fnv1a(cwd), "runs")];
  const statuses: RunStatus[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const status = await readStatusFile(path.join(dir, entry, "status.json"));
      if (status) statuses.push(status);
    }
  }
  statuses.sort((a, b) => b.startedAt - a.startedAt);
  return statuses;
}
