import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentScope } from "./agents.ts";
import type { ManagementRequest, NormalizedRequest, RunRequest } from "./types.ts";

const TaskItemSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItemSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local .pi/agents.',
  default: "user",
});

export const SubagentParams = Type.Object({
  action: Type.Optional(
    StringEnum(["run", "list", "status", "result", "interrupt", "resume"] as const, {
      description: 'Run or manage subagents. Default: "run".',
      default: "run",
    }),
  ),
  subagent_type: Type.Optional(Type.String({ description: "Reference-style agent name" })),
  prompt: Type.Optional(Type.String({ description: "Reference-style delegated task" })),
  description: Type.Optional(Type.String({ description: "Short description for UI/status" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Start the subagent in the background" })),
  inherit_context: Type.Optional(Type.Boolean({ description: "Reserved for parent conversation fork. Currently unsupported." })),
  context: Type.Optional(Type.String({ description: 'Reserved context mode, e.g. "fork". Currently unsupported.' })),
  resume: Type.Optional(Type.String({ description: "Run/session id to resume" })),
  model: Type.Optional(Type.String({ description: "Temporary model override when agent frontmatter omits model" })),
  thinking: Type.Optional(Type.String({ description: "Temporary thinking override when agent frontmatter omits thinking" })),
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItemSchema, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItemSchema, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  id: Type.Optional(Type.String({ description: "Run id for status/result/interrupt/resume" })),
  message: Type.Optional(Type.String({ description: "Message for resume" })),
  verbose: Type.Optional(Type.Boolean({ description: "Return verbose status/result output" })),
});

export const AgentAliasParams = Type.Object({
  subagent_type: Type.String({ description: "Agent name" }),
  prompt: Type.String({ description: "Delegated task" }),
  description: Type.Optional(Type.String({ description: "Short description for UI/status" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "Start the subagent in the background" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
  model: Type.Optional(Type.String({ description: "Temporary model override when agent frontmatter omits model" })),
  thinking: Type.Optional(Type.String({ description: "Temporary thinking override when agent frontmatter omits thinking" })),
});

export const GetSubagentResultParams = Type.Object({
  id: Type.String({ description: "Run id" }),
  verbose: Type.Optional(Type.Boolean({ description: "Return verbose output" })),
});

export const SteerSubagentParams = Type.Object({
  id: Type.String({ description: "Run id" }),
  message: Type.String({ description: "Message to send to the running subagent" }),
});

export type ParamsWithScope = {
  agentScope?: AgentScope;
  confirmProjectAgents?: boolean;
};

type RawParams = Record<string, any>;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function normalizeSubagentParams(params: RawParams): NormalizedRequest {
  const action = params.action ?? (params.resume && !params.agent && !params.subagent_type ? "resume" : "run");
  if (["list", "status", "result", "interrupt", "resume"].includes(action)) {
    const management: ManagementRequest = { action, id: params.id ?? params.resume, message: params.message, verbose: params.verbose };
    if (action === "resume" && !management.message && hasText(params.prompt)) management.message = params.prompt;
    return { kind: "management", management };
  }
  if (action !== "run") throw new Error(`Unsupported subagent action: ${action}`);

  if (params.inherit_context === true || params.inheritContext === true || params.context === "fork") {
    throw new Error("inherit_context/context fork is not supported yet. It will be added after Pi session fork support is verified.");
  }

  const hasReference = hasText(params.subagent_type) || hasText(params.prompt);
  const hasSingle = hasText(params.agent) || hasText(params.task);
  const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
  const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
  const modeCount = Number(hasReference || hasSingle) + Number(hasTasks) + Number(hasChain);
  if (modeCount !== 1) throw new Error("Invalid parameters. Provide exactly one run mode.");

  if (hasReference) {
    if (!hasText(params.subagent_type) || !hasText(params.prompt)) {
      throw new Error("Reference-style run requires both subagent_type and prompt.");
    }
    return {
      kind: "run",
      run: {
        mode: "single",
        agent: params.subagent_type,
        task: params.prompt,
        cwd: params.cwd,
        description: params.description,
        runInBackground: params.run_in_background,
        inheritContext: params.inherit_context,
        model: params.model,
        thinking: params.thinking,
        resumeId: params.resume,
      },
    };
  }

  if (hasSingle) {
    if (!hasText(params.agent) || !hasText(params.task)) throw new Error("Single run requires both agent and task.");
    const run: RunRequest = {
      mode: "single",
      agent: params.agent,
      task: params.task,
      cwd: params.cwd,
      description: params.description,
      runInBackground: params.run_in_background,
      model: params.model,
      thinking: params.thinking,
    };
    return { kind: "run", run };
  }

  if (hasTasks) return { kind: "run", run: { mode: "parallel", tasks: params.tasks } };
  return { kind: "run", run: { mode: "chain", chain: params.chain } };
}

export function normalizeAgentAliasParams(params: RawParams): NormalizedRequest {
  return normalizeSubagentParams({ ...params, action: "run" });
}
