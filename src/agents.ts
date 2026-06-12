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
  runInBackground?: boolean;
  inheritContext?: boolean;
  maxTurns?: number;
  isolation?: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  userAgentsDir: string;
}

const READ_ONLY_TOOLS = ["read", "bash"];

const READ_ONLY_SYSTEM_PROMPT = [
  "# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS",
  "You are STRICTLY PROHIBITED from:",
  "- Creating new files",
  "- Modifying existing files",
  "- Deleting files",
  "- Moving or copying files",
  "- Creating temporary files anywhere, including /tmp",
  "- Using redirect operators (>, >>, |) or heredocs to write to files",
  "- Running ANY commands that change system state",
].join("\n");

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
  {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use it when you need an implementation strategy, critical files, sequencing, and architectural trade-offs before editing code.",
    tools: READ_ONLY_TOOLS,
    promptMode: "replace",
    systemPrompt: [
      READ_ONLY_SYSTEM_PROMPT,
      "",
      "You are a software architect and planning specialist.",
      "Your role is exclusively to explore the codebase and design implementation plans. Do not implement changes.",
      "",
      "# Planning Process",
      "1. Understand the requirements.",
      "2. Explore thoroughly with read-only tools.",
      "3. Design a solution that follows existing project patterns.",
      "4. Detail the implementation strategy step by step.",
      "",
      "# Requirements",
      "- Consider trade-offs and architectural decisions.",
      "- Identify dependencies and sequencing.",
      "- Anticipate potential challenges.",
      "- Use absolute file paths in file references.",
      "- End with a 'Critical Files for Implementation' section listing 3-5 files and brief reasons.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "Explore",
    description:
      "Fast read-only search agent for locating code. Use it to find files by pattern, grep for symbols or keywords, or answer where something is defined or referenced.",
    tools: READ_ONLY_TOOLS,
    promptMode: "replace",
    systemPrompt: [
      READ_ONLY_SYSTEM_PROMPT,
      "",
      "You are a file search specialist. You excel at thoroughly navigating and exploring codebases.",
      "Your role is exclusively to search and analyze existing code. Do not implement changes.",
      "",
      "# Search Process",
      "- Adapt search breadth based on the requested thoroughness: quick, medium, or very thorough.",
      "- Use read for file contents and bash only for read-only discovery commands such as ls, rg, find, git status, git log, and git diff.",
      "- Make independent tool calls in parallel when it improves efficiency.",
      "",
      "# Output",
      "- Use absolute file paths in all references.",
      "- Report findings concisely and precisely.",
      "- Do not use emojis.",
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

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asString(value)?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
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
      runInBackground: asBoolean(frontmatter.run_in_background ?? frontmatter.runInBackground),
      inheritContext: asBoolean(frontmatter.inherit_context ?? frontmatter.inheritContext),
      maxTurns: asNumber(frontmatter.max_turns ?? frontmatter.maxTurns),
      isolation: asString(frontmatter.isolation)?.trim(),
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
