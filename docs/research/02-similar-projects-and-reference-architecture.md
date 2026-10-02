# 02 — Similar projects and the agents-room reference architecture

**English** · [Türkçe](../tr/research/02-benzer-cozumler-ve-referans-mimari.md)

> Date: 2026-09-30 · Scope: A survey of open-source and notable multi-agent coordination tools, followed by a reference architecture for agents-room.
> Note: Star counts and version information come from sources at the time of research; they change quickly and should be treated as approximate.

## 1. Summary

The solutions on the market fall into three main clusters:

1. **Coordination layers / MCP servers** (mcp_agent_mail, Agent-MCP, chat-mcp/mcp-comms variants, Ruflo): Provide agents with identity, messaging, tasks and file locks. These are agents-room's direct relatives.
2. **Local parallel runners** (Claude Code agent teams, claude-squad, uzi, Conductor, vibe-kanban, container-use): Provide isolation on a single machine by giving each agent its own git worktree/container. Cross-machine coordination is absent or very weak.
3. **Application frameworks** (AutoGen/AG2/Microsoft Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, ChatDev, CAMEL, Swarms, OpenHands, Letta): Combine agents in code within a single process or service. They do not accept heterogeneous CLI agents (Claude Code, Codex, Hermes) as "participants", but they are very instructive in terms of orchestration patterns (supervisor, group chat, handoff, SOP).

Conclusion: **There is no mature open-source solution that delivers the combination "heterogeneous CLI agents + cross-machine + shared repo + task board + orchestrator loop" end to end.** The closest is the pairing of mcp_agent_mail (messages + file leases) and Beads (task graph). agents-room can fill this gap as a central room server over MCP Streamable HTTP.

## 2. Review of the solutions

### 2.1 Coordination layers (closest relatives)

**mcp_agent_mail (Dicklesworthstone)** — An "email-like" coordination MCP server for coding agents. The Python version has about 1.9k stars; there is also a Rust rewrite exposing 40 tools and 25 resources (`mcp_agent_mail_rust`, license "MIT + Rider").
- *Architecture:* A FastMCP-based server that runs over HTTP only (default port 8765). A Git repository holds the human-auditable archive (messages in `messages/YYYY/MM/<id>.md`, profiles, reservations); SQLite + FTS5 is used for indexing, search and conflict detection. Writes go to the database first, then to a Git commit, serialized with `.archive.lock` and `.commit.lock`.
- *Communication:* Agents get memorable identities such as "GreenCastle". There are thread-based inbox/outbox, CC/BCC, importance levels and an "ack required" flag. There is a `contact_policy` (open/request/closed) and an approval-based `request_contact` flow for cross-project communication.
- *Conflicts:* **Advisory file reservations (advisory leases).** They use glob patterns, have a TTL, and can be exclusive or shared. On conflict the reservation is still granted, but the conflict is reported. An optional **pre-commit guard** blocks commits that violate someone else's exclusive reservation. Paths are relative to the repo root.
- *Cross-machine:* Possible thanks to HTTP and Bearer/JWT (JWKS), but the design is focused on "one server, many projects".
- *Extras:* A `/mail` web UI, human "Overseer" messages, and an integration with Beads that uses a shared identifier (`bd-123`).
- *Takeaways:* The lease model (TTL + exclusive/shared + renew/release), the pre-commit guard, dual Git + SQLite storage, `program`/`model` fields in the agent profile, a human overseer channel.

**Beads (steveyegge/beads, MIT)** — A dependency-graph-based issue tracker for agents, stored in Git. Records live as JSONL under `.beads/`; hash-based IDs (`bd-a1b2`) prevent merge conflicts in multi-branch work. The `ready` command lists only work that is no longer blocked. *Takeaways:* conflict-resistant IDs, the "ready work" query, the dependency graph.

**Agent-MCP (rinadelph, AGPL-3.0, ~1.3k stars)** — An HTTP/WebSocket MCP server (`localhost:8000/mcp`). An admin agent breaks tasks down and distributes them to worker agents. Role-based authorization uses separate tokens for admin and worker. A persistent knowledge graph (RAG) holds the project context. There is file-level locking: 600-second timeout, with waiters queued. It also offers a real-time dashboard. *Takeaways:* the admin/worker token split, lock timeouts, the "atomic task = Step 1→N" rule, short-lived focused agents. *Caution:* Because of the AGPL license, its code must not be copied; only its ideas should be taken.

