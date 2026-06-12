import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentList } from "./agents.ts";
import { writeStatus } from "./files.ts";
import { createForegroundStatus, getResult, getStatus, interruptRun, listStatuses, notifyCompletion, startBackgroundRun } from "./jobs.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { type RunnerOverrides, startAgentRun } from "./runner.ts";
import { AgentAliasParams, GetSubagentResultParams, normalizeAgentAliasParams, normalizeSubagentParams, SteerSubagentParams, SubagentParams } from "./schemas.ts";
import { formatDetailedStatus, formatStatusList, formatStoredResult, getFinalOutput, getResultOutput, isFailedResult } from "./status.ts";
import { CHILD_ENV, emptyUsage, type OnUpdateCallback, type RunRequest, type SingleResult, type SubagentDetails, type ToolResult } from "./types.ts";

function unknownAgentResult(agentName: string, task: string, agents: AgentConfig[], step?: number): SingleResult {
  const available = agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
  return {
    agent: agentName,
    agentSource: "unknown",
    task,
    exitCode: 1,
    messages: [],
    stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
    usage: emptyUsage(),
    step,
  };
}

function requestedAgentNames(run: RunRequest): string[] {
  return [run.agent];
}

async function confirmProjectAgentsIfNeeded(options: {
  run: RunRequest;
  agentScope: AgentScope;
  confirmProjectAgents: boolean;
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  ctx: any;
}): Promise<boolean> {
  if (!(options.agentScope === "project" || options.agentScope === "both") || !options.confirmProjectAgents || !options.ctx.hasUI) return true;

  const names = new Set(requestedAgentNames(options.run));
  const projectAgentsRequested = Array.from(names)
    .map((name) => options.agents.find((agent) => agent.name === name))
    .filter((agent): agent is AgentConfig => agent?.source === "project");

  if (projectAgentsRequested.length === 0) return true;

  const agentNames = projectAgentsRequested.map((agent) => agent.name).join(", ");
  return await options.ctx.ui.confirm(
    "Run project-local subagents?",
    `Agents: ${agentNames}\nSource: ${options.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled prompts. Only continue for trusted repositories.`,
  );
}

async function runForegroundSingle(options: {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
  description?: string;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  overrides?: RunnerOverrides;
  sessionFile?: string;
}): Promise<SingleResult> {
  const agent = options.agents.find((candidate) => candidate.name === options.agentName);
  if (!agent) return unknownAgentResult(options.agentName, options.task, options.agents, options.step);

  const runCwd = options.cwd ?? options.defaultCwd;
  const foreground = await createForegroundStatus({ cwd: runCwd, agent, task: options.task, description: options.description });
  if (options.sessionFile) {
    foreground.paths.sessionFile = options.sessionFile;
    foreground.status.sessionFile = options.sessionFile;
    await writeStatus(foreground.status);
  }

  const started = await startAgentRun({
    id: foreground.id,
    defaultCwd: options.defaultCwd,
    agent,
    task: options.task,
    cwd: options.cwd,
    step: options.step,
    signal: options.signal,
    onUpdate: options.onUpdate,
    makeDetails: options.makeDetails,
    paths: foreground.paths,
    status: foreground.status,
    overrides: options.overrides,
  });
  return await started.done;
}

