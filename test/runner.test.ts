import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/agents.ts";
import { buildPiArgs } from "../src/runner.ts";

describe("buildPiArgs", () => {
  it("uses a child session file and excludes nested subagent tools by default", async () => {
    const agent: AgentConfig = {
      name: "reviewer",
      description: "Review code",
      promptMode: "replace",
      systemPrompt: "Review carefully.",
      source: "user",
      tools: ["read", "bash"],
      excludeTools: ["write"],
    };

    const built = await buildPiArgs(agent, "現在の差分を確認", "/tmp/session.jsonl", { model: "test/model", thinking: "high" });

    expect(built.args).toContain("--session");
    expect(built.args).toContain("/tmp/session.jsonl");
    expect(built.args).not.toContain("--no-session");
    expect(built.args).toEqual(expect.arrayContaining(["--model", "test/model", "--thinking", "high", "--tools", "read,bash"]));
    expect(built.args).toContain("--exclude-tools");
    expect(built.args[built.args.indexOf("--exclude-tools") + 1]).toContain("subagent");
    expect(built.args[built.args.indexOf("--system-prompt") + 1]).toMatch(/reviewer\.md$/);

    const promptPath = built.args[built.args.indexOf("--system-prompt") + 1];
    expect(fs.existsSync(promptPath)).toBe(true);
    await built.cleanup();
    expect(fs.existsSync(promptPath)).toBe(false);
  });

  it("does not override model/thinking declared in frontmatter", async () => {
    const agent: AgentConfig = {
      name: "reviewer",
      description: "Review code",
      promptMode: "append",
      systemPrompt: "",
      source: "user",
      model: "frontmatter/model",
      thinking: "medium",
    };

    const built = await buildPiArgs(agent, "task", "/tmp/session.jsonl", { model: "override/model", thinking: "high" });

    expect(built.args).toEqual(expect.arrayContaining(["--model", "frontmatter/model", "--thinking", "medium"]));
    expect(built.args).not.toContain("override/model");
    await built.cleanup();
  });
});
