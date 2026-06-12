import type { Message } from "@earendil-works/pi-ai";
import { OUTPUT_CAP_BYTES, type RunStatus, type SingleResult, type UsageStats } from "./types.ts";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
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

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

export function truncateForParent(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= OUTPUT_CAP_BYTES) return output;

  let truncated = output.slice(0, OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP_BYTES) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated for parent context. Full output is preserved in tool details.]`;
}

export function formatRunStatus(status: RunStatus): string {
  const elapsedMs = (status.completedAt ?? Date.now()) - status.startedAt;
  const elapsed = `${Math.max(0, Math.round(elapsedMs / 1000))}s`;
  const usage = formatUsageStats(status.usage);
  const extras = [status.description, usage, `elapsed ${elapsed}`].filter(Boolean).join("; ");
  return `- ${status.id} [${status.state}] ${status.agent}${extras ? ` (${extras})` : ""}`;
}

export function formatStatusList(statuses: RunStatus[]): string {
  if (statuses.length === 0) return "No subagent runs found.";
  return statuses.map(formatRunStatus).join("\n");
}

export function formatDetailedStatus(status: RunStatus): string {
  const lines = [formatRunStatus(status), `cwd: ${status.cwd}`, `artifactDir: ${status.artifactDir}`];
  if (status.sessionFile) lines.push(`sessionFile: ${status.sessionFile}`);
  if (status.pid) lines.push(`pid: ${status.pid}`);
  if (status.errorMessage) lines.push(`error: ${status.errorMessage}`);
  if (status.state === "running" && !status.pid) {
    lines.push("stale: this Pi process cannot interrupt this run because the process handle is not available.");
  }
  return lines.join("\n");
}

export function formatStoredResult(status: RunStatus, output: string, verbose = false): string {
  const body = verbose ? output : truncateForParent(output);
  const lines = [`Subagent ${status.id} [${status.state}] ${status.agent}`, "", body || "(no output)"];
  if (status.sessionFile) lines.push("", `sessionFile: ${status.sessionFile}`);
  lines.push("", `artifactDir: ${status.artifactDir}`);
  return lines.join("\n");
}
