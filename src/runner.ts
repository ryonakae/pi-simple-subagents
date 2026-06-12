import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { appendFile, type RunPaths, writeResult, writeStatus } from "./files.ts";
import { getFinalOutput } from "./status.ts";
import { CHILD_ENV, emptyUsage, type OnUpdateCallback, type RunStatus, type SingleResult, SUBAGENT_TOOL_NAMES, type SubagentDetails } from "./types.ts";

export type RunnerOverrides = {
  model?: string;
  thinking?: string;
};

export type StartedAgentRun = {
  proc: ChildProcess;
  result: SingleResult;
  done: Promise<SingleResult>;
};

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-thin-subagents-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `${safeName}.md`);
  await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };

  return { command: "pi", args };
}

function shouldExcludeNestedTools(agent: AgentConfig): boolean {
  const tools = new Set((agent.tools ?? []).map((tool) => tool.toLowerCase()));
  return !SUBAGENT_TOOL_NAMES.some((tool) => tools.has(tool.toLowerCase()));
}

function withOverrides(agent: AgentConfig, overrides?: RunnerOverrides): AgentConfig {
  return {
    ...agent,
    model: agent.model || overrides?.model,
    thinking: agent.thinking || overrides?.thinking,
  };
}

export async function buildPiArgs(
  originalAgent: AgentConfig,
  task: string,
  sessionFile: string,
  overrides?: RunnerOverrides,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const agent = withOverrides(originalAgent, overrides);
  const args = ["--mode", "json", "-p", "--session", sessionFile];

  if (agent.extensions === false) args.push("--no-extensions");
  if (agent.skills === false) args.push("--no-skills");
  if (agent.contextFiles === false) args.push("--no-context-files");
  if (agent.model) args.push("--model", agent.model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  const excludeTools = new Set(agent.excludeTools ?? []);
  if (shouldExcludeNestedTools(agent)) {
    for (const tool of SUBAGENT_TOOL_NAMES) excludeTools.add(tool);
  }
  if (excludeTools.size > 0) args.push("--exclude-tools", Array.from(excludeTools).join(","));

  let tmpDir: string | null = null;
  let tmpPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    tmpDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    args.push(agent.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt", tmpPromptPath);
  }

  args.push(`Task: ${task}`);

  return {
    args,
    cleanup: async () => {
      if (tmpPromptPath) {
        try {
          await fs.unlink(tmpPromptPath);
        } catch {
          // 一時ファイルの削除失敗は本処理の結果より重要ではない。
        }
      }
      if (tmpDir) {
        try {
          await fs.rmdir(tmpDir);
        } catch {
          // 一時ディレクトリの削除失敗は本処理の結果より重要ではない。
        }
      }
    },
  };
}

function updateResultFromEvent(result: SingleResult, event: any): boolean {
  if (event.type === "message_end" && event.message) {
    const message = event.message as Message;
    result.messages.push(message);

    if (message.role === "assistant") {
      result.usage.turns++;
      const usage = message.usage;
      if (usage) {
        result.usage.input += usage.input || 0;
        result.usage.output += usage.output || 0;
        result.usage.cacheRead += usage.cacheRead || 0;
        result.usage.cacheWrite += usage.cacheWrite || 0;
        result.usage.cost += usage.cost?.total || 0;
        result.usage.contextTokens = usage.totalTokens || 0;
      }
      if (!result.model && message.model) result.model = message.model;
      if (message.stopReason) result.stopReason = message.stopReason;
      if (message.errorMessage) result.errorMessage = message.errorMessage;
    }
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    result.messages.push(event.message as Message);
    return true;
  }

  return false;
}

export async function startAgentRun(options: {
  id: string;
  defaultCwd: string;
  agent: AgentConfig;
  task: string;
  cwd?: string;
  step?: number;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails?: (results: SingleResult[]) => SubagentDetails;
  paths: RunPaths;
  status?: RunStatus;
  overrides?: RunnerOverrides;
}): Promise<StartedAgentRun> {
  const effectiveAgent = withOverrides(options.agent, options.overrides);
  const result: SingleResult = {
    id: options.id,
    agent: options.agent.name,
    agentSource: options.agent.source,
    task: options.task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: effectiveAgent.model,
    step: options.step,
    sessionFile: options.paths.sessionFile,
    artifactDir: options.paths.artifactDir,
  };

  const emitUpdate = () => {
    if (!options.onUpdate || !options.makeDetails) return;
    options.onUpdate({
      content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
      details: options.makeDetails([result]),
    });
  };

  const { args, cleanup } = await buildPiArgs(options.agent, options.task, options.paths.sessionFile, options.overrides);
  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd: options.cwd ?? options.defaultCwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, [CHILD_ENV]: "1" },
  });

  if (options.status) {
    options.status.pid = proc.pid ?? null;
    options.status.state = "running";
    options.status.updatedAt = Date.now();
    void writeStatus(options.status);
  }

  let buffer = "";
  let wasAborted = false;
  let wasInterrupted = false;

  const processLine = (line: string) => {
    if (!line.trim()) return;
    void appendFile(options.paths.stdoutFile, `${line}\n`);
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    void appendFile(options.paths.eventsFile, `${JSON.stringify(event)}\n`);
    if (updateResultFromEvent(result, event)) emitUpdate();
  };

  const done = new Promise<SingleResult>((resolve) => {
    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      result.stderr += text;
      void appendFile(options.paths.stderrFile, text);
    });

    proc.on("close", (code, signal) => {
      if (buffer.trim()) processLine(buffer);
      result.exitCode = code ?? (signal ? 1 : 0);
      if (options.status?.state === "interrupted") wasInterrupted = true;
      if (wasAborted) result.stopReason = "aborted";
      if (wasInterrupted) result.stopReason = "interrupted";
      void cleanup();
      const output = getFinalOutput(result.messages) || result.errorMessage || result.stderr || "";
      void writeResult(options.paths.artifactDir, output);
      if (options.status) {
        options.status.exitCode = result.exitCode;
        options.status.stopReason = result.stopReason ?? null;
        options.status.errorMessage = result.errorMessage ?? null;
        options.status.usage = result.usage;
        options.status.pid = null;
        options.status.completedAt = Date.now();
        options.status.updatedAt = options.status.completedAt;
        if (wasInterrupted) options.status.state = "interrupted";
        else if (wasAborted) options.status.state = "aborted";
        else options.status.state = result.exitCode === 0 && result.stopReason !== "error" ? "completed" : "failed";
        void writeStatus(options.status);
      }
      resolve(result);
    });

    proc.on("error", (error) => {
      result.exitCode = 1;
      result.errorMessage = error.message;
    });
  });

  const terminate = (interrupted: boolean) => {
    if (interrupted) wasInterrupted = true;
    else wasAborted = true;
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 5000);
  };

  if (options.signal) {
    if (options.signal.aborted) terminate(false);
    else options.signal.addEventListener("abort", () => terminate(false), { once: true });
  }

  return { proc, result, done };
}

export function interruptProcess(proc: ChildProcess): void {
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }, 5000);
}