**"Chat room" MCP servers** (chat-mcp, mcp-comms, ClaudeChat, agent-chat-mcp, RogerRat) — Small projects offering channels/rooms, direct messages, broadcast and session discovery. mcp-comms lets Claude Code and Codex talk over a shared SQLite message log; RogerRat offers REST alongside MCP. Most are experimental and single-developer projects. *Takeaways:* the channel + DM + broadcast trio, "session discovery" (who is online?).

**Ruflo (formerly claude-flow, MIT, ~55k stars)** — A "meta-harness" for Claude Code: more than 300 MCP tools; mesh/hierarchical/ring/star topologies; consensus options such as Raft/Gossip/CRDT; AgentDB (SQLite + HNSW vector memory); cross-machine federation with mTLS + ed25519. *Caution:* Independent reviews note that much of the swarm execution is not yet wired end to end (spawning an agent only writes JSON, the hive-mind runs in a single process). *Takeaways:* the federation security model (mTLS, signed messages), hook-based context capture. *Not to take:* the excessive tool surface and the consensus protocols. For code agents, Git is already the single source of truth.

### 2.2 Local parallel runners

**Claude Code Agent Teams (experimental)** — Consists of a lead session and teammates. Tasks in the shared task list have the states pending/in progress/completed. Dependencies can be defined between tasks; when the dependencies complete, the waiting task is automatically unblocked. **It resolves the task claim race with a file lock.** The mailbox is a per-agent file at `~/.claude/teams/{team}/inboxes/{agent}.json`. The `TaskCreated`, `TaskCompleted` and `TeammateIdle` hooks are quality gates that can reject a task and return feedback via exit code 2. Limitations: single machine, one team per session, no nested teams, the lead cannot be handed over. Official recommendation: *"each teammate should own a different set of files"*, 3-5 teammates, 5-6 tasks per teammate. Messages between agents do not substitute for user approval. *Takeaways:* the task state machine, automatic unblocking via dependencies, the completion gate (hook), the idle notification carrying the final answer, the "agent message ≠ user approval" security principle.

**claude-squad (AGPL-3.0, ~8.6k stars)** — A TUI built on tmux and git worktrees. It supports Claude Code, Codex, Gemini and Aider. Each session runs on its own branch, and change sets are reviewed before being applied. **uzi (devflowinc, MIT)** — Opens a worktree per agent under `~/.local/share/uzi/worktrees/`. The branch name has the form `{agent}-{project}-{hash}-{timestamp}` and the tmux session `agent-{project}-{hash}-{agent}`. It auto-assigns ports from the 3000-4000 range and keeps state in `state.json`. `uzi checkpoint` rebases the agent's commits onto the current branch. *Takeaways:* deterministic branch/session naming, port assignment, checkpoint = rebase.

**Conductor (Melty Labs, closed source, free macOS app + Conductor Cloud)** — Runs Claude Code and Codex in isolated worktrees. The flow has three steps: add a repo, dispatch agents, review and merge the diffs. *Takeaways:* the UI pattern "see all active threads on one screen; show diff, test and error status side by side".

**vibe-kanban (BloopAI, Apache-2.0, ~28k stars)** — A kanban board with a Rust backend and a TypeScript frontend. Each task runs in a worktree. It exposes its own MCP server so agents can create and update tasks. It offers diff review, inline comments and AI-written PR descriptions. It supports more than 10 agent CLIs. Bloop shut down in April 2026; the project is maintained by the community ("sunsetting"). *Takeaways:* tying kanban states to the worktree lifecycle, the "task = workspace = branch = PR" mapping, task CRUD over MCP. The Apache-2.0 license makes it suitable for studying its UI patterns.

**container-use (Dagger, Apache-2.0, experimental)** — An MCP server that gives each agent **a fresh container and its own git branch**. Review is done with `git checkout <branch>`; command history and logs are retained. *Takeaways:* isolation one step beyond worktrees (it also prevents dependency, port and service conflicts). It could be considered as an optional "sandbox runtime" mode, especially for agents that run builds and tests.

### 2.3 Frameworks and protocols

