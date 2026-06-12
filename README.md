# pi-simple-subagents

Add a lightweight `subagent` tool to Pi and delegate work to specialist agents you keep as Markdown files.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

## Features

- **Small surface area:** The package ships with built-in `general-purpose`, `Plan`, and `Explore` agents, and lets you add the specialists you need.
- **Default model inheritance:** Agent files can omit `model`; child Pi processes then use the parent Pi default model.
- **Markdown agents:** User agents live in `~/.pi/agent/agents/*.md`; project agents live in `.pi/agents/*.md`.
- **Flexible delegation:** Run one task, run tasks in parallel, pass prior output through a chain, or start a background run.
- **Reference-style compatibility:** `subagent({ subagent_type, prompt })`, `Agent(...)`, and `get_subagent_result(...)` are available alongside the original `agent` / `task` API.
- **Run management:** Check `status`, fetch `result`, `interrupt` running background jobs, and experimentally `resume` recorded child sessions.
- **Project prompt review:** Pi asks before it runs repository-controlled agents from `.pi/agents/*.md`.

## Install

Install the package from GitHub.

```sh
pi install git:github.com/ryonakae/pi-simple-subagents
```

Load your local checkout for one Pi run from the repository root.

```sh
pi -e .
```

Pi packages execute code. Review third-party packages before you install them.

## Usage

Start Pi and describe the delegation you want.

```text
List available subagents.
Use the general-purpose subagent to investigate why npm run check fails.
Use the Plan subagent to design the implementation before editing.
Use the Explore subagent to locate auth-related files and references.
Run two subagents in parallel: one reviews correctness and one checks missing documentation.
```

Set `agentScope` to `both` when you want to include project agents. Pi asks for confirmation before it runs agents from `.pi/agents/*.md`.

## Add an agent

Place shared user agents in `~/.pi/agent/agents/`.

```sh
mkdir -p ~/.pi/agent/agents
cat > ~/.pi/agent/agents/reviewer.md <<'EOF'
---
name: reviewer
description: Review code changes for correctness, tests, and simplicity
tools: read, bash
thinking: high
prompt_mode: replace
---

You are a code reviewer. Read the current diff and report only actionable findings.
EOF
```

Ask Pi to list agents after you add the file.

```text
List available subagents.
```

### Frontmatter

- `name`: Agent name. Pi uses the file name when you omit it.
- `description`: Required. Pi shows it in the list and tool description.
- `tools` / `exclude_tools`: Limit the tools passed to child Pi processes.
- `model` / `thinking`: Set the child Pi model and thinking budget. Omit `model` to use the parent default.
- `prompt_mode`: `replace` or `append`.
- `extensions` / `skills` / `context_files` / `enabled`: Control discovery and loading.
- `run_in_background` / `runInBackground`: Default to background execution for this agent.
- `inherit_context` / `inheritContext`: Reserved for future context fork support; currently fails fast when requested.
- `max_turns` / `maxTurns` and `isolation`: Parsed for forward compatibility.

## Run modes

Recommended reference-style single run:

```ts
subagent({
  subagent_type: "reviewer",
  prompt: "Review the current diff",
  description: "diff review"
})
```

Compatibility single run:

```ts
subagent({ agent: "reviewer", task: "Review the current diff" })
```

Background run:

```ts
subagent({
  subagent_type: "scout",
  prompt: "Investigate the auth flow",
  run_in_background: true
})
```

Manage runs:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "sub_abc123" })
subagent({ action: "result", id: "sub_abc123" })
get_subagent_result({ id: "sub_abc123", verbose: true })
subagent({ action: "interrupt", id: "sub_abc123" })
subagent({ action: "resume", id: "sub_abc123", message: "Also check tests" })
```

Other modes:

- List agents: set `action: "list"`.
- Parallel tasks: pass `tasks`. The package accepts up to 8 tasks and runs up to 4 at a time.
- Chain: pass `chain` and use `{previous}` to inject the prior step output.
- Scope: choose `user`, `project`, or `both` for `agentScope`. The default is `user`.

## Artifacts and limitations

Runs are saved under `.pi/subagents/runs/<run-id>/` when possible, with a fallback under `~/.pi/agent/subagents/<project-hash>/runs/<run-id>/`. Each run records `status.json`, stdout/stderr logs, `result.md`, and a child `session.jsonl` path.

Current limitations:

- `inherit_context` / `context: "fork"` is reserved and fails fast instead of silently falling back.
- `steer_subagent` is registered for compatibility but is not implemented yet.
- Background jobs are managed by the current Pi process; stale running artifacts from another process cannot be interrupted.

## Requirements

- Pi Coding Agent package support. We checked this repository with Pi Coding Agent 0.78.1.
- Node.js 22 or newer for development. `npm run check` uses `node --experimental-strip-types`.

## Inspired by

This package references ideas from these Pi subagent repositories.

- <https://github.com/nicobailon/pi-subagents>
- <https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents>
- <https://github.com/tintinweb/pi-subagents>

## Development

```sh
npm run check
npm run test
npm run lint
npm run typecheck
pi --list-models -e .
```

`npm run check` runs TypeScript type checking, Biome, and Vitest. Husky runs tests, type checking, and lint-staged Biome checks on pre-commit.

## License

[MIT](LICENSE)
