# 03 — Client integration (Claude Code, Codex CLI, Hermes Agent)

**English** · [Türkçe](../tr/research/03-istemci-entegrasyonu.md)

> Date: 2026-09-30. Scope: connecting the `agents-room` MCP server (Streamable HTTP, `http://HOST:7700/mcp`, `Authorization: Bearer <token>`) to three clients; distributing a shared "skill" package; running headless; timeout (long-poll) settings.
>
> Sources: local inspection (`claude` v2.1.278, `hermes` v0.21.2 — the docs and source code in `~/.hermes/hermes-agent`), official web docs (code.claude.com, learn.chatgpt.com / developers.openai.com, agentskills.io). Codex CLI is **not installed** on this machine; the Codex information is based on web docs only.

In the examples below the token is read everywhere from an environment variable: `AGENTS_ROOM_TOKEN`. The server name is `agents-room` in every client (in Hermes the tool names become `mcp_agents_room_<tool>`).

---

## 0. Summary table

| | Claude Code | Codex CLI | Hermes Agent |
|---|---|---|---|
| MCP config file | `~/.claude.json` (user/local) or `.mcp.json` at the project root | `~/.codex/config.toml` or project `.codex/config.toml` | `~/.hermes/config.yaml` (`mcp_servers:`) |
| Streamable HTTP | Yes (`"type": "http"`, alias `streamable-http`); SSE deprecated but supported | Yes (`url` = streamable HTTP). The legacy SSE transport is not documented | Yes (default); legacy SSE via `transport: sse` |
| Bearer header | `headers` / `--header` / `headersHelper` | `bearer_token_env_var` (or `http_headers` / `env_http_headers`) | `headers` (`${VAR}` is expanded, including `~/.hermes/.env`) |
| Env var expansion | `${VAR}`, `${VAR:-default}` (`url`, `headers`, `command`, `args`, `env`) | Via `bearer_token_env_var`, `env_http_headers` | `${VAR}` / `${env:VAR}` in every string field |
| Default tool call timeout | Wall-clock ~28 hours, **idle 5 min (HTTP)**, **per-request first byte ≥60 s** | **60 s** (`tool_timeout_sec`) | **300 s** (`timeout`) |
| Skills directory (user) | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` (legacy: `~/.codex/skills`, deprecated) | `~/.hermes/skills/<name>/SKILL.md` (+ `skills.external_dirs`) |
| Skills directory (project) | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.hermes/skills/` or `.agents/skills/` (run `hermes skills trust` first) |
| Project instructions file | `CLAUDE.md` | `AGENTS.md` | `.hermes.md` → `AGENTS.md` → `CLAUDE.md` (first one found) |
| Agent Skills (agentskills.io) | Yes (extends the standard) | Yes | Yes |
| Headless | `claude -p ... --output-format stream-json --verbose` | `codex exec --json ...` | `hermes -z "..."` or `hermes chat -q "..." -Q` |

---

## 1. Claude Code CLI

### 1.1 `claude mcp add` (HTTP + header)

From the local `claude mcp add --help` output (v2.1.278):

```
  -H, --header <header...>     Set headers for HTTP/SSE servers (e.g. -H
                               "X-Api-Key: abc123" -H "X-Custom: value")
  -s, --scope <scope>          Configuration scope (local, user, or project)
                               (default: "local")
  -t, --transport <transport>  Transport type (stdio, sse, http). Defaults to
                               stdio if not specified.
```

For agents-room:

```bash
# User scope (all projects) — the token is written to ~/.claude.json in plain text
claude mcp add --scope user --transport http agents-room http://HOST:7700/mcp \
  --header "Authorization: Bearer $AGENTS_ROOM_TOKEN"

# Check
claude mcp list
claude mcp get agents-room
```

Scopes: `local` (default, stored in `~/.claude.json`, that project only), `project` (`.mcp.json` at the project root, goes into git), `user` (`~/.claude.json`, all projects).

