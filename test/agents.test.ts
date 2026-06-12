import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentDir } = vi.hoisted(() => ({
  getAgentDir: vi.fn<() => string>(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
  return {
    ...actual,
    getAgentDir,
  };
});

import { type AgentConfig, discoverAgents, formatAgentList } from "../src/agents.ts";

function writeAgent(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), content, "utf-8");
}

function requireAgent(agents: AgentConfig[], name: string): AgentConfig {
  const agent = agents.find((candidate) => candidate.name === name);
  if (!agent) throw new Error(`Agent not found: ${name}`);
  return agent;
}

describe("discoverAgents", () => {
  let tempDir: string;
  let userAgentsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-simple-subagents-test-"));
    userAgentsDir = path.join(tempDir, "agents");
    getAgentDir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("user scope includes the built-in agent and user agents only", () => {
    writeAgent(userAgentsDir, "reviewer", `---
description: Review code
tools: read, bash
---

Review carefully.
`);
    const projectAgentsDir = path.join(tempDir, "project", ".pi", "agents");
    writeAgent(projectAgentsDir, "project-only", `---
description: Project agent
---

Project prompt.
`);

    const result = discoverAgents(path.join(tempDir, "project"), "user");

    expect(result.userAgentsDir).toBe(userAgentsDir);
    expect(result.projectAgentsDir).toBe(projectAgentsDir);
    expect(result.agents.map((agent) => agent.name)).toEqual(["general-purpose", "reviewer"]);
    expect(requireAgent(result.agents, "reviewer")).toMatchObject({
      source: "user",
      tools: ["read", "bash"],
      promptMode: "replace",
      systemPrompt: "Review carefully.",
    });
  });

  it("project scope searches parent directories and excludes built-in/user agents", () => {
    writeAgent(userAgentsDir, "user-only", `---
description: User agent
---

User prompt.
`);
    const projectRoot = path.join(tempDir, "repo");
    const nestedCwd = path.join(projectRoot, "packages", "app");
    const projectAgentsDir = path.join(projectRoot, ".pi", "agents");
    fs.mkdirSync(nestedCwd, { recursive: true });
    writeAgent(projectAgentsDir, "planner", `---
name: project-planner
description: Plan changes
exclude_tools:
  - edit
  - write
model: test/model
thinking: high
prompt_mode: append
extensions: false
skills: true
context_files: false
run_in_background: true
inheritContext: false
max_turns: 7
isolation: worktree
---

Plan only.
`);

    const result = discoverAgents(nestedCwd, "project");
    const planner = requireAgent(result.agents, "project-planner");

    expect(result.projectAgentsDir).toBe(projectAgentsDir);
    expect(result.agents.map((agent) => agent.name)).toEqual(["project-planner"]);
    expect(planner).toMatchObject({
      description: "Plan changes",
      excludeTools: ["edit", "write"],
      model: "test/model",
      thinking: "high",
      promptMode: "append",
      source: "project",
      filePath: path.join(projectAgentsDir, "planner.md"),
      extensions: false,
      skills: true,
      contextFiles: false,
      runInBackground: true,
      inheritContext: false,
      maxTurns: 7,
      isolation: "worktree",
      systemPrompt: "Plan only.",
    });
  });

  it("both scope lets project agents override user agents with the same name", () => {
    writeAgent(userAgentsDir, "reviewer", `---
description: User reviewer
---

User prompt.
`);
    const projectAgentsDir = path.join(tempDir, "repo", ".pi", "agents");
    writeAgent(projectAgentsDir, "reviewer", `---
description: Project reviewer
---

Project prompt.
`);

    const result = discoverAgents(path.join(tempDir, "repo"), "both");
    const reviewer = requireAgent(result.agents, "reviewer");

    expect(result.agents.map((agent) => agent.name)).toEqual(["general-purpose", "reviewer"]);
    expect(reviewer).toMatchObject({
      description: "Project reviewer",
      source: "project",
      systemPrompt: "Project prompt.",
    });
  });

  it("skips disabled agents and agents without a description", () => {
    writeAgent(userAgentsDir, "enabled", `---
description: Enabled agent
enabled: true
---

Enabled prompt.
`);
    writeAgent(userAgentsDir, "disabled", `---
description: Disabled agent
enabled: false
---

Disabled prompt.
`);
    writeAgent(userAgentsDir, "missing-description", `---
name: missing-description
---

No description.
`);

    const result = discoverAgents(tempDir, "user");

    expect(result.agents.map((agent) => agent.name)).toEqual(["general-purpose", "enabled"]);
  });
});

describe("formatAgentList", () => {
  it("formats empty and populated lists", () => {
    expect(formatAgentList([])).toBe("No subagents found.");
    expect(
      formatAgentList([
        {
          name: "general-purpose",
          description: "General work",
          promptMode: "append",
          systemPrompt: "",
          source: "builtin",
        },
      ]),
    ).toBe("- general-purpose (builtin): General work");
  });
});