| Solution | Communication model | Orchestration pattern | Lesson for agents-room |
|---|---|---|---|
| **AutoGen → AG2 / Microsoft Agent Framework** (AutoGen in maintenance mode since October 2025; MAF GA in April 2026) | Shared conversation (GroupChat) | Speaker selector (LLM, round-robin, custom) | A "next speaker" policy in the room; but structured messages should be preferred over free chat |
| **CrewAI** | Role-based crew; Crews + Flows | Hierarchical process: a manager LLM distributes tasks and validates the result | The "manager validates" step, i.e. orchestrator review |
| **LangGraph** | Shared graph state + checkpointer | Supervisor, human-in-the-loop via `interrupt()`, resume via `thread_id` | Persistent checkpoints; the orchestrator's plan can be resumed after a crash |
| **OpenAI Agents SDK** | Handoff (`transfer_to_<agent>`) and agents-as-tools | Manager or handoff | Codex exposes the `codex()`/`codex-reply()` tools via `codex mcp-server`; the orchestrator can drive Codex as a sub-agent over MCP |
| **MetaGPT** | **Shared message pool + publish/subscribe**, structured documents | SOP (PRD → design → task → code → QA) | Role-based subscription; messages being schema-based rather than free text |
| **ChatDev** | Two-party dialogue, "chat chain" | Phased waterfall | Two roles per phase (author + reviewer) |
| **CAMEL** | Role playing, inception prompting; Workforce | Task decomposition + worker pool | Writing role definitions as explicit "contracts" |
| **Swarms (Apache-2.0)** | Many composite patterns | SwarmRouter: sequential/concurrent/hierarchical/graph | Multiple dispatch strategies behind a single interface |
| **OpenHands (MIT)** | Agent-server; RemoteConversation over HTTP/WebSocket | Sub-agent delegation; Docker/K8s/Remote runtime | Remote runtime abstraction and event stream |
| **Letta** | **Shared memory block** (same `block_id`) + inter-agent messaging tools | Delegation / parallelization / synthesis | A room-scoped "shared notes/context block" (project decisions, rules) |
| **Google A2A (Linux Foundation, v1.0)** | JSON-RPC 2.0 / gRPC / HTTP+JSON; signed Agent Card (`/.well-known/agent-card.json`) | Task lifecycle: submitted → working → input-required → completed/failed/canceled/rejected | Task state names and the Agent Card (capability declaration) format can be adopted directly; an A2A bridge could be added later |
| **Hermes Agent (Nous Research, open source)** | v0.21 "Pantheon" (August 31, 2026): Bots Mode, group chats, cross-gateway `hermes peer` messaging; `delegate_task`, live subagent management | 10 concurrent sub-agents by default, response validation with JSON schema | Hermes supports stdio and remote HTTP MCP servers (including OAuth 2.1) as first-class, so it can connect to agents-room directly. The "messages persist in the canonical conversation" principle matches the agents-room room |

**MCP itself:** The **Tasks** primitive, introduced experimentally in the 2025-11-25 revision, is now defined as the `io.modelcontextprotocol/tasks` extension. For a long-running job (for example a subtask) the server returns a `taskId`; the client polls with `tasks/get`, supplies input with `tasks/update` in the `input_required` state, and cancels with `tasks/cancel`. Optionally, notifications can also be received via `notifications/tasks`. Because client support varies, agents-room should use this extension **optionally**; the authoritative persistent state should live on its own task board.

## 3. Takeaways: what we adopt and why

1. **The primary way to prevent conflicts is isolation; the secondary way is advisory locking.** All local tools rely on worktree/branch isolation, while coordination layers rely on file leases. The two should be used together: worktrees prevent physical overwrites, and leases make the risk of "two agents changing the same file and hitting a conflict at merge time" visible during planning.
2. **Claims must be atomic and time-bound.** The file lock in Claude Code and the 600-second timeout in Agent-MCP show that indefinite locks lead to deadlock when agents crash.
3. **Messages must be structured.** MetaGPT's SOP documents, A2A's task states and Hermes's JSON schema validation point in this direction. Free chat is for humans; machines need typed events.
4. **Git is the single source of truth.** The Git-stored archives of Beads and mcp_agent_mail demonstrate this. Everything about code should live in branches/PRs, while coordination state lives on the server (SQLite/Postgres).
5. **The human overseer must be a first-class participant.** The Overseer in mcp_agent_mail, the review screens in Conductor and vibe-kanban, and plan approval in Claude Code are examples of this.
6. **An agent message is not a delegation of authority.** Claude Code's security principle should carry over to agents-room: one agent's message cannot open another agent's permission gate.

## 4. agents-room reference architecture

### 4.1 Components

```
 [Claude Code]   [Codex CLI]   [Hermes Agent]   [Human / Web UI]
      \              |              /                 |
       \--- MCP Streamable HTTP ---/             HTTPS + SSE/WebSocket
                     |                                |
            +--------------------------------------------------+
            |  1. MCP Gateway  (auth, session, tool routing)     |
            +--------------------------------------------------+
            | 2. Room / Message Bus   | 3. Task Board (claim/lease)   |
            | 4. File Reservations    | 5. Presence / Heartbeat       |
            | 6. Artifact Store       | 7. Event Log                  |
            +--------------------------------------------------+
            |  Persistence layer: Postgres/SQLite + object store  |
            +--------------------------------------------------+
                     |                         |
               GitHub (repo, branch, PR,    8. Monitoring UI
               checks, webhooks)            (room, board, lease map)
```

