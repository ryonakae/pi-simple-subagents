import { Text } from "@earendil-works/pi-tui";
import type { AgentScope } from "./agents.ts";
import { formatUsageStats, getResultOutput, isFailedResult } from "./status.ts";
import type { SubagentDetails } from "./types.ts";

export function renderSubagentCall(args: any, theme: any): Text {
  const scope: AgentScope = args.agentScope ?? "user";
  const action = args.action ?? "run";
  if (action !== "run") {
    const target = args.id ? ` ${args.id}` : "";
    return new Text(theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `${action}${target}`) + theme.fg("muted", ` [${scope}]`), 0, 0);
  }

  const agentName = args.subagent_type || "...";
  const preview = (args.prompt || "...").slice(0, 80);
  const bg = args.run_in_background ? theme.fg("warning", " background") : "";
  return new Text(
    theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + bg + theme.fg("muted", ` [${scope}]`) + `\n  ${theme.fg("dim", preview)}`,
    0,
    0,
  );
}

export function renderSubagentResult(result: any, { expanded }: { expanded: boolean }, theme: any): Text {
  const details = result.details as SubagentDetails | undefined;
  if (!details || (details.results.length === 0 && (!details.jobs || details.jobs.length === 0))) {
    const first = result.content[0];
    const text = first?.type === "text" ? first.text : "(no output)";
    return new Text(text, 0, 0);
  }

  if (details.jobs && details.jobs.length > 0 && details.results.length === 0) {
    return new Text(
      details.jobs
        .map((job) => `${theme.fg(job.state === "failed" ? "error" : job.state === "running" ? "warning" : "success", job.state)} ${theme.fg("toolTitle", job.id)} ${job.agent}`)
        .join("\n"),
      0,
      0,
    );
  }

  const lines: string[] = [];
  for (const item of details.results) {
    const running = item.exitCode === -1;
    const failed = !running && isFailedResult(item);
    const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const id = item.id ? theme.fg("muted", ` ${item.id}`) : "";
    lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(item.agent))}${id}${theme.fg("muted", ` (${item.agentSource})`)}`);
    const output = getResultOutput(item);
    const visibleOutput = expanded ? output : output.split("\n").slice(0, 8).join("\n");
    if (visibleOutput) lines.push(theme.fg(failed ? "error" : "toolOutput", visibleOutput));
    const usage = formatUsageStats(item.usage, item.model);
    const meta = [usage, item.sessionFile ? `session: ${item.sessionFile}` : ""].filter(Boolean).join(" | ");
    if (meta) lines.push(theme.fg("dim", meta));
    if (!expanded && output.split("\n").length > 8) lines.push(theme.fg("muted", "(Ctrl+O to expand)"));
    lines.push("");
  }

  return new Text(lines.join("\n").trimEnd(), 0, 0);
}