> Note: when adding with `--scope project`, the shell expands `$AGENTS_ROOM_TOKEN` and the literal value is written. Write the `.mcp.json` you will share with the team **by hand** and leave `${AGENTS_ROOM_TOKEN}` in it (see below).

### 1.2 `.mcp.json` (project root) — header + env expansion

Format from the official docs:

```json
{
  "mcpServers": {
    "api-server": {
      "type": "http",
      "url": "${API_BASE_URL:-https://api.example.com}/mcp",
      "headers": {
        "Authorization": "Bearer ${API_KEY}"
      }
    }
  }
}
```

Supported expansion: `${VAR}` and `${VAR:-default}`; fields: `command`, `args`, `env`, `url`, `headers`. The `"type"` field accepts `streamable-http` as an alias of `http`.

Recommended `.mcp.json` for agents-room:

```json
{
  "mcpServers": {
    "agents-room": {
      "type": "http",
      "url": "${AGENTS_ROOM_URL:-http://HOST:7700/mcp}",
      "headers": {
        "Authorization": "Bearer ${AGENTS_ROOM_TOKEN}"
      },
      "timeout": 600000
    }
  }
}
```

Caveats:
- In a remote server's `url`/`headers` fields, certain "credential" variables (e.g. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `NPM_TOKEN`, `HTTPS_PROXY` …) **are read as empty**. `AGENTS_ROOM_TOKEN` is not on that list, so it is fine; just don't put the token in one of those names.
- In an interactive session, approval is requested for project `.mcp.json` servers. With `claude -p` / the Agent SDK they load without approval.
- If you need short-lived tokens, you can use `headersHelper` (a command that prints a JSON header object to stdout, 10 s timeout):

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://mcp.internal.example.com",
      "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
    }
  }
}
```

- For `http://` + a non-loopback host, `claude plugin validate` issues a warning (only a warning). If traffic leaves the LAN, consider TLS.

### 1.3 Timeouts — CRITICAL for long-poll tools

According to the official docs (code.claude.com/docs/en/mcp) there are three separate timers:

1. **Wall-clock limit**: `"timeout"` (ms) in the server entry, or `MCP_TOOL_TIMEOUT` (ms). If not set, ~28 hours. Values below 1000 are ignored. Progress notifications do **not** extend it.
2. **Per-request timer (HTTP/SSE only)**: "each request through to the server's first response byte". Value: max(60 s, the tool timeout applied to the server, `MCP_TIMEOUT`). **If `MCP_TOOL_TIMEOUT` is not set, the 28-hour default does not enter this comparison → in practice 60 s.**
3. **Idle timeout**: time elapsed without a response or progress notification. Default **5 min** for HTTP, 30 min for stdio. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms, `0` = off). If the per-server `timeout` is ≥1000, it becomes the floor for the idle timeout (v2.1.203+).

Additional behavior: in the interactive main session, an MCP call exceeding 2 minutes is automatically moved to the background (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `0` = off; v2.1.212+). **In `-p` (non-interactive) mode it is not backgrounded** (except with `CLAUDE_AUTO_BACKGROUND_TASKS=1`).

Environment variables:

```bash
MCP_TIMEOUT=10000 claude                          # server startup/connect
MCP_TOOL_TIMEOUT=600000 claude                    # global tool timeout (ms)
CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=300000 claude   # idle window (ms)
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=120000 claude  # auto-background threshold
MAX_MCP_OUTPUT_TOKENS=50000 claude
```

**Impact on the agents-room design:**
- If the long-poll (`wait_for_messages` etc.) is capped at **≤ 50 s** on the server side, no settings are needed (below the 60 s per-request timer, the 5 min idle timeout and the 60 s Codex default).
- If longer waits are wanted: the server should open the response immediately as `text/event-stream` (so the first byte arrives early) and send `notifications/progress` roughly every 30 s (this resets the idle timer); on the client side, the per-server `"timeout"` should be set.
- Safest: keep the long-poll short and describe the "if empty, call again" loop in the skill instructions.

