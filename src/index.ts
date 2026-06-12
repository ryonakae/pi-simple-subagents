import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";

const CHILD_ENV = "PI_THIN_SUBAGENTS_CHILD";
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_CAP_BYTES = 50 * 1024;
const SUBAGENT_TOOL_NAMES = ["subagent", "Agent", "get_subagent_result", "steer_subagent"];

type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type SingleResult = {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
};

type SubagentDetails = {
  mode: "single" | "parallel" | "chain" | "list";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: SubagentDetails;
};

type OnUpdateCallback = (partial: ToolResult) => void;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

function truncateForParent(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= OUTPUT_CAP_BYTES) return output;

  let truncated = output.slice(0, OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated for parent context. Full output is preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

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

function buildPiArgs(agent: AgentConfig, task: string): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  return (async () => {
    const args = ["--mode", "json", "-p", "--no-session"];

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
  })();
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
      details: makeDetails([currentResult]),
    });
  };

  const { args, cleanup } = await buildPiArgs(agent, task);
  let wasAborted = false;

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [CHILD_ENV]: "1" },
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          currentResult.messages.push(message);

          if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) currentResult.stopReason = "aborted";
    return currentResult;
  } finally {
    await cleanup();
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local .pi/agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  action: Type.Optional(
    StringEnum(["run", "list"] as const, {
      description: 'Use "list" to list available agents. Default: "run".',
      default: "run",
    }),
  ),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] === "1") return;

  pi.registerCommand("subagents", {
    description: "List available subagents",
    handler: async (args, ctx) => {
      const scope = args.trim() === "project" || args.trim() === "both" ? (args.trim() as AgentScope) : "user";
      const discovery = discoverAgents(ctx.cwd, scope);
      ctx.ui.notify(formatAgentList(discovery.agents), "info");
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to user-defined subagents with isolated Pi contexts.",
      "Use action=list to discover available agents before choosing one.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
      "Default agent scope is user: built-in general-purpose plus ~/.pi/agent/agents/*.md.",
      'Set agentScope="both" to include trusted project-local .pi/agents/*.md.',
      "Agent files can set model/tools/thinking, but omitted model means the child uses the current Pi default instead of a hard-coded Haiku model.",
    ].join(" "),
    promptSnippet: "subagent: delegate complex or independent work to isolated user-defined agents",
    promptGuidelines: [
      "Use subagent for complex investigation, parallel review, or isolated work that benefits from a separate context window.",
      "Use subagent with action=list when you need to discover available subagent names.",
      "Use the general-purpose subagent when no specialized subagent fits the task.",
    ],
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope);
      const agents = discovery.agents;

      const makeDetails =
        (mode: SubagentDetails["mode"]) =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentScope,
          projectAgentsDir: discovery.projectAgentsDir,
          results,
        });

      if (params.action === "list") {
        return {
          content: [{ type: "text", text: formatAgentList(agents) }],
          details: makeDetails("list")([]),
        };
      }

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Provide exactly one mode.\nAvailable agents:\n${formatAgentList(agents)}`,
            },
          ],
          details: makeDetails("single")([]),
        };
      }

      const confirmProjectAgents = params.confirmProjectAgents ?? true;
      if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
        const requestedAgentNames = new Set<string>();
        if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
        if (params.tasks) for (const task of params.tasks) requestedAgentNames.add(task.agent);
        if (params.agent) requestedAgentNames.add(params.agent);

        const projectAgentsRequested = Array.from(requestedAgentNames)
          .map((name) => agents.find((agent) => agent.name === name))
          .filter((agent): agent is AgentConfig => agent?.source === "project");

        if (projectAgentsRequested.length > 0) {
          const names = projectAgentsRequested.map((agent) => agent.name).join(", ");
          const ok = await ctx.ui.confirm(
            "Run project-local subagents?",
            `Agents: ${names}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local subagents were not approved." }],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            };
          }
        }
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (!currentResult) return;
                onUpdate({ content: partial.content, details: makeDetails("chain")([...results, currentResult]) });
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          if (isFailedResult(result)) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
              details: makeDetails("chain")(results),
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }

        return {
          content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([]),
          };
        }

        const allResults: SingleResult[] = params.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown",
          task: task.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        }));

        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const running = allResults.filter((result) => result.exitCode === -1).length;
          const done = allResults.length - running;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            task.agent,
            task.task,
            task.cwd,
            undefined,
            signal,
            (partial) => {
              if (!partial.details?.results[0]) return;
              allResults[index] = partial.details.results[0];
              emitParallelUpdate();
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((result) => !isFailedResult(result)).length;
        const summaries = results.map((result) => {
          const status = isFailedResult(result) ? "failed" : "completed";
          return `### [${result.agent}] ${status}\n\n${truncateForParent(getResultOutput(result))}`;
        });

        return {
          content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        if (isFailedResult(result)) {
          return {
            content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
            details: makeDetails("single")([result]),
          };
        }
        return {
          content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result]),
        };
      }

      return {
        content: [{ type: "text", text: `Invalid parameters.\nAvailable agents:\n${formatAgentList(agents)}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme) {
      const scope: AgentScope = args.agentScope ?? "user";
      if (args.action === "list") {
        return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", "list") + theme.fg("muted", ` [${scope}]`), 0, 0);
      }
      if (args.chain && args.chain.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length})`) + theme.fg("muted", ` [${scope}]`);
        for (const [index, step] of args.chain.slice(0, 3).entries()) {
          const preview = step.task.replace(/\{previous\}/g, "").trim();
          text += `\n  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", preview.slice(0, 50))}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length})`) + theme.fg("muted", ` [${scope}]`);
        for (const task of args.tasks.slice(0, 3)) {
          text += `\n  ${theme.fg("accent", task.agent)} ${theme.fg("dim", task.task.slice(0, 50))}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const agentName = args.agent || "...";
      const preview = args.task ? args.task.slice(0, 80) : "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`) + `\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const first = result.content[0];
        return new Text(first?.text ?? "(no output)", 0, 0);
      }

      const lines: string[] = [];
      for (const item of details.results) {
        const running = item.exitCode === -1;
        const failed = !running && isFailedResult(item);
        const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(item.agent))}${theme.fg("muted", ` (${item.agentSource})`)}`);
        const output = getResultOutput(item);
        const visibleOutput = expanded ? output : output.split("\n").slice(0, 8).join("\n");
        if (visibleOutput) lines.push(theme.fg(failed ? "error" : "toolOutput", visibleOutput));
        const usage = formatUsageStats(item.usage, item.model);
        if (usage) lines.push(theme.fg("dim", usage));
        if (!expanded && output.split("\n").length > 8) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
        lines.push("");
      }

      return new Text(lines.join("\n").trimEnd(), 0, 0);
    },
  });
}