async function handleManagement(options: {
  pi: ExtensionAPI;
  management: { action: "list" | "status" | "result" | "interrupt" | "resume"; id?: string; message?: string; verbose?: boolean };
  ctx: any;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  agentScope: AgentScope;
  discovery: ReturnType<typeof discoverAgents>;
  makeDetails: (mode: SubagentDetails["mode"], jobs?: any[]) => (results: SingleResult[]) => SubagentDetails;
}): Promise<ToolResult> {
  const { management, ctx, discovery, makeDetails } = options;
  if (management.action === "list") {
    return { content: [{ type: "text", text: formatAgentList(discovery.agents) }], details: makeDetails("list")([]) };
  }

  if (management.action === "status") {
    if (management.id) {
      const status = await getStatus(ctx.cwd, management.id);
      if (!status) return { content: [{ type: "text", text: `Subagent run not found: ${management.id}` }], details: makeDetails("status")([]) };
      return { content: [{ type: "text", text: formatDetailedStatus(status) }], details: makeDetails("status", [status])([]) };
    }
    const statuses = await listStatuses(ctx.cwd);
    return { content: [{ type: "text", text: formatStatusList(statuses) }], details: makeDetails("status", statuses)([]) };
  }

  if (management.action === "result") {
    if (!management.id) return { content: [{ type: "text", text: "result requires id." }], details: makeDetails("result")([]) };
    const result = await getResult(ctx.cwd, management.id);
    if (!result) return { content: [{ type: "text", text: `Subagent run not found: ${management.id}` }], details: makeDetails("result")([]) };
    return { content: [{ type: "text", text: formatStoredResult(result.status, result.output, management.verbose) }], details: makeDetails("result", [result.status])([]) };
  }

  if (management.action === "interrupt") {
    if (!management.id) return { content: [{ type: "text", text: "interrupt requires id." }], details: makeDetails("interrupt")([]) };
    const status = await interruptRun(ctx.cwd, management.id);
    if (!status) return { content: [{ type: "text", text: `Subagent run not found: ${management.id}` }], details: makeDetails("interrupt")([]) };
    return { content: [{ type: "text", text: formatDetailedStatus(status) }], details: makeDetails("interrupt", [status])([]) };
  }

  if (!management.id || !management.message) {
    return { content: [{ type: "text", text: "resume requires id and message." }], details: makeDetails("resume")([]) };
  }
  const previous = await getStatus(ctx.cwd, management.id);
  if (!previous) return { content: [{ type: "text", text: `Subagent run not found: ${management.id}` }], details: makeDetails("resume")([]) };
  if (!previous.sessionFile) {
    return { content: [{ type: "text", text: `Cannot resume ${management.id}: no child session file was recorded.` }], details: makeDetails("resume", [previous])([]) };
  }

  const result = await runForegroundSingle({
    defaultCwd: ctx.cwd,
    agents: discovery.agents,
    agentName: previous.agent,
    task: management.message,
    cwd: previous.cwd,
    description: `resume ${management.id}`,
    signal: options.signal,
    onUpdate: options.onUpdate,
    makeDetails: makeDetails("resume"),
    sessionFile: previous.sessionFile,
  });
  return { content: [{ type: "text", text: getResultOutput(result) }], details: makeDetails("resume")([result]) };
}

async function handleRun(options: {
  pi: ExtensionAPI;
  run: RunRequest;
  ctx: any;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  agents: AgentConfig[];
  makeDetails: (mode: SubagentDetails["mode"], jobs?: any[]) => (results: SingleResult[]) => SubagentDetails;
}): Promise<ToolResult> {
  const { run, ctx, agents, makeDetails } = options;
  if (run.inheritContext) {
    return {
      content: [{ type: "text", text: "inherit_context is not supported yet. It will be added after Pi session fork support is verified." }],
      details: makeDetails("single")([]),
    };
  }

  const agent = agents.find((candidate) => candidate.name === run.agent);
  if (!agent) {
    const result = unknownAgentResult(run.agent, run.task, agents);
    return { content: [{ type: "text", text: getResultOutput(result) }], details: makeDetails("single")([result]) };
  }

  const runInBackground = run.runInBackground ?? agent.runInBackground ?? false;
  const overrides = { model: run.model, thinking: run.thinking };
  if (runInBackground) {
    const status = await startBackgroundRun({
      defaultCwd: ctx.cwd,
      agent,
      task: run.task,
      cwd: run.cwd,
      description: run.description,
      overrides,
      onComplete: (completedStatus, result) => {
        if (ctx.hasUI) ctx.ui.notify(`Subagent ${completedStatus.id} ${completedStatus.state}: ${completedStatus.agent}`, completedStatus.state === "failed" ? "error" : "info");
        void notifyCompletion(options.pi, completedStatus, result).catch(() => undefined);
      },
    });
    return {
      content: [
        {
          type: "text",
          text: `Started background subagent ${agent.name}: ${status.id}\nUse subagent({ action: "status", id: "${status.id}" }) to check progress.`,
        },
      ],
      details: makeDetails("single", [status])([]),
    };
  }

  const result = await runForegroundSingle({
    defaultCwd: ctx.cwd,
    agents,
    agentName: run.agent,
    task: run.task,
    cwd: run.cwd,
    description: run.description,
    signal: options.signal,
    onUpdate: options.onUpdate,
    makeDetails: makeDetails("single"),
    overrides,
  });
  if (isFailedResult(result)) {
    return { content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }], details: makeDetails("single")([result]) };
  }
  return { content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }], details: makeDetails("single")([result]) };
}