### 1.4 Tool names and permissions

- Format: `mcp__<server>__<tool>` → e.g. `mcp__agents-room__join`.
- Server shipped via a plugin: `mcp__plugin_<plugin>_<server>__<tool>`.
- In a permission rule / `--allowedTools`, `mcp__agents-room` covers all tools.

### 1.5 Skills (Claude Code)

Claude Code docs: "Claude Code skills follow the Agent Skills open standard". Locations:

| Scope | Path |
|---|---|
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` |
| Project | `.claude/skills/<skill-name>/SKILL.md` (parent directories from cwd up to the repo root are scanned too) |
| Enterprise | `.claude/skills/<skill-name>/SKILL.md` in the managed settings directory |
| Plugin | `<plugin>/skills/<name>/SKILL.md` → `/plugin-name:skill-name` |

- Claude Code **does not read the `.agents/skills` directory** (not in the docs). To feed it from the shared directory, use a symlink (e.g. `ln -s ~/.agents/skills/agents-room ~/.claude/skills/agents-room`; test that the symlink works) or distribute via a plugin.
- The user can invoke it with `/agents-room`; in `-p` mode `/skill-name` inside the prompt is expanded as well.
- Claude-specific frontmatter fields (`allowed-tools`, `disable-model-invocation`, `user-invocable`, `context: fork`, `argument-hint`, `model`, `effort`, `when_to_use`…) work in Claude Code; for portability use only the standard fields (see §4).
- If `.claude-plugin/plugin.json` is added to the skill directory, it is loaded as a plugin named `<name>@skills-dir` (it can also package an MCP server).

### 1.6 Plugin + marketplace (distributing skill + MCP in one package)

Plugin layout:

```text
agents-room-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── agents-room/
│       └── SKILL.md
└── .mcp.json
```

`.claude-plugin/plugin.json` (with `userConfig`, asking the user for the token and storing it in secure storage):

```json
{
  "name": "agents-room",
  "version": "0.1.0",
  "description": "agents-room MCP chat room + task-claiming skill",
  "author": { "name": "Aydin Ozturk" },
  "userConfig": {
    "server_url": {
      "type": "string",
      "title": "agents-room URL",
      "description": "e.g. http://HOST:7700/mcp",
      "default": "http://HOST:7700/mcp"
    },
    "token": {
      "type": "string",
      "title": "agents-room token",
      "description": "Bearer token",
      "sensitive": true
    }
  }
}
```

`.mcp.json` at the plugin root:

```json
{
  "mcpServers": {
    "agents-room": {
      "type": "http",
      "url": "${user_config.server_url}",
      "headers": { "Authorization": "Bearer ${user_config.token}" },
      "timeout": 600000
    }
  }
}
```

(`${user_config.KEY}` is expanded in the MCP server config; `sensitive: true` values are stored in the system keychain instead of `settings.json`. `${user_config.*}` cannot be used inside `headersHelper`.) In this case the tool names become `mcp__plugin_agents-room_agents-room__<tool>`.

Marketplace: `.claude-plugin/marketplace.json` at the repo root:

```json
{
  "name": "agents-room-marketplace",
  "description": "agents-room eklentileri",
  "owner": { "name": "Aydin Ozturk" },
  "plugins": [
    {
      "name": "agents-room",
      "source": "./plugins/agents-room",
      "description": "agents-room MCP + skill"
    }
  ]
}
```

Source types: relative path, `{ "source": "github", "repo": "org/repo" }`, `{ "source": "git-subdir", "url": "org/monorepo", "path": "tools/x" }`, plus `url`, `archive`, `npm`, `command`.

Commands:

```bash
claude plugin validate ./agents-room-marketplace
claude plugin marketplace add ./agents-room-marketplace     # or: claude plugin marketplace add <owner>/<repo>
claude plugin install agents-room@agents-room-marketplace
claude plugin list
# inside a session: /plugin marketplace add ...  /plugin install agents-room@agents-room-marketplace
# one-off (without installing): claude --plugin-dir ./agents-room-plugin
```

The entry `name` must match the `plugin.json` `name`.

### 1.7 Headless (`claude -p`)

```bash
claude -p "join the agents-room room, take the pending task and carry it out" \
  --mcp-config ./agents-room.mcp.json --strict-mcp-config \
  --allowedTools "mcp__agents-room,Read,Edit,Bash(git *)" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose
