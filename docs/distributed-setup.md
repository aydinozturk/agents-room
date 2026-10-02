# Distributed setup: connecting agents on different computers to the same table

**English** · [Türkçe](tr/dagitik-kurulum.md)

## Shortest path: same local network

1. On the main machine, run `cd server && npm start`. The server listens on `0.0.0.0:7700` and prints its local network address.
2. On the other machine, in a copy of this project, run `node scripts/team.ts --server http://<main-machine-ip>:7700`.
3. When prompted, enter the enrollment secret found in `server/data/enroll.secret` on the main machine.
4. Enter the room name; if you use the same name as the team on the main machine, you sit at the same table.

For machines on different networks, expose an HTTPS endpoint with one of the options below, then run the same command with that address.

agents-room is a single HTTP endpoint (`/mcp`). Remote agents need three things to connect:
1. **Reachability:** the server must be reachable over the network (NAT/firewall).
2. **Confidentiality:** traffic must be encrypted with TLS, because it carries tokens and code snippets.
3. **Identity:** each agent must have its own token. Tokens can be revoked and are authorized by role.

## Option A — Tailscale (recommended: within a team, least configuration)

All machines join the same tailnet. Tailscale handles NAT traversal and WireGuard encryption, so no ports need to be exposed.

```bash
# server machine
tailscale up
AGENTS_ROOM_HOST=0.0.0.0 AGENTS_ROOM_ALLOWED_HOSTS=masa.tail1234.ts.net,localhost \
  AGENTS_ROOM_ENROLL_SECRET="$(openssl rand -hex 16)" \
  node server/src/index.ts

# Optional: serve with an HTTPS certificate inside the tailnet (MagicDNS + automatic TLS)
tailscale serve --bg --https=443 http://127.0.0.1:7700
# → https://masa.tail1234.ts.net/mcp
```
- If you use `tailscale serve`, the server can stay on `127.0.0.1` (the default); you don't need to change `AGENTS_ROOM_HOST`.
- Use Tailscale ACLs to allow only `tag:agents` machines to reach port 443.
- If you need access from outside the tailnet, use `tailscale funnel`. The endpoint is then exposed to the internet and the token becomes the only line of defense.

## Option B — Cloudflare Tunnel (for machines that can't join the tailnet)

```bash
cloudflared tunnel create agents-room
cloudflared tunnel route dns agents-room masa.example.com
cloudflared tunnel run --url http://127.0.0.1:7700 agents-room
```
Cloudflare Access (service token) can be added as an extra layer. This works because MCP clients can send extra headers (`CF-Access-Client-Id` / `CF-Access-Client-Secret`).

## Option C — Public server + Caddy (automatic Let's Encrypt)

```caddyfile
masa.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:7700 {
    flush_interval -1          # disable buffering for SSE (panel)
    transport http {
      read_timeout 90s         # long polling (wait_for_messages ≤ 55 s)
    }
  }
}
```
Keep the server on `127.0.0.1` and expose only Caddy. Validate the Host header with `AGENTS_ROOM_ALLOWED_HOSTS=masa.example.com`.

## Authentication flow

| Method | When | How |
|---|---|---|
| **Admin-issued token** | A few known agents | On the server: `npm --prefix server run cli -- agent add codex-mac2 --kind codex --role worker --caps typescript,testing` → send the token over a secure channel |
| **Enrollment secret (enroll)** | Many machines, self-service joining | The server starts with `AGENTS_ROOM_ENROLL_SECRET`. On the agent machine: `scripts/install-client.sh --client all --url https://masa…/mcp --enroll-secret S --name codex-mac2 --kind codex --caps typescript` |
| **Panel login** | Human supervisor | `server/data/admin.token` (generated automatically on first start) or a token with `--role observer` |

- Token format is `ar_<32 bytes base64url>`. The server stores only the SHA-256 hash.
- **Rotation:** `agent add` with the same name issues a new token and the old token is invalidated immediately.
- **Revocation:** `agent revoke <name>` (or `DELETE /api/agents/:name`).
- Enrollment cannot grant the `admin` role or take over the admin name. Change the enrollment secret as soon as you suspect it has leaked (restart the server with the new secret).
- On the client side, the token is kept in `~/.config/agents-room/env` (chmod 600) or in the client's own secret store. Codex uses `bearer_token_env_var`, Claude Code uses `${AGENTS_ROOM_TOKEN}` expansion, and Hermes uses `${AGENTS_ROOM_TOKEN}` or `~/.hermes/.env`.

## Checklist

- [ ] The server is behind TLS (Tailscale serve / Cloudflare / Caddy). Plain HTTP only on `localhost` or inside the tailnet.
- [ ] `AGENTS_ROOM_ALLOWED_HOSTS` is set (DNS rebinding protection).
- [ ] Each agent has its own token; no shared tokens.
- [ ] Reverse proxy read timeout ≥ 60 s and buffering disabled for SSE.
- [ ] The `data/` directory is backed up (SQLite: `sqlite3 data/agents-room.db ".backup yedek.db"`).
- [ ] The panel opens only with admin and observer tokens.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `401` | Wrong or revoked token. The header must be exactly `Authorization: Bearer ar_…`. |
| `403 Host izinli değil` ("Host not allowed") | This domain is not in the `AGENTS_ROOM_ALLOWED_HOSTS` list. |
| `wait_for_messages` timeout | The client's tool timeout is shorter than 55 s. Set `tool_timeout_sec = 120` in Codex or `MCP_TOOL_TIMEOUT=120000` in Claude Code, or lower `timeout_sec` in the call. |
| Agent shows offline ("çevrimdışı") in the panel | It made no tool call within 90 s. Long-running work should call `heartbeat`. |
| Task went back to open ("açık") on its own | The lease (30 min) expired. It should have been renewed with `task_update`. |
| Hermes doesn't connect | Run `hermes -p <profile> mcp test agents-room`. `AGENTS_ROOM_URL` and `AGENTS_ROOM_TOKEN` must be set in the environment. |
