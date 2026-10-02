# 01 — Messaging / transport protocol evaluation

**English** · [Türkçe](../tr/research/01-protokol-degerlendirmesi.md)

**Project:** agents-room — a shared meeting room where heterogeneous AI coding agents (Claude Code CLI, Codex CLI, Hermes Agent CLI) running on different machines sit at the same "table", exchange messages, take tasks from an orchestrator agent and report results.
**Agent interface:** MCP server (Streamable HTTP).
**Date:** 30 September 2026
**Question:** Which messaging/transport technology should be used beneath the MCP layer?

---

## 1. Summary

The deciding constraint is not the backend technology but **the agents' execution model**. All three CLI agents connect to the room only through MCP tool calls, and those calls work on a "pull" basis: the model cannot receive outside messages while it is thinking or running another tool. It only sees a message when it calls a tool. As a result, the strengths of push-based systems such as XMPP, Matrix and NATS (instant delivery, presence, fan-out) never reach the agent. They all end up as a queue behind an MCP tool.

Based on the evidence, the best option is: **a lightweight, custom SQLite-backed broker with an MCP Streamable HTTP server in front of it.** Agents connect to this server through a long-polling `wait_for_messages` tool. The data model is built on A2A v1.0 concepts (AgentCard, Task, Message/Part, Artifact, contextId). XMPP (MUC + MAM) and A2A remain optional bridges that can be added later. The direction the user expected is supported by the evidence, but some important caveats are noted below. Chief among them are MCP 2026-07-28 becoming stateless and the clients' timeout limits.

---

## 2. Realities on the agent side (as of 2026)

### 2.1 State of the MCP specification

- **2025-06-18 → 2025-11-25:** The 2025-11-25 release introduced experimental **Tasks** (SEP-1686, durable requests whose results can be queried later), URL-mode elicitation, tool calling inside sampling, and OIDC discovery.
- **2026-07-28 (latest release):** A major breaking change:
  - Protocol-level sessions and the `Mcp-Session-Id` header were removed. The `initialize` handshake was also removed, and MCP became **stateless**. Servers that need to keep state across calls are advised to carry explicit server-generated handles **as ordinary tool arguments** (SEP-2567).
  - The GET SSE endpoint and `resources/subscribe` were removed. They were replaced by `subscriptions/listen` (a long-lived POST response stream). This stream only carries list/resource *change* notifications.
  - SSE stream resumption (`Last-Event-ID`) was removed. When a stream drops, the in-flight request is lost and has to be resent.
  - The server-initiated `sampling/createMessage` and `elicitation/create` requests were removed. They were replaced by the MRTR pattern (an `input_required` result followed by a retry). Sampling, Roots and Logging were declared **deprecated**.
  - Tasks were moved out of the core protocol into an official extension (`io.modelcontextprotocol/tasks`). Status is obtained by polling with `tasks/get`.

**Implication for the project:** Even MCP itself is moving away from a push model toward a stateless, request-response, polling-based design. Designing a chat room as "the server pushes messages to the agent" runs against the direction of the specification. Who is connected to the room, the cursor and the membership information need to be carried as **explicit tool arguments** such as `agent_id`, `room_id` and `since_seq`. This matches the recommendation in MCP 2026-07-28 exactly.

### 2.2 Client behavior

| Client | Transport | Tool timeout | Does server push reach the model? |
|---|---|---|---|
| **Claude Code** | stdio, HTTP (recommended), SSE (deprecated), WebSocket | Idle timeout for HTTP is **5 min**; the total duration limit is set with `MCP_TOOL_TIMEOUT`. **Calls longer than 2 minutes are automatically moved to the background** (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). | `list_changed` is supported, but it only updates the tool list and does not wake the model. The exception is **Channels** (research preview): messages can be injected into the session with `notifications/claude/channel`. However, it is **stdio** only and requires an allowlist or the `--dangerously-load-development-channels` flag, plus a claude.ai login. |
| **Codex CLI** | stdio, Streamable HTTP (completed in April 2026), OAuth | `tool_timeout_sec` defaults to **60 s**, `startup_timeout_sec` defaults to 10 s | Elicitation/MRTR and `subscriptions/listen` are supported. However, change notifications do not trigger a model turn. |
| **Hermes Agent** | stdio, HTTP (with OAuth 2.1 support) | `timeout` defaults to **120 s**, `connect_timeout` defaults to 60 s | Sampling is supported. No documented mechanism was found for forwarding server notifications to the model. |

**Resulting design rules:**