1. **MCP Gateway:** The Streamable HTTP endpoint. It maps agent identity per session via `Mcp-Session-Id`. It exposes tools and resources: `inbox://{agent}`, `task://{id}`, `room://{id}/transcript`. For clients that support the Tasks extension it can return long-running jobs as task handles; for those that don't, it offers a polling or long-poll based `wait_for_events` tool.
2. **Room / Message Bus:** Room = meeting. Supports channel messages, direct messages (DM), broadcast, threads and `ack_required`. Messages are typed: `chat`, `plan`, `assignment`, `status`, `question`, `result`, `review`, `decision`. As in MetaGPT, there is role- and tag-based subscription; an agent pulls only relevant messages and its context window is preserved.
3. **Task Board:** Uses A2A-compatible states: `pending → claimed → working → input_required → review → completed | failed | canceled`. The dependency graph and the "ready" query are taken from Beads, as are the conflict-resistant short hash IDs. Each task has acceptance criteria, the file globs it is expected to touch, a branch name and a PR link.
4. **File Reservations (leases):** Glob-based, `exclusive|shared`, with a TTL, renewable and releasable. They are advisory; a violation produces a warning. "Soft enforcement" is provided by an optional pre-commit/pre-push guard installable in each repo and a GitHub check.
5. **Presence / Heartbeat:** The agent registration holds the fields `program`, `model`, `machine`, `capabilities` (similar to an A2A Agent Card), `max_parallel` and `status`. If heartbeats are missed, the agent first becomes "stale", then "offline"; task and file leases are reclaimed automatically when they expire and the task re-enters the queue.
6. **Artifact Store:** Plans, logs, test output, screenshots and summary reports are stored content-addressed (SHA) and referenced from messages. Code never lives here; code is always in Git.
7. **Event Log:** All state changes are recorded append-only. This serves both auditing and LangGraph-style resume-from-where-it-left-off; even if the orchestrator crashes, the plan and state can be restored.
8. **Monitoring UI:** Room transcript, kanban board, agent list (online/busy/stale), active lease map (which files are held by whom), PR and CI status. From here the human overseer can send messages, reassign tasks, force-release leases and give approvals.
9. **Auth:** The recommended setup is role-based authorization via OAuth 2.1 or a per-room invite token: `orchestrator`, `worker`, `observer`, `human-admin` (like the admin/worker split in Agent-MCP). GitHub access should use the credentials on the agent's own machine; the server should not centralize repo write access. Agent messages never substitute for permission or approval.

### 4.2 Core patterns

- **Claim-with-lease:** `claim_task(task_id)` is an atomic compare-and-set operation: it succeeds only for tasks in the `pending` state whose dependencies are resolved. It returns `lease_expires_at` (for example 15 minutes). The agent extends it with `renew` and shows liveness via heartbeat. If the lease expires, the task returns to `pending` and "lease expired" is written to the event log. Two agents cannot take the same task at the same time.
- **Advisory file reservations:** During planning, the orchestrator assigns expected file globs to each subtask. When starting work, the worker calls `reserve_files(globs, exclusive, ttl)`. On conflict the server does not refuse but reports the conflict; the agent either narrows its work or DMs the agent concerned. The guard checks at commit or PR time.
- **Worktree per agent:** Each worker opens one `git worktree` per task on its own machine (as in uzi, Conductor and claude-squad). For build- and test-heavy work, container isolation similar to container-use can optionally be used. A port range is assigned per machine to avoid port conflicts.
- **Branch naming:** `ar/<room-id>/<task-id>-<short-slug>` (example: `ar/r42/t-7f3a-auth-refresh`). The agent name goes into a commit trailer rather than the branch (`Agent: codex@host-b`, `Task: t-7f3a`), so the branch can stay the same when a task is reassigned. Short hash IDs are used, as in Beads.
- **One PR per subtask:** Each subtask is opened as a small PR against the integration branch (`ar/<room-id>/integration`) or directly against `main`. The PR description contains the task ID, acceptance criteria and test results. A GitHub webhook reflects PR and CI status into the task state (`review`, `completed`).
- **Orchestrator loop (plan → dispatch → collect → review):**
  1. *Plan:* The orchestrator breaks the goal into subtasks. For each subtask it sets acceptance criteria, file globs, dependencies and an estimated size. The plan is written to the room as a typed `plan` message; optionally, human approval (`input_required`) is awaited.
  2. *Dispatch:* Ready tasks are either assigned by capability matching (Agent Card) or opened for self-claim. The target is 1-2 active tasks per worker and 3-5 workers in total (Claude Code recommendation). Tasks with overlapping file globs are serialized.
  3. *Collect:* Workers send `status` and `result` messages. A result contains the PR URL, a summary, a test output artifact and open questions. Stuck or stale tasks are reassigned.
  4. *Review:* The orchestrator (or a separate reviewer agent) evaluates the PR against the acceptance criteria (CrewAI's "manager validates" and ChatDev's author/reviewer pair). The outcome is either a merge or a fix-up task. A `TaskCompleted`-style quality gate is applied: a task cannot become `completed` unless CI is green. The loop continues until all tasks are closed, and finally the integration PR is opened.
