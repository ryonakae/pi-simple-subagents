# pi-simple-subagents

Add a lightweight `subagent` tool to Pi and delegate work to specialist agents you keep as Markdown files.

<!-- README-I18N:START -->

**English** | [日本語](./README.ja.md)

<!-- README-I18N:END -->

## Features

- **Small surface area:** The package ships with one built-in agent, `general-purpose`, and lets you add the specialists you need.
- **Default model inheritance:** Agent files can omit `model`; child Pi processes then use the parent Pi default model.
- **Markdown agents:** User agents live in `~/.pi/agent/agents/*.md`; project agents live in `.pi/agents/*.md`.
- **Flexible delegation:** Run one task, run tasks in parallel, or pass prior output through a chain.
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

## Run modes

- List agents: set `action: "list"`.
- Single task: pass `agent` and `task`.
- Parallel tasks: pass `tasks`. The package accepts up to 8 tasks and runs up to 4 at a time.
- Chain: pass `chain` and use `{previous}` to inject the prior step output.
- Scope: choose `user`, `project`, or `both` for `agentScope`. The default is `user`.

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
pi --list-models -e .
```

## License

[MIT](LICENSE)
