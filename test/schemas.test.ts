import { describe, expect, it } from "vitest";
import { AgentAliasParams, normalizeAgentAliasParams, normalizeSubagentParams, SubagentParams } from "../src/schemas.ts";

describe("normalizeSubagentParams", () => {
  it("normalizes reference-style run parameters", () => {
    expect(normalizeSubagentParams({ subagent_type: "reviewer", prompt: "レビューして", description: "diff review" })).toEqual({
      kind: "run",
      run: {
        mode: "single",
        agent: "reviewer",
        task: "レビューして",
        cwd: undefined,
        description: "diff review",
        runInBackground: undefined,
        inheritContext: undefined,
        model: undefined,
        thinking: undefined,
        resumeId: undefined,
      },
    });
  });

  it("normalizes Agent alias parameters", () => {
    expect(normalizeAgentAliasParams({ subagent_type: "Explore", prompt: "Find auth files", run_in_background: true })).toMatchObject({
      kind: "run",
      run: { mode: "single", agent: "Explore", task: "Find auth files", runInBackground: true },
    });
  });

  it("rejects legacy run parameters with a migration hint", () => {
    expect(() => normalizeSubagentParams({ agent: "reviewer", task: "レビューして" })).toThrow("legacy subagent run API was removed");
    expect(() => normalizeSubagentParams({ tasks: [{ agent: "a", task: "b" }] })).toThrow("call subagent multiple times");
    expect(() => normalizeSubagentParams({ chain: [{ agent: "a", task: "b" }] })).toThrow("call subagent multiple times");
  });

  it("does not expose legacy run parameters in public schemas", () => {
    const subagentProperties = Object.keys((SubagentParams as any).properties);
    expect(subagentProperties).not.toContain("agent");
    expect(subagentProperties).not.toContain("task");
    expect(subagentProperties).not.toContain("tasks");
    expect(subagentProperties).not.toContain("chain");

    const agentProperties = Object.keys((AgentAliasParams as any).properties);
    expect(agentProperties).toEqual(expect.arrayContaining(["subagent_type", "prompt"]));
    expect(agentProperties).not.toContain("agent");
    expect(agentProperties).not.toContain("task");
  });

  it("rejects unsupported inherited context", () => {
    expect(() => normalizeSubagentParams({ subagent_type: "reviewer", prompt: "x", inherit_context: true })).toThrow("inherit_context");
  });

  it("requires subagent_type and prompt for run", () => {
    expect(() => normalizeSubagentParams({ subagent_type: "reviewer" })).toThrow("requires both subagent_type and prompt");
    expect(() => normalizeSubagentParams({ prompt: "x" })).toThrow("requires both subagent_type and prompt");
  });

  it("normalizes management actions", () => {
    expect(normalizeSubagentParams({ action: "status", id: "sub_123" })).toEqual({ kind: "management", management: { action: "status", id: "sub_123" } });
    expect(normalizeSubagentParams({ resume: "sub_123", prompt: "追加で確認" })).toEqual({
      kind: "management",
      management: { action: "resume", id: "sub_123", message: "追加で確認", verbose: undefined },
    });
  });
});