1. The **default wait for `wait_for_messages` should be ~45–50 s**, adjustable via an argument, with a configurable upper limit. This stays below the 60 s default of Codex, the strictest client. If there are no messages, it should return an empty result and a `next_cursor`, and the agent should continue its loop.
2. Because Claude Code moves calls longer than 2 minutes to the background, short, repeated long-polls should be preferred over longer waits.
3. Claude Code Channels could be a feature added later for "nudges from the table". But because of the stdio requirement and its research preview status, it **cannot be the foundation of the architecture**. At most it is an optional add-on that could be provided through a local stdio bridge on each machine.
4. Watch the MCP tool output limits (25k tokens by default in Claude Code). Message history should be returned paginated and summarized.

---

## 3. Candidate technologies

### 3.1 XMPP (ejabberd / Prosody; MUC XEP-0045, MAM XEP-0313, PubSub XEP-0060)
- **Pros:** Rooms (MUC), presence, archiving and history replay (MAM), pub/sub and federation come out of the box, backed by more than 25 years of standardization. ejabberd 26.x (February–March 2026) and Prosody 13.0.x are actively developed. Prosody 13.0.4 simplified MUC archiving configuration. There is also agent-focused work: Fluux Agent (an agent runtime on top of XMPP, February 2026) and discussions about using MUC as an agent coordination surface.
- **Cons:** Presence and instant delivery are worthless for a pull-based LLM agent. Even if the agent appears "online", it cannot read messages while thinking. The MCP bridge would have to maintain a persistent XMPP session (JID, stream management, MAM query) for each agent. This creates friction with the stateless model of MCP 2026. There is no equivalent of the Task and Artifact concepts; a custom XEP or payload would have to be defined. The operational burden is also medium to high: an Erlang/Lua server, TLS and DNS/SRV records.
- **Verdict:** Powerful, but more than what is needed. It makes sense as a **bridge to be added later** so that people can watch the table with their existing Jabber clients, or for federation.

### 3.2 Matrix
- **Pros:** Rooms, threads, a persistent event graph, E2EE and federation. The specification is active (v1.17 in December 2025, v1.18/v1.19 in 2026). Bot SDKs are mature.
- **Cons:** Running a homeserver (Synapse, Conduit) is heavy. The event graph and room state resolution add unnecessary complexity for this scenario. E2EE is a separate source of problems for bots. There is no task lifecycle.
- **Verdict:** Usable for shared human-agent chat. Expensive for agent-to-agent task coordination.

### 3.3 MQTT (v5)
- **Pros:** Very lightweight. Mosquitto and EMQX are mature. The topic hierarchy maps well to rooms. Retained messages and LWT (last will) provide simple presence.
- **Cons:** No real history/replay. Retained stores only the last message, and persistent session queues are per client. History requires a separate database. No concept of querying or threads.
- **Verdict:** Ideal for IoT, insufficient for chat history and task tracking.

### 3.4 NATS / JetStream
- **Pros:** A single binary. JetStream provides persistent streams, durable consumers (per-agent inbox), history replay for late joiners, work queues and KV. JWT-based decentralized authentication and NAT traversal via leaf nodes are strong. The agent ecosystem grew quickly in 2026: **Synadia NATS Agent Protocol v0.3** (May 2026; discovery, conversation, heartbeat) and **Cotal** (August 2026; a "shared space" standard on top of JetStream, durable agent inboxes).
- **Cons:** These agent standards are very young (v0.x) and have no official bridge to MCP or A2A. In a single-server setup with a few agents, it means an extra infrastructure component. In the end, polling would still be done through MCP tools.
- **Verdict:** **The strongest upgrade path when scaling is needed.** The broker's storage layer could later be moved from SQLite to JetStream. The design should leave this door open (append-only seq, cursor and durable consumer semantics).

### 3.5 Redis Streams
- **Pros:** `XADD`/`XREAD BLOCK` fit long-polling naturally. Consumer groups, ACKs and ID-based replay are available. A very well-known technology.
- **Cons:** Persistence is memory-oriented by default (requires AOF/RDB configuration). Relational querying (tasks, artifacts, search) is weak. It means a separate service.
- **Verdict:** Usable, but offers no clear gain over SQLite.

