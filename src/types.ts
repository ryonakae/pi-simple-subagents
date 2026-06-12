import type { ChildProcess } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig, AgentScope } from "./agents.ts";

export const CHILD_ENV = "PI_THIN_SUBAGENTS_CHILD";
export const OUTPUT_CAP_BYTES = 50 * 1024;
export const SUBAGENT_TOOL_NAMES = ["subagent", "Agent", "get_subagent_result", "steer_subagent"];

export type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

export type RunState = "queued" | "running" | "completed" | "failed" | "interrupted" | "aborted";
export type RunMode = "single" | "list" | "status" | "result" | "interrupt" | "resume";

export type SingleResult = {
  id?: string;
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
  sessionFile?: string;
  artifactDir?: string;
};

export type SubagentDetails = {
  mode: RunMode;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
  jobs?: RunStatus[];
};

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
};

export type OnUpdateCallback = (partial: ToolResult) => void;

export type RunRequest = {
  mode: "single";
  agent: string;
  task: string;
  cwd?: string;
  description?: string;
  runInBackground?: boolean;
  inheritContext?: boolean;
  model?: string;
  thinking?: string;
  resumeId?: string;
};

export type ManagementRequest = {
  action: "list" | "status" | "result" | "interrupt" | "resume";
  id?: string;
  message?: string;
  verbose?: boolean;
};

export type NormalizedRequest =
  | { kind: "run"; run: RunRequest }
  | { kind: "management"; management: ManagementRequest };

export type RunStatus = {
  id: string;
  mode: "single";
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  description?: string;
  task: string;
  cwd: string;
  state: RunState;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  stopReason: string | null;
  errorMessage: string | null;
  pid: number | null;
  sessionFile: string | null;
  artifactDir: string;
  usage: UsageStats;
};

export type BackgroundJob = {
  id: string;
  proc: ChildProcess;
  status: RunStatus;
  result: SingleResult;
  artifactDir: string;
};

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}
