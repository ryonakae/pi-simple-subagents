import { describe, expect, it } from "vitest";
import { normalizeAgentAliasParams, normalizeSubagentParams } from "../src/schemas.ts";

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

  it("normalizes legacy agent/task parameters", () => {
    expect(normalizeSubagentParams({ agent: "reviewer", task: "レビューして" })).toMatchObject({
      kind: "run",
      run: { mode: "single", agent: "reviewer", task: "レビューして" },
    });
  });

  it("normalizes Agent alias parameters", () => {
    expect(normalizeAgentAliasParams({ subagent_type: "Explore", prompt: "Find auth files", run_in_background: true })).toMatchObject({
      kind: "run",
      run: { mode: "single", agent: "Explore", task: "Find auth files", runInBackground: true },
    });
  });

  it("rejects multiple run modes", () => {
    expect(() => normalizeSubagentParams({ subagent_type: "reviewer", prompt: "x", tasks: [{ agent: "a", task: "b" }] })).toThrow(
      "Invalid parameters. Provide exactly one run mode.",
    );
  });

  it("rejects unsupported inherited context", () => {
    expect(() => normalizeSubagentParams({ subagent_type: "reviewer", prompt: "x", inherit_context: true })).toThrow("inherit_context");
  });

  it("normalizes management actions", () => {
    expect(normalizeSubagentParams({ action: "status", id: "sub_123" })).toEqual({ kind: "management", management: { action: "status", id: "sub_123" } });
    expect(normalizeSubagentParams({ resume: "sub_123", prompt: "追加で確認" })).toEqual({
      kind: "management",
      management: { action: "resume", id: "sub_123", message: "追加で確認", verbose: undefined },
    });
  });
});