### 3.6 Custom broker: WebSocket/HTTP + SQLite/Postgres
- **Pros:** The data model can be shaped exactly to the need: rooms, threads, tasks, artifacts and agent cards. The MCP server and the broker can run **in the same process**, so the bridging cost is zero. SQLite (WAL) enables single-file persistence, replay via a monotonic `seq`, and search with FTS5. Long-polling is easy to build with an in-process condition variable or event. There is no NAT problem, because all agents connect outbound to a single HTTPS endpoint. The endpoint can be exposed with Tailscale or Cloudflare Tunnel. Similar projects show that this approach works: **MCP Agent Mail** (HTTP FastMCP, SQLite and Git; inbox and file leasing for coding agents) and **agent-inbox** (SQLite inbox).
- **Cons:** Features such as presence, authorization, backups and multi-node deployment have to be written ourselves. There is no interoperability standard. This gap can be closed with an A2A-compatible data model.
- **Verdict:** **The recommended foundation.**

### 3.7 IRC
- **Pros:** Extremely simple, with an intuitive channel model.
- **Cons:** No server-side history (IRCv3 `chathistory` is not widely deployed). No structured payloads, authentication or task concept. Line-based, length-limited messages are not suitable for code output.
- **Verdict:** Eliminated.

### 3.8 A2A (Agent2Agent) v1.0
- **Status:** The specification was frozen as **v1.0** on 12 March 2026. After the Linux Foundation, it joined the **Agentic AI Foundation** (the same umbrella as MCP) on 17 August 2026. More than 150 organizations support it and there are SDKs in five languages. Bindings: JSON-RPC, gRPC and HTTP+JSON. Status tracking is done via polling (GetTask), SSE streaming (SubscribeToTask) or webhook push.
- **Data model:** AgentCard, Task (`id`, `contextId`, `status`, `artifacts`, `history`), Message (`role`, `parts`, `taskId`, `referenceTaskIds`), Part (text, file, data) and Artifact. Task states: SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED.
- **Mismatch:** A2A works 1:1 as **client → remote agent server**. It has no concept of group chat or multi-party rooms. It also expects every agent to be an A2A *server*, i.e. to expose an HTTP endpoint. Our CLI agents, however, are clients, not servers. Push notification webhooks also do not work on machines behind NAT.
- **Verdict:** **It should be used not as the transport layer, but as the data model and as a future bridge to the outside world.** If work dispatched by the orchestrator maps one-to-one to A2A Tasks, the room chat to a `contextId` and reports to Artifacts, an A2A gateway can be added very cheaply later.

### 3.9 ACP (IBM / BeeAI)
- Launched in March 2025 as a REST-based protocol. **It merged into A2A in August 2025.** Active development stopped; A2A adapters for BeeAI and a migration guide were published.
- **Verdict:** Eliminated (merged into A2A).

### 3.10 ANP (Agent Network Protocol)
- A decentralized agent network based on W3C DID (did:wba, did:web, did:webvh) and JSON-LD, designed for the open internet. It is still being discussed at draft stage in the W3C AI Agent Protocol Community Group (July 2026 meetings).
- **Verdict:** Heavy and immature for a closed, trusted team environment. Eliminated.

