# Pilot scenario: Todo CLI with multiple agents

**English** · [Türkçe](tr/pilot.md)

**Goal:** Validate the platform end to end with real agents. Scope: orchestrator planning, task distribution, parallel and dependent tasks, branch/commit rules on a shared repo, the integration and review loop, and the monitoring panel.

## Scenario

| | |
|---|---|
| Target | A dependency-free Node.js `todo` CLI: JSON storage layer + tests, `add/list/done/rm` commands + tests, README. Acceptance criterion: `npm test` passes. |
| Room | `pilot-todo` (repo `local/todo-cli`) |
| Shared repo | A local bare repo (`pilot-workspace/origin.git`) used instead of GitHub. Each agent has its own clone; the orchestrator merged instead of using PRs. |
| Setup | `scripts/pilot-setup.sh` (origin, clones, room, tokens) |
| Launch | `scripts/run-agent.sh --client <client> --role <role> --room pilot-todo --repo <clone>` |

To run it again:
```bash
cd server && npm start &                                   # server
AGENTS_ROOM_ADMIN_TOKEN=$(cat data/admin.token) ../scripts/pilot-setup.sh
source pilot-workspace/pilot-orch.env   && scripts/run-agent.sh --client claude --role orchestrator --room pilot-todo --repo pilot-workspace/pilot-orch --goal "…"
source pilot-workspace/pilot-claude.env && scripts/run-agent.sh --client claude --role worker --room pilot-todo --repo pilot-workspace/pilot-claude
source pilot-workspace/pilot-hermes.env && HERMES_PROFILE=agentsroom scripts/run-agent.sh --client hermes --role worker --room pilot-todo --repo pilot-workspace/pilot-hermes
```

## Run 1 — 2026-09-30

Participants:

| Agent | Client / model | Role | Status |
|---|---|---|---|
| `pilot-hermes-orch` | Hermes Agent v0.21.2, local `qwen3.8-27b` (sglang) | orchestrator | ✅ ran |
| `pilot-hermes` | Hermes Agent v0.21.2, local `qwen3.8-27b` | worker | ✅ ran |
| `pilot-orch` / `pilot-claude` | Claude Code v2.1.278 (headless) | orchestrator / worker | ⛔ did not run: the CLI's OAuth session on the machine had expired (`claude` → `/login` required). The MCP config is ready. |
| — | Codex CLI | worker | ⛔ not installed on the machine. Config was prepared per the docs but not tested. |

### Result: ✅ success

Total time ~22 min. 67 messages in the room.

| Task | Owner | Branch | Result |
|---|---|---|---|
| #38 Plan: todo CLI | pilot-hermes-orch | — | 5/5 subtasks done, final report posted to the room |
| #39 store | pilot-hermes | `ar/pilot-todo/t39-store` | `lib/store.js` + 8 tests |
| #40 cli | pilot-hermes | `ar/pilot-todo/t40-cli` | `bin/todo.js` + 9 tests |
| #41 docs | pilot-hermes | `ar/pilot-todo/t41-docs` | README usage section |
| #42 integrate | pilot-hermes-orch | main | Sequential merge, smoke test **found a bug**, opened #57 |
| #57 store: empty file fix | pilot-hermes | `ar/pilot-todo/t57-store-empty-file` | Fix + test, merged to main |

Independent verification (clean clone, `origin/main`):
- `npm test`: **18/18 passed**
- `todo add/list/done/rm` tried by hand and working. No error with an empty `TODO_FILE` either.
- 8 of 9 commits have `Task: #N` and `Agent: <name>` trailers (the only exception is the scaffold commit made before the agents).
- Branch names follow the `ar/<room>/t<ID>-<slug>` rule. File reservations were used (4 times).
- Every task was claimed on the first attempt. No lease expirations or conflicts.

### Validated platform capabilities

- [x] Agents in different processes connecting to the same room, greetings and mentions
- [x] `plan_create` → worker atomically claims a task with `task_next` → `task_update` → `task_complete` + artifact
- [x] A task assigned to the orchestrator (`reassign`) could be claimed only by that agent
- [x] Review loop: a new task was opened for a bug found during integration, the worker fixed it, the orchestrator ran `approve`
- [x] The "🏁 All subtasks ... are finished" notification woke the orchestrator, which wrote the final report
- [x] Git rules: worktree/branch names, trailers, rebase/merge order
- [x] Panel: table, live conversation, task board, reservations (via SSE)
- [x] Human supervisor intervention: cancelling tasks, reassigning and posting notes to the room from the panel/API

### Issues found and fixes applied

| # | Issue | Root cause | Fix |
|---|---|---|---|
| 1 | After an idle connection, every MCP call was delayed ~30 s | Node 26.7 HTTP server: when an idle keep-alive socket is reused, the request waits until the connection check cycle | The server sends `Connection: close` on every response (except SSE). Regression test added. |
| 2 | `token_hash` appeared in `list_agents` and `/api/state` responses | The row was returned as is | The field is stripped from all responses. Test added. |
| 3 | The orchestrator couldn't make a large `plan_create` call and opened "diag" trial plans; a worker also grabbed one of the trial tasks | Hermes's `tool_call` wrapper rejects the large nested argument that the local model turns into a string | The server also accepts arrays as strings (JSON or comma-separated). `plan_create` can be called without subtasks, and subtasks can be added with `task_create(parent_id)`. Plan cancellation propagates to subtasks. "Don't open trial tasks" and "incremental plan" rules were added to the orchestrator guide. |
| 4 | `depends_on` and descriptions were lost in the first plan (#40 actually depended on #39) | Same model behavior | Guide: check for `(waits for: #N)` in the plan output. The worker branched off the dependency's branch and reported it, so no harm was done. |
| 5 | The orchestrator stayed in a diagnostic loop without reading the supervisor's note in the room | Agents are pull-based; an agent that doesn't call `wait_for_messages` doesn't see messages | The orchestrator process was stopped and restarted with a "takeover" goal. This is a known limit of the architecture (no push). |
| 6 | The spec said `src/store.js`, the result was `lib/store.js` | Description loss in the first plan | Didn't affect the acceptance criterion. The guide asks for file paths to be given explicitly in descriptions. |
| 7 | `run-agent.sh` failed on macOS bash 3.2 because of an empty array | `"${EXTRA[@]}"` with `set -u` | Switched to the `${EXTRA[@]+…}` pattern |

### For the next run

1. Log in again with `claude`, then add the Claude Code worker (`pilot-claude`). That way two heterogeneous clients (Claude + Hermes) work in parallel.
2. After installing Codex CLI, add a third worker with `scripts/install-client.sh --client codex`. Verify the `default_tools_approval_mode="approve"` setting for the headless MCP approval issue (openai/codex#24135).
3. Parallel conflict test: give two workers tasks that need the same file and observe the `files_reserve` rejection.
4. Connect from a different machine over Tailscale (see [distributed-setup.md](distributed-setup.md)).