async function handleSubagentTool(pi: ExtensionAPI, params: any, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined, ctx: any): Promise<ToolResult> {
  const agentScope: AgentScope = params.agentScope ?? "user";
  const discovery = discoverAgents(ctx.cwd, agentScope);
  const makeDetails =
    (mode: SubagentDetails["mode"], jobs?: any[]) =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      agentScope,
      projectAgentsDir: discovery.projectAgentsDir,
      results,
      jobs,
    });

  let normalized: ReturnType<typeof normalizeSubagentParams>;
  try {
    normalized = normalizeSubagentParams(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `${message}\nAvailable agents:\n${formatAgentList(discovery.agents)}` }], details: makeDetails("single")([]) };
  }

  if (normalized.kind === "management") {
    return await handleManagement({ pi, management: normalized.management, ctx, signal, onUpdate, agentScope, discovery, makeDetails });
  }

  const ok = await confirmProjectAgentsIfNeeded({
    run: normalized.run,
    agentScope,
    confirmProjectAgents: params.confirmProjectAgents ?? true,
    agents: discovery.agents,
    projectAgentsDir: discovery.projectAgentsDir,
    ctx,
  });
  if (!ok) {
    return { content: [{ type: "text", text: "Canceled: project-local subagents were not approved." }], details: makeDetails(normalized.run.mode)([]) };
  }

  return await handleRun({ pi, run: normalized.run, ctx, signal, onUpdate, agents: discovery.agents, makeDetails });
}

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
      "Reference-style: pass subagent_type and prompt.",
      "Use action=list/status/result/interrupt/resume to manage runs.",
      "Run API is reference-style only; pass subagent_type and prompt.",
      "Default agent scope is user: built-in general-purpose plus ~/.pi/agent/agents/*.md.",
      'Set agentScope="both" to include trusted project-local .pi/agents/*.md.',
    ].join(" "),
    promptSnippet: "subagent: delegate complex or independent work to isolated user-defined agents",
    promptGuidelines: [
      "Use subagent for complex investigation, parallel review, or isolated work that benefits from a separate context window.",
      "Use subagent with action=list when you need to discover available subagent names.",
      "Use subagent({ subagent_type, prompt }) for reference-style single delegation.",
      "Use run_in_background for long-running investigation, then action=status/result to check it.",
    ],
    parameters: SubagentParams,
    execute: (_toolCallId, params, signal, onUpdate, ctx) => handleSubagentTool(pi, params, signal, onUpdate, ctx),
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Compatibility alias for subagent reference-style runs. Pass subagent_type and prompt.",
    parameters: AgentAliasParams,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      const normalized = normalizeAgentAliasParams(params);
      if (normalized.kind !== "run") throw new Error("Agent alias only supports run parameters.");
      return await handleSubagentTool(pi, { ...params, action: "run" }, signal, onUpdate, ctx);
    },
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description: "Compatibility alias for subagent({ action: \"result\" }).",
    parameters: GetSubagentResultParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const result = await getResult(ctx.cwd, params.id);
      const details: SubagentDetails = { mode: "result", agentScope: "user", projectAgentsDir: null, results: [], jobs: result ? [result.status] : [] };
      if (!result) return { content: [{ type: "text", text: `Subagent run not found: ${params.id}` }], details };
      return { content: [{ type: "text", text: formatStoredResult(result.status, result.output, params.verbose) }], details };
    },
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Subagent",
    description: "Reserved compatibility tool. Live steering is not available yet.",
    parameters: SteerSubagentParams,
    execute: async () => ({
      content: [
        {
          type: "text",
          text: 'steer_subagent is not available yet. Use subagent({ action: "resume" }) after completion, or interrupt and restart.',
        },
      ],
      details: { mode: "status", agentScope: "user", projectAgentsDir: null, results: [] },
    }),
  });
}