```

- `--output-format`: `text` | `json` (single result; `session_id`, `total_cost_usd`) | `stream-json` (NDJSON; with `--verbose`, and `--include-partial-messages` for token streaming).
- `--input-format stream-json`: real-time streaming input from stdin.
- `--permission-mode`: `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`, `manual`… The `-p` default is Manual; in `-p`, anything that requires approval is denied.
- `--dangerously-skip-permissions`: skips all permission checks (sandbox only).
- `--permission-prompts none` (v2.1.259+): turns off prompts in unattended runs.
- `--bare`: skips auto-discovery of hooks/skills/plugins/MCP/CLAUDE.md; in that case pass MCP with `--mcp-config` and plugins with `--plugin-dir`, and `ANTHROPIC_API_KEY` is required.
- With `--mcp-config` in `-p`, pending servers are waited for up to `MCP_TIMEOUT` (default 30 s) before the first turn. Entries that fail validation are reported in the `mcp_server_errors` field of the `system/init` event — check this in CI.
- Continue: `--continue`, `--resume <session_id>`.
- For an agent loop: `session_id=$(claude -p "..." --output-format json | jq -r '.session_id')` then `claude -p "..." --resume "$session_id"`.

---

## 2. OpenAI Codex CLI

### 2.1 `~/.codex/config.toml`

Official config reference: `mcp_servers.<id>.url` = "Endpoint for an MCP streamable HTTP server."

Examples from the docs:

```toml
[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
```

```toml
[mcp_servers.chrome_devtools]
url = "http://localhost:3000/mcp"
enabled_tools = ["open", "screenshot"]
disabled_tools = ["screenshot"]
default_tools_approval_mode = "prompt"
startup_timeout_sec = 20
tool_timeout_sec = 45
enabled = true

[mcp_servers.chrome_devtools.tools.open]
approval_mode = "approve"
output_token_limit = 30000
```

For agents-room:

```toml
[mcp_servers.agents-room]
url = "http://HOST:7700/mcp"
bearer_token_env_var = "AGENTS_ROOM_TOKEN"   # -> Authorization: Bearer <value>
startup_timeout_sec = 20
tool_timeout_sec = 900                        # default is 60 s! increase it for long-poll
default_tools_approval_mode = "approve"       # works around the approval problem in exec mode (see 2.4)
required = true                               # make exec fail if the server cannot start
```

Alternatives: `http_headers = { "Authorization" = "Bearer ..." }` (static) or `env_http_headers = { "X-Room-Token" = "AGENTS_ROOM_TOKEN" }` (header name → env variable name).

Fields (summary): `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `startup_timeout_sec` (default 10), `tool_timeout_sec` (default 60), `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` (`auto` | `prompt` | `writes` | `approve`; `writes` asks for tools not marked read-only), `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`.

TOML note: a table name containing a hyphen (`agents-room`) is valid as a bare key; if it causes trouble, use `[mcp_servers."agents-room"]` or `agents_room`.

Project-scoped: `.codex/config.toml` at the repo root (trusted projects only).

### 2.2 Adding via the CLI

```bash
codex mcp add agents-room --url http://HOST:7700/mcp --bearer-token-env-var AGENTS_ROOM_TOKEN
codex mcp list
# for servers that use OAuth: codex mcp login <name>
```

`codex mcp add` flags: `--url`, `--env KEY=VALUE`, `--bearer-token-env-var`, `--oauth-client-id`, `--oauth-resource`; for stdio, the command after `--`. (`timeout` and approval settings go in config.toml, not CLI flags.)

### 2.3 Streamable HTTP status

Codex documents two transports: STDIO and Streamable HTTP. The legacy separate-endpoint SSE transport is not mentioned in the docs; serving agents-room as **Streamable HTTP** is sufficient and correct. (The `experimental_use_rmcp_client` flag from older versions is absent from the current docs.)

### 2.4 Headless: `codex exec`

```bash
export AGENTS_ROOM_TOKEN=...
codex exec --json --sandbox workspace-write \
  -c 'mcp_servers.agents-room.tool_timeout_sec=900' \
  -o last.txt \
  "join the agents-room room, take the pending task and carry it out"
```

- `--json`: JSONL events (`thread.started`, `turn.started`, `item.*`, `turn.completed`).
- `-o/--output-last-message <path>`, `--output-schema <file>`.
- `--sandbox read-only|workspace-write|danger-full-access` (the exec default is read-only). `--full-auto` is deprecated.
- `--dangerously-bypass-approvals-and-sandbox` (`--yolo`), `-a/--ask-for-approval`, `-c key=value`, `-C/--cd`, `-p/--profile`, `--ephemeral`, `--skip-git-repo-check` (required outside a git repo), `--ignore-user-config`.
- Continue: `codex exec resume --last "..."`, `codex exec resume <SESSION_ID>`.
- Auth: `CODEX_API_KEY=<key> codex exec ...`.
- If an MCP server with `required = true` cannot start, exec exits.

**Known issue (github.com/openai/codex/issues/24135, 2026-05, v0.130.0, open):** in `codex exec`, MCP tool calls are cancelled with "user cancelled MCP tool call" because stdin is closed for the approval prompt; the only workaround the reporter found is `--dangerously-bypass-approvals-and-sandbox`. The reporter tried `default_tools_approval_mode = "never"` (an invalid value); according to the docs the correct value is `"approve"` — **this must be tested in our setup**. There is also a community report that in 0.125.0-alpha.3 MCP calls were cancelled under the read-only/workspace-write sandbox. Plan: try `default_tools_approval_mode = "approve"` first; if that fails, `--yolo` in an isolated environment.

### 2.5 AGENTS.md

- Global: `~/.codex/AGENTS.override.md` if present, otherwise `~/.codex/AGENTS.md`.
- Project: at every level from the git root down to cwd, `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`; merged from the root downward, the closest one wins.
- `project_doc_max_bytes` defaults to 32 KiB.
- `CODEX_HOME=$(pwd)/.codex codex exec "..."` gives an isolated profile (handy for a separate config per agent).

### 2.6 Skills (Codex)

- Locations (by precedence): REPO `.agents/skills` (cwd, parent directories, repo root) → USER `$HOME/.agents/skills` → ADMIN `/etc/codex/skills` → SYSTEM (bundled with Codex).
- `~/.codex/skills` is the legacy location; it is still read for backward compatibility but is deprecated and not deduplicated against `~/.agents/skills` (the same skill in both places shows up twice).
- Two skills with the same `name` are not merged; both are listed.
- Frontmatter: `name` and `description` are required. Optional `agents/openai.yaml` (UI, invocation policy, tool dependencies).
- Invocation: `$skill-name` (explicit) or automatic selection.
- Disabling:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

- Codex follows the "open agent skills standard" (agentskills.io); for wide distribution it recommends plugins (for this work `.agents/skills` is enough).

---

## 3. Hermes Agent (Nous Research)

Local install: `Hermes Agent v0.21.2 (2026.9.11)`, `~/.hermes/hermes-agent` (git install; `hermes --version` reports "12619 commits behind" — current main may differ). The existing config was not touched; the information comes from `website/docs` and the sources `tools/mcp_tool*.py`, `hermes_cli/mcp_config.py`.

### 3.1 `~/.hermes/config.yaml` → `mcp_servers`

HTTP example from the docs:

```yaml
mcp_servers:
  remote_api:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer ***"
```

Full schema (mcp-config-reference):

```yaml
mcp_servers:
  <server_name>:
    command: "..."      # stdio servers
    args: []
    env: {}

    # OR
    url: "..."          # HTTP servers
    headers: {}

    # Optional HTTP/SSE TLS settings:
    ssl_verify: true                # bool or path to a CA bundle (PEM)
    client_cert: "/path/to/cert.pem"  # mTLS client certificate (see below)
    # client_key: "/path/to/key.pem"  # optional, when key lives in a separate file

    enabled: true
    timeout: 120
    connect_timeout: 60
    supports_parallel_tool_calls: false
    tools:
      include: []
      exclude: []
      resources: true
      prompts: true
```

For agents-room:

```yaml
mcp_servers:
  agents-room:
    url: "http://HOST:7700/mcp"
    headers:
      Authorization: "Bearer ${AGENTS_ROOM_TOKEN}"
    timeout: 900            # tool call timeout (s), default 300
    connect_timeout: 60
    keepalive_interval: 60  # keep below the server's idle session TTL (default 180)
```

- `${VAR}` and `${env:VAR}` are expanded at connect time in every string field (url, headers, args, env); the contents of `~/.hermes/.env` also count as environment variables. Putting the token in `~/.hermes/.env` as `AGENTS_ROOM_TOKEN=...` is the cleanest option.
- Streamable HTTP is the default transport; legacy SSE via `transport: sse`. `protocol: auto|stateless|legacy` (including the 2026-07-28 spec's `server/discover` stateless probe).
- `skip_preflight: true`: skips the preflight check for valid Streamable HTTP endpoints that return a non-MCP content-type to HEAD/GET (may be needed if our server does not answer GET/HEAD properly).
- `trust: untrusted` → every call to a tool that can write (one without `readOnlyHint`) requires approval. The default is `full`. Putting correct `readOnlyHint` annotations on the agents-room tools is useful.
- Tool names: `mcp_<server>_<tool>`, hyphens/dots become `_` → `mcp_agents_room_join`.
- If the config is edited from inside a session, MCP connections are reloaded with a 30 s timeout.

Adding via the CLI (interactive; connects, discovers the tools and lets you pick them):

```bash
hermes mcp add agents-room --url http://HOST:7700/mcp --auth header
# prompts for "API key / Bearer token"; saves the token to ~/.hermes/.env as MCP_AGENTS_ROOM_API_KEY
# and writes this to config.yaml: Authorization: "Bearer ${MCP_AGENTS_ROOM_API_KEY}"
hermes mcp list
hermes mcp test agents-room
```

(Source: `hermes_cli/mcp_config.py` — `_env_key_for_server()` → `MCP_<NAME>_API_KEY`, `_bearer_auth_headers()`.) A `Bearer ` prefix in a pasted token is stripped automatically.

Migrating from Claude Code: `hermes import-agent claude-code --dry-run` (`~/.claude.json` `mcpServers` → `mcp_servers`, skills → `~/.hermes/skills/claude-code-imports/`); for Codex, `hermes import-agent codex`.

### 3.2 Timeouts

- `timeout`: tool call timeout, **default 300 s** (`tools/mcp_tool_common.py: _DEFAULT_TOOL_TIMEOUT = 300`).
- `connect_timeout`: default 60 s (including the initialize handshake).
- `keepalive_interval`: default 180 s liveness ping; if the Streamable HTTP session expires, Hermes recognizes the session expiry and reconnects (`mcp_tool_errors.py`).

### 3.3 Skills (Hermes)

- From the docs: skills are "compatible with the agentskills.io open standard".
- Primary directory: **`~/.hermes/skills/`** (`<category>/<skill>/SKILL.md` or `<skill>/SKILL.md`).
- Project-local: `<repo>/.hermes/skills/` and `<repo>/.agents/skills/` — but **`hermes skills trust` is required first** (trusted roots are kept in `skills.trusted_project_dirs`). Precedence: project → local → external_dirs.
- External shared directory (e.g. for sharing with Codex):

```yaml
skills:
  external_dirs:
    - ~/.agents/skills
```

- Frontmatter: `name`, `description` (+ Hermes-specific `version`, `platforms`, `metadata.hermes.tags/category/config/requires_toolsets` …). Non-standard fields are ignored by other clients.
- Install paths: `hermes skills install https://.../SKILL.md` (also fetches referenced `references/`, `scripts/`, `assets/`… files), a GitHub "tap" (`hermes skills tap add <owner/repo>`), `hermes skills publish`.
- Preloading in a session: `hermes -s agents-room ...` / `hermes chat -s agents-room`.
- Context files: `.hermes.md` → `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules` — **only the first type found** is loaded; `SOUL.md` is always loaded separately.

### 3.4 Headless / one-shot

`hermes --help`:

```
  -z PROMPT, --oneshot PROMPT
                        One-shot mode: send a single prompt and print ONLY the
                        final response text to stdout. No banner, no spinner,
                        no tool previews, no session_id line. Tools, memory,
                        rules, and AGENTS.md in the CWD are loaded as normal;
                        approvals are auto-bypassed. Intended for scripts /
                        pipes.
```

Examples:

```bash
# One shot, only the final answer to stdout; approvals auto-bypassed
hermes -z "join the agents-room room, take the pending task and carry it out" -s agents-room

# If session continuity is needed (named thread, create it if missing)
hermes chat -q "take the next task" -Q -c agents-room-worker --create-if-missing \
  --max-turns 200 --run-budget 3600 --yolo --source tool
```

- `chat -q` + `--oneshot` or `-Q` (or non-TTY stdio) → answers and exits. `--query-file PATH|-` passes the prompt without shell interpretation.
- `--yolo`: skips approvals for dangerous commands. `--max-turns N` (default 500), `--run-budget SECONDS`.
- `--ignore-user-config`, `--ignore-rules`, `--safe-mode` (also disables MCP — don't use it).
- `--worktree/-w`: isolated git worktree for parallel agents.
- There is no JSON stream output flag; for structured integration, `hermes acp` (Agent Client Protocol) or `hermes serve` are available as alternatives.

---

## 4. Shared skill package — the Agent Skills standard (agentskills.io)

All three support the standard: Claude Code ("follow the Agent Skills open standard"), Codex ("open agent skills standard"), Hermes ("compatible with the agentskills.io open standard"). **A single SKILL.md can serve all three**, with these rules:

Standard frontmatter (agentskills.io/specification):

| Field | Required | Constraint |
|---|---|---|
| `name` | Yes | ≤64 characters; `a-z0-9-`; cannot start or end with a hyphen; no `--`; **must match the parent directory name** |
| `description` | Yes | ≤1024 characters; what it does + when to use it |
| `license` | No | |
| `compatibility` | No | ≤500 characters |
| `metadata` | No | string→string map |
| `allowed-tools` | No | Experimental; differs between clients |

A body of < 5000 tokens / < 500 lines is recommended; details go under `references/`.

Recommended shared SKILL.md (standard fields only):

```markdown
---
name: agents-room
description: Procedure for joining the shared agents-room chat room, messaging and claiming tasks. Use when the user says "join the room", "take a task", "agents-room", "talk to the other agents", or when agents-room MCP tools are available.
license: MIT
compatibility: Requires the agents-room MCP server (Streamable HTTP) configured in the client.
metadata:
  version: "0.1.0"
---

# agents-room

Tool names differ per client (Claude Code: `mcp__agents-room__<tool>`,
Hermes: `mcp_agents_room_<tool>`, Codex: the agents-room server's `<tool>` tool).
Tools are referred to by their bare names below.

## Procedure
1. Join the room with `join` (agent name + capabilities).
2. `wait_for_messages` blocks for at most ~50 s; if it returns empty, call it again.
3. ...
```

Portability recommendations:
- **Do not include** fields such as `allowed-tools`, `disable-model-invocation`, `context`, `argument-hint` (tool names differ per client; the claude.ai upload path errors on unknown fields).
- Refer to tools by their bare names in the instructions and give a per-client prefix table.
- Spell out the long-poll contract explicitly in the skill (see §1.3; the lowest common denominator is Codex's 60 s default and Claude's 60 s per-request timer).

Distribution layout (single source):

```bash
# Single source
mkdir -p ~/.agents/skills/agents-room   # put SKILL.md here
# Codex: reads ~/.agents/skills directly (nothing extra to do)
# Hermes: config.yaml -> skills.external_dirs: [~/.agents/skills]
# Claude Code: does not read .agents -> symlink or plugin
ln -s ~/.agents/skills/agents-room ~/.claude/skills/agents-room
```

Distribution inside the repo: `.agents/skills/agents-room/` (Codex + Hermes [after trust]) and a `.claude/skills/agents-room` → `../../.agents/skills/agents-room` symlink (Claude Code).

---

## 5. Caveats / open points

1. **The lowest common denominator for timeouts is 60 s**: the Codex `tool_timeout_sec` default is 60, the Claude Code HTTP per-request (first byte) timer is 60 s when neither `MCP_TOOL_TIMEOUT` nor `timeout` is set, Claude idle is 5 min, Hermes is 300 s. Cap the long-poll at ~45–50 s on the server side; anything longer needs timeout settings in all three clients plus progress notifications.
2. **No auto-background in Claude `-p` mode**: calls over 2 min block; the per-server `timeout` is a wall-clock limit and progress does not extend it.
3. **Codex exec + MCP approval**: open issue #24135 — test with `default_tools_approval_mode = "approve"`; if needed, use `--dangerously-bypass-approvals-and-sandbox` only inside a sandbox/container.
4. **Streamable HTTP**: all three support it. Hermes does a content-type preflight check with GET/HEAD (`skip_preflight`); Hermes sends keepalive pings (`keepalive_interval`) — the server session TTL must be longer than that, or the server must run stateless. Hermes also tries the 2026-07-28 spec's stateless `server/discover` (`protocol: auto`).
5. **Token storage**: configs written by hand, without Claude `--header` or `hermes mcp add`, hold plain text; prefer `${AGENTS_ROOM_TOKEN}` (Claude/Hermes) / `bearer_token_env_var` (Codex) / plugin `userConfig` `sensitive: true` (Claude) / `~/.hermes/.env` (Hermes).
6. **Remote host over HTTP (no TLS)**: the Claude plugin validator warns; use TLS outside the LAN.
7. **Tool naming**: Hermes converts hyphens to `_`; using only `[a-z0-9_]` in server tool names gives predictable names everywhere.
8. Codex is not installed on this machine; the Codex section was not verified (docs only). The local Hermes install is far behind upstream; fields may have changed after `hermes update`.

## Sources

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code Skills: https://code.claude.com/docs/en/skills
- Plugin manifest: https://code.claude.com/docs/en/plugins-reference
- Marketplace: https://code.claude.com/docs/en/plugin-marketplaces
- Headless: https://code.claude.com/docs/en/headless
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp (formerly: developers.openai.com/codex/mcp)
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex skills: https://learn.chatgpt.com/docs/build-skills
- Codex exec: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex exec MCP approval issue: https://github.com/openai/codex/issues/24135
- Agent Skills spec: https://agentskills.io/specification
- Hermes (local): `~/.hermes/hermes-agent/website/docs/user-guide/features/mcp.md`, `.../reference/mcp-config-reference.md`, `.../user-guide/features/skills.md`, `.../user-guide/features/context-files.md`, `hermes --help`, `hermes chat --help`, `hermes mcp add --help`
