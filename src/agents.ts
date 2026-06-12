import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type PromptMode = "append" | "replace";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  excludeTools?: string[];
  model?: string;
  thinking?: string;
  promptMode: PromptMode;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath?: string;
  extensions?: boolean;
  skills?: boolean;
  contextFiles?: boolean;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  userAgentsDir: string;
}

const BUILTIN_AGENTS: AgentConfig[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for complex, multi-step tasks. Use it when the task benefits from an isolated context window or independent investigation.",
    promptMode: "append",
    systemPrompt: [
      "You are a general-purpose subagent running in an isolated Pi process.",
      "Work autonomously on the delegated task, follow the repository instructions, and return a concise result with important file paths and validation notes.",
    ].join("\n"),
    source: "builtin",
  },
];

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return undefined;
}

function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => asString(item)?.trim()).filter((item): item is string => Boolean(item));
    return items.length > 0 ? items : undefined;
  }
  const text = asString(value);
  if (!text) return undefined;
  const items = text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const name = asString(frontmatter.name)?.trim() || path.basename(entry.name, ".md");
    const description = asString(frontmatter.description)?.trim();
    const enabled = asBoolean(frontmatter.enabled);
    if (!name || !description || enabled === false) continue;

    const promptModeText = asString(frontmatter.prompt_mode ?? frontmatter.promptMode)?.trim().toLowerCase();
    const promptMode: PromptMode = promptModeText === "append" ? "append" : "replace";

    agents.push({
      name,
      description,
      tools: asList(frontmatter.tools),
      excludeTools: asList(frontmatter.exclude_tools ?? frontmatter.excludeTools),
      model: asString(frontmatter.model)?.trim(),
      thinking: asString(frontmatter.thinking)?.trim(),
      promptMode,
      systemPrompt: body.trim(),
      source,
      filePath,
      extensions: asBoolean(frontmatter.extensions),
      skills: asBoolean(frontmatter.skills),
      contextFiles: asBoolean(frontmatter.context_files ?? frontmatter.contextFiles),
    });
  }

  return agents;
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();
  if (scope !== "project") {
    for (const agent of BUILTIN_AGENTS) agentMap.set(agent.name, agent);
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  }
  if (scope !== "user") {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir, userAgentsDir };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "No subagents found.";
  return agents.map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`).join("\n");
}