### 3.11 MCP itself (as transport)
- MCP is an agent↔tool protocol. It does not define agent↔agent or room semantics. Streamable HTTP carries a single request-response pair. 2026-07-28 removed sessions and resumability. Sampling (the server calling the agent's LLM) is deprecated. Hermes supports it, but in Claude Code and Codex it is not possible to "deliver a message to the agent" this way. Elicitation is meant for human approval, not for messages between agents.
- **Verdict:** **Mandatory as the agent-facing interface, insufficient as the backend transport.** Room semantics should live in the broker behind the MCP tools.

---

## 4. Comparison table

Scoring: 1 (weak) – 5 (strong). In the "Operational simplicity" row, a higher score means less operational burden. "Pull-model fit" shows how naturally the technology fits the LLM agent's polling/long-poll loop.

| Criterion | XMPP | Matrix | MQTT | NATS/JS | Redis Str. | **Custom broker + SQLite** | IRC | A2A | ANP | MCP (alone) |
|---|---|---|---|---|---|---|---|---|---|---|
| Pull-model fit (long-poll) | 2 | 3 | 2 | 4 | 5 | **5** | 1 | 3 | 2 | 3 |
| Persistence / history replay | 4 (MAM) | 5 | 1 | 5 | 4 | **5** | 1 | 3 | 2 | 1 |
| Room / thread model | 5 | 5 | 3 | 3 | 2 | **5** (by design) | 3 | 2 (contextId, not multi-party) | 2 | 1 |
| Task / artifact semantics | 1 | 1 | 1 | 2 | 1 | **5** (A2A model) | 1 | 5 | 3 | 3 (Tasks extension) |
| Presence | 5 | 4 | 3 (LWT) | 4 (heartbeat) | 2 | 3 (last_seen + heartbeat) | 3 | 1 | 1 | 1 |
| Authentication / authorization | 4 | 4 | 3 | 5 | 3 | 4 (Bearer/OAuth, shared with MCP) | 1 | 5 | 4 | 4 |
| NAT traversal (different machines) | 4 | 4 | 4 | 5 | 3 | **5** (single outbound HTTPS) | 4 | 2 (push webhook) | 2 | 5 |
| Operational simplicity | 2 | 1 | 4 | 4 | 4 | **5** | 4 | 3 | 1 | 5 |
| Ecosystem maturity | 5 | 4 | 5 | 4 (agent std. v0.x) | 5 | 2 (our own) | 3 | 4 (v1.0, new) | 1 | 5 |
| Ease of MCP bridging | 2 | 2 | 3 | 3 | 4 | **5** (same process) | 2 | 3 | 1 | – |
| **Total (/50)** | **34** | **33** | **29** | **39** | **33** | **44** | **23** | **31** | **19** | *(interface, not ranked)* |

**Interpretation:** The custom broker leads on total score. It trails only in the "ecosystem maturity" and "presence" columns, and these two gaps are closed by the A2A-compatible data model and a simple heartbeat, respectively. NATS/JetStream is a clear second and the natural upgrade path when scaling is needed. XMPP and Matrix are strong in human-facing chat features. However, those strengths do not carry over to pull-based agents, and the price is paid in operational burden.

---

## 5. Analysis: why a "smart data model" instead of a "smart transport"

1. **Push cannot reach the agent's context.** Whichever broker is chosen, a message reaches the agent only as an MCP tool result. In that case the broker's push capability only serves to wake up the long-poll inside the MCP server. That is solved with an event inside a single process.
2. **Stateless MCP requires an explicit cursor model.** MCP 2026-07-28 removed sessions and SSE resumability. Reliable delivery now depends on the client sending its `since_seq` cursor and the server returning "everything after this cursor". This comes naturally with a monotonic `seq` column in SQLite or with a JetStream sequence number. In XMPP and Matrix, it requires a translation layer.
3. **Timeouts limit waiting.** Codex 60 s, Hermes 120 s, Claude Code HTTP 5 min idle and backgrounding after 2 min. With a 45–50 s long-poll, these values force a "is there anything new?" loop on every agent turn. That is why `wait_for_messages` must be cheap, idempotent and cursor-based.
4. **The task lifecycle matters more than chat.** The orchestrator → task → progress → result flow maps one-to-one to A2A's Task state machine. In XMPP and Matrix, this structure remains free text or a custom payload. Keeping the state machine in the broker under A2A names (SUBMITTED, WORKING, INPUT_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED) both offers LLMs an understandable contract and makes a future bridge to A2A mechanical.
5. **Hub-and-spoke eliminates the NAT problem.** Because all agents connect outbound to a single HTTPS endpoint, no peer-to-peer (P2P), STUN/TURN or federation is needed. The endpoint can be exposed with Tailscale or Cloudflare Tunnel. A per-agent Bearer token (Claude Code `headers`/`headersHelper`, Codex and Hermes HTTP headers) is enough for authentication. Moving to MCP's OAuth 2.1 flow is possible later.
6. **Security: the room is a prompt injection surface.** The Claude Code Channels documentation itself explicitly states that an ungated channel is a prompt injection vector. Another agent's message must be *data* for the receiving agent, not *instructions*. The broker should authenticate every message by sender identity (by sender, not by room). It should clearly label messages in tool results as "content from agent X". It should also restrict task assignment by agents other than the orchestrator through permissions.

---

## 6. Final recommendation

**Core architecture:**
- **A single process:** The MCP Streamable HTTP server and an embedded broker run together. Storage uses SQLite (WAL mode, FTS5 for search). The message table is append-only and advances with a monotonic `seq` per room.
- **Tool surface (conceptual):** `join_room` / `leave_room`, `post_message`, `wait_for_messages(room, since_seq, timeout_s≤50)`, `get_history` (paginated), `create_task` / `update_task_status` / `submit_artifact`, `list_agents` (AgentCard and last_seen). All state (agent identity, room, cursor) is carried as **explicit arguments**. This is compatible with MCP 2026-07-28 and with older 2025-06-18/2025-11-25 clients.
- **Data model:** A2A v1.0 concepts. Room or meeting = `contextId`, work item = `Task` (with A2A state names), message = `Message{role, parts[]}`, output = `Artifact`, participant = `AgentCard` (name, skills, host machine, client type).
- **Presence:** `last_seen` is updated on every tool call, and there is also a heartbeat tool. Classification is "active / busy (on a task) / quiet". No claim of real-time presence is made.
- **Network:** A single HTTPS endpoint (Tailscale or Cloudflare Tunnel) and a per-agent Bearer token.

**Roadmap (optional bridges):**
1. **A2A gateway.** Exposes the room's Tasks/Artifacts to external A2A agents and admits external A2A agents into the room as "guests". Because the data model is the same, the conversion cost is low.
2. **XMPP (MUC + MAM) bridge.** So that people can watch and post to the table with Jabber clients, or for enterprise federation.
3. **Migration to NATS/JetStream.** When many agents, multiple broker nodes or high volume are needed, the storage and distribution layer moves to JetStream. If Cotal and NATS Agent Protocol mature, compatibility with them can also be considered.
4. **"Nudges" via Claude Code Channels.** If it leaves research preview status, it can be added to wake a Claude Code session on new messages through a local stdio bridge. This would be an optimization, not the core mechanism.

**Conditions that could change this recommendation:** (a) If MCP clients standardize forwarding server events to the model as turns (currently this exists only experimentally, in Claude Code Channels), the value of push-based backends increases. (b) If the team grows the number of agents into the tens and across multiple regions, starting directly with NATS/JetStream becomes more economical. (c) If the primary users are people and agents remain secondary, Matrix or XMPP become more sensible.

---

## 7. Sources

**MCP**
- MCP 2026-07-28 Changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Changelog (latest): https://modelcontextprotocol.io/specification/latest/changelog
- MCP 2025-11-25 changes: https://modelcontextprotocol.info/specification/2025-11-25/changelog/
- Claude Code MCP documentation (transports, timeouts, list_changed, output limits): https://code.claude.com/docs/en/mcp
- Claude Code Channels reference: https://code.claude.com/docs/en/channels-reference.md
- Claude Code MCP timeout issues: https://github.com/anthropics/claude-code/issues/20335 , https://claudeissues.com/issue/69487-bug-mcp-tool-call-wedges-indefinitely-without-client-side-timeout-cli-no-mcp-too
- Codex CLI MCP documentation: https://developers.openai.com/codex/mcp.md
- Codex CLI Streamable HTTP: https://codex.danielvaughan.com/2026/04/20/remote-mcp-http-codex-cli-enterprise-tool-services/
- Codex CLI and MCP 2026-07-28: https://codex.danielvaughan.com/2026/08/31/mcp-2026-07-28-stateless-protocol-codex-cli-operators-guide/
- Codex CLI MCP maturation (elicitation, resources): https://codex.danielvaughan.com/2026/04/11/codex-cli-mcp-maturation-resource-reads-outputschema/
- Hermes Agent MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- Hermes MCP configuration: https://www.mintlify.com/NousResearch/hermes-agent/user-guide/features/mcp

**Agent protocols**
- A2A specification (v1.0.0): https://a2a-protocol.org/latest/specification/
- A2A v1.0 Builder's Guide (AAIF): https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients
- A2A's first year (Linux Foundation): https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- ACP → A2A merger: https://tyk.io/learning-center/agent-protocols-a-complete-guide-to-mcp-a2a-and-acp/ , https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026
- ANP / W3C AI Agent Protocol CG: https://lists.w3.org/Archives/Public/public-agentprotocol/2026Jul/0010.html , https://atlan.com/know/mcp/how-to-choose-mcp-a2a-anp/

**Messaging infrastructure**
- NATS Agent Protocol: https://nats.io/blog/nats-native-protocol-for-ai-agents/
- Cotal (agent teams on NATS): https://nats.io/blog/coordinating-ai-agent-teams-on-nats/
- XMPP MUC: https://wiki.xmpp.org/web/Tech_pages/Multi-User_Chat
- Prosody 13.0.4: https://blog.prosody.im/prosody-13.0.4-released/
- ejabberd 26.3.0: https://hex.pm/packages/ejabberd/26.3.0 ; roadmap: https://docs.ejabberd.im/roadmap/
- Matrix v1.17: https://matrix.org/blog/2025/12/18/matrix-v1.17-release/ ; releases: https://matrix.org/blog/category/releases

**Similar projects**
- MCP Agent Mail: https://glama.ai/mcp/servers/@Dicklesworthstone/mcp_agent_mail/blob/5fa08841bb5783e805d166bec4754a72b6dc1ac8/README.md
- agent-inbox: https://pypi.org/project/agent-inbox/0.13.3/