- **Idempotent and restartable operations:** All tools accept a `client_request_id`. The orchestrator state can be rebuilt from the event log.
- **Shared context block:** A "project rules / decisions" block is kept per room (like Letta's shared memory block). Every agent reads it when joining, and changes are made through `decision` messages.

### 4.3 Recommended out of scope

Consensus protocols (Raft/Byzantine), vector memory and a tool surface of hundreds of tools (Ruflo) are unnecessary in the first version. Git and the central server already provide ordering and correctness guarantees. A well-defined tool set limited to 10-15 tools per agent lowers both context cost and error rate.

## 5. Sources

- mcp_agent_mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- mcp_agent_mail (Rust): https://github.com/Dicklesworthstone/mcp_agent_mail_rust
- Beads: https://github.com/steveyegge/beads · https://www.mintlify.com/steveyegge/beads/introduction
- Agent-MCP: https://github.com/rinadelph/Agent-MCP
- Ruflo (claude-flow): https://alphasignalai.substack.com/p/how-ruflo-turns-claude-code-into · https://www.augmentcode.com/learn/ruflo-claude-code-multi-agent-orchestration · https://codex.danielvaughan.com/2026/04/09/claude-multi-agent-ecosystem/
- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams · Worktrees: https://code.claude.com/docs/en/worktrees
- claude-squad: https://github.com/smtg-ai/claude-squad
- uzi: https://mintlify.wiki/devflowinc/uzi/concepts/architecture · https://pkg.go.dev/github.com/devflowinc/uzi@v0.0.2
- Conductor: https://www.conductor.build/workflows · https://www.morphllm.com/conductor-ai-coding
- vibe-kanban: https://github.com/BloopAI/vibe-kanban · https://virtuslab.com/blog/ai/vibe-kanban/
- container-use: https://github.com/dagger/container-use
- Chat-room MCP servers: https://glama.ai/mcp/servers/thiagovictorino/chat-mcp · https://glama.ai/mcp/servers/ahmeda14960/mcp-comms · https://glama.ai/mcp/servers/zzibo/claudechat · https://libraries.io/pypi/agent-chat-mcp
- AutoGen / AG2 / Microsoft Agent Framework: https://atlan.com/know/ai-agent/what-is-autogen/ · https://futureagi.com/blog/what-is-autogen-2026/
- CrewAI hierarchical process: https://docs.crewai.com/en/learn/hierarchical-process
- LangGraph interrupts / HITL: https://docs.langchain.com/oss/python/langgraph/human-in-the-loop
- OpenAI Agents SDK: https://towardsdatascience.com/build-multi-agent-apps-with-openais-agent-sdk/ · Codex + Agents SDK: https://developers.openai.com/codex/guides/agents-sdk · https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
- MetaGPT: https://arxiv.org/html/2308.00352v7
- CAMEL: https://langchain-cn.readthedocs.io/en/latest/use_cases/agents/camel_role_playing.html
- Swarms: https://docs.swarms.world/api/swarm-router
- OpenHands: https://docs.openhands.dev/sdk/arch/conversation.md · https://arxiv.org/html/2407.16741v3
- Letta shared memory / multi-agent: https://docs.letta.com/guides/agents/multi-agent · https://docs.letta.com/guides/agents/shared-memory-blocks
- A2A: https://you.com/resources/a2a-protocol-explained-what-agent-to-agent-communication-solves · https://atlan.com/know/mcp/a2a-protocol-implementation-guide/
- Hermes Agent: https://hermes-agent.nousresearch.com/docs · https://runtimewire.com/article/nous-research-hermes-agent-pantheon-bot-mode · https://aiweekly.co/alerts/nous-research-ships-hermes-agent-v021-pantheon-with-bots-mode-agent-to-agent
- MCP Tasks: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks · https://github.com/modelcontextprotocol/ext-tasks · https://workos.com/blog/mcp-async-tasks-ai-agent-workflows
