# Running agents with Docker on other machines

**English** · [Türkçe](tr/docker.md)

The server (the table) runs on one machine. On the other machines, agents start in a Docker container, sit in the same room and work on a shared GitHub repo. The container ships with Claude Code, Codex CLI, Gemini CLI and GitHub CLI (`gh`); Hermes is optional.

```
 server machine                       machine 2 (Docker)                machine 3 (Docker)
 ┌───────────────────┐   MCP/HTTP    ┌──────────────────────┐          ┌──────────────────────┐
 │ npm start  :7700  │◄──────────────│ team.ts --foreground │          │ team.ts --foreground │
 │ panel + SQLite    │◄──────────────│  ela (claude)        │          │  kaan (gemini)       │
 └───────────────────┘               │  can (claude)        │          │  deniz (codex)       │
                                     └──────────┬───────────┘          └──────────┬───────────┘
                                                └────── git push/PR ──────────────┘
                                                      github.com/org/proje
```

## Release compose files (no clone needed)

[`docker/release/`](../docker/release/) holds compose files that use the published images directly. Download one file, optionally add a `.env` next to it ([`.env.example`](../docker/release/.env.example)) and start it. Image versions are pinned (`AGENTS_ROOM_VERSION`, default `0.3.1`; set `latest` to follow new releases).

| File | Use |
|---|---|
| [`server.yaml`](../docker/release/server.yaml) | Only the server (table), on the main machine |
| [`agents.yaml`](../docker/release/agents.yaml) | Only an agent team, on every other machine |
| [`all-in-one.yaml`](../docker/release/all-in-one.yaml) | Server and agents on one machine; agents reach the server over the compose network |

**Main machine:**

```bash
curl -fsSLO https://raw.githubusercontent.com/aydinozturk/agents-room/main/docker/release/server.yaml
docker compose -f server.yaml up -d
docker compose -f server.yaml exec server agents-room token    # panel login
docker compose -f server.yaml exec server agents-room secret   # enrollment secret for the agent machines
```

**Each agent machine:**

```bash
curl -fsSLO https://raw.githubusercontent.com/aydinozturk/agents-room/main/docker/release/agents.yaml
docker compose -f agents.yaml up -d
docker compose -f agents.yaml exec agents agents-room setup    # server address, secret, room, repo, team, model logins
```

**Everything on one machine:** `all-in-one.yaml` needs a shared enrollment secret in `.env`; the server and the agents both read it, so setup doesn't ask for the server or the secret.

```bash
curl -fsSLO https://raw.githubusercontent.com/aydinozturk/agents-room/main/docker/release/all-in-one.yaml
echo "AGENTS_ROOM_ENROLL_SECRET=$(openssl rand -hex 16)" >> .env
docker compose -f all-in-one.yaml up -d
docker compose -f all-in-one.yaml exec agents agents-room setup
```

The sections below explain the same steps in detail, including building the images from source.

## 1. Preparation

**On the server machine**, start the table either with Node (`cd server && npm start`) or with the server image. Note the LAN address printed at startup (e.g. `http://192.168.1.20:7700`) and the enrollment secret in `server/data/enroll.secret`.

### Server in Docker

The server image [`aydinozturk/agents-room-server`](https://hub.docker.com/r/aydinozturk/agents-room-server) holds only Node, the server and the panel; no agent CLIs. The database, admin token and enrollment secret live in the `/data` volume, so rooms, history and tokens survive container rebuilds.

```bash
docker run -d --name agents-room-server --init --restart unless-stopped \
  -p 7700:7700 -v agents-room-server-data:/data \
  -e AGENTS_ROOM_PUBLIC_URL=http://192.168.1.20:7700 \
  aydinozturk/agents-room-server:latest
docker exec agents-room-server agents-room token    # panel login
docker exec agents-room-server agents-room secret   # enrollment secret for other machines
```

- **Compose:** `docker compose -f docker/server.compose.yaml up -d --build` builds from source; `SERVER_IMAGE=aydinozturk/agents-room-server:latest` uses the prebuilt image instead.
- **`AGENTS_ROOM_PUBLIC_URL`:** Inside a container the server can't see the machine's LAN address. Set this so the startup message shows the address other machines should use.
- **Local only:** Publish the port as `-p 127.0.0.1:7700:7700`.
- **Management:** `agents-room status`, `agents-room agent list`, `agents-room agent add …` run the server CLI inside the container.
- **Agents on the same machine:** Use `AGENTS_ROOM_SERVER=http://host.docker.internal:7700` in the agent container.
- **Backup:** `docker run --rm -v agents-room-server-data:/data -v "$PWD":/out busybox tar czf /out/agents-room-data.tgz -C /data .`

**On GitHub:**
1. Create the shared repo (it can be empty; the first setup makes the initial commit with a README).
2. Create a **fine-grained personal access token**:
   - *Repository access*: only this repo.
   - *Permissions*: `Contents: Read and write`, `Pull requests: Read and write`, `Metadata: Read`.
   - Give it a short expiration date.

   Instead of a token you can also use a **deploy key** (SSH) with write access to the repo. In that case agents can't open PRs: they push their branches and the orchestrator merges.

## 2. On each agent machine

### Prebuilt image (no build needed)

The image is public on Docker Hub: [`aydinozturk/agents-room-agent`](https://hub.docker.com/r/aydinozturk/agents-room-agent). It is published for `linux/amd64` and `linux/arm64`. You can start it with a single command without cloning the project:

```bash
docker run -d --name agents-room --init --restart on-failure:5 \
  --add-host host.docker.internal:host-gateway \
  -v agents-room-data:/data -v agents-room-home:/home/node \
  aydinozturk/agents-room-agent:latest
docker exec -it agents-room agents-room setup
```

With Compose: `AGENTS_IMAGE=aydinozturk/agents-room-agent:latest docker compose -f docker/compose.yaml up -d`. To publish a new version of both images: `docker/publish.sh aydinozturk <version>`; add `agent` or `server` as a third argument to publish only one (run `docker login` first).

### Building it yourself

There are two ways; both use the same image.

### A) Setup from inside the container (recommended)

```bash
git clone https://github.com/aydinozturk/agents-room.git && cd agents-room
docker compose -f docker/compose.yaml up -d --build        # no config: the container waits for setup
docker compose -f docker/compose.yaml exec agents agents-room setup
```

`setup` asks for the following, in order:
1. The table address and enrollment secret. Both are checked right away; the secret is not shown on screen.
2. The room; existing rooms are listed.
3. For a new room, the shared GitHub repo and access token (hidden input).
4. The number of orchestrators and their platforms, and the number of workers per platform.
5. For platforms without a model login, it offers to start a browser login right then.

Before saving, it checks access to the server, the room and the repo, the token's write permission, and the CLIs. The config is written to `/data/agents-room.env` (mode `600`) on the container's persistent volume.

- **First setup:** If the container is waiting for setup, the team starts on its own within a few seconds.
- **Later changes:** Change the config with `agents-room setup` and restart the container:

  ```bash
  docker compose -f docker/compose.yaml restart
  ```

Commands available inside the container:

| Command | What it does |
|---|---|
| `agents-room setup` | Setup wizard (can be rerun; previous answers are offered as defaults) |
| `agents-room login claude\|codex\|gemini` | Browser login to the model account |
| `agents-room status` | Saved config (secrets hidden), model logins, running agents |
| `agents-room reset` | Deletes the saved config |

Run them with `docker compose -f docker/compose.yaml exec agents <command>`. Without Compose, use `docker exec -it <container> <command>`.

To run without Compose:

```bash
docker build -f docker/agent.Dockerfile -t agents-room-agent .
docker run -d --name agents-room --init --restart on-failure:5 \
  --add-host host.docker.internal:host-gateway \
  -v agents-room-data:/data -v agents-room-home:/home/node agents-room-agent
docker exec -it agents-room agents-room setup
```

### B) With a `.env` file (for automation)

```bash
cp docker/.env.example docker/.env      # fill in the values
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec agents agents-room login claude   # once, if you didn't provide a key
docker compose -f docker/compose.yaml logs -f
```

Precedence: a non-empty value in `.env` overrides the value saved by `setup`. Empty lines are ignored.

| Variable | Example | Description |
|---|---|---|
| `AGENTS_ROOM_SERVER` | `http://192.168.1.20:7700` | `http://host.docker.internal:7700` if the server is on the same machine |
| `AGENTS_ROOM_ENROLL_SECRET` | | `server/data/enroll.secret` on the server |
| `AGENTS_ROOM_ROOM` | `urun-ekibi` | Created if it doesn't exist |
| `AGENTS_ROOM_REPO` | `acme/urun` | Only for a new room; an existing room uses its own repo |
| `AGENTS_ROOM_GIT_TOKEN` | `github_pat_…` | Repo access token |
| `CLAUDE_WORKERS`, `GEMINI_WORKERS`, `CODEX_WORKERS`, `HERMES_WORKERS` | `2` | Number of workers per platform |
| `ORCHESTRATORS`, `ORCH_CLIENTS` | `1`, `claude` | `0` if the orchestrator is on another machine |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | | Claude Code: optional, if you haven't logged in via browser |
| `OPENAI_API_KEY` | | Codex CLI: optional, if you haven't logged in via browser |
| `GEMINI_API_KEY` | | Gemini CLI: optional, if you haven't logged in via browser |

### Model login: browser instead of a token

You don't have to provide model keys. You can log in to each CLI **once** via browser from inside the container. The session is stored on the persistent `home` volume, so it stays valid across container restarts and image rebuilds.

```bash
docker compose -f docker/compose.yaml exec agents agents-room login claude    # with your Claude subscription
docker compose -f docker/compose.yaml exec agents agents-room login codex     # with your ChatGPT account (device code)
docker compose -f docker/compose.yaml exec agents agents-room login gemini    # with your Google account; /quit when done
```

Since the container has no browser, the command prints a URL:
1. Open the URL in your own computer's browser and approve.
2. For Claude and Gemini, paste the displayed code into the terminal. For Codex, enter the code shown on screen in the browser.

If agent sessions end immediately because there is no login, the runner retries with increasing delays and logs the reason. It stops after five failed attempts. Restart the container after logging in.

> If you use a second project name on the same machine (`-p oda2`), its `home` volume is separate; log in there once as well.

At startup the container runs `scripts/team.ts --yes --foreground`, which:
1. Enrolls with the server.
2. Checks repo access; if the repo is empty, makes the initial commit.
3. Clones the repo for each agent.
4. Starts the agents and stays up until they all finish.

## 3. Where does the token live?

- The token is **not written to the repo URL, the room record, the panel or `team.json`**. Each clone's git config only has a credential helper that reads the token from the `AGENTS_ROOM_GIT_TOKEN` environment variable. Other credential helpers on the machine (e.g. macOS Keychain) are disabled in these clones.
- Per-agent credentials (the MCP token and the git token) are kept outside the workspace, in `~/.config/agents-room/teams/<room>/<name>.env` (mode `600`).
- `gh` runs in the container with `GH_TOKEN`; workers open a PR for each task with `gh pr create`.
- Agents can use the token to push, so think of it as a key in the agent's hands. That's why you should use a time-limited fine-grained token scoped to that repo only.

## 4. Operations

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs -f          # session start/end lines
docker compose -f docker/compose.yaml exec agents agents-room status           # config, logins, agents
docker compose -f docker/compose.yaml exec agents ls /data/workspaces/<oda>/logs   # agent logs
docker compose -f docker/compose.yaml down              # stops the agents (SIGTERM)
```

- **Restart:** If the container restarts, the agents return to the table with the same names; the names are read from `team.json` on the persistent volume.
- **When the room closes:** When **Close room** ("Odayı kapat") is used in the panel, the agents stop and the container exits cleanly (it doesn't restart, because of `restart: on-failure`). To reopen a closed room, set `REOPEN_ROOM=1`.
- **A second room on the same machine:**

  ```bash
  docker compose -f docker/compose.yaml -p oda2 --env-file docker/oda2.env up -d
  ```

  Only the `.env` file changes; volumes are kept separate by project name.
- **Hermes (experimental):** Build the image with `INSTALL_HERMES=1` and provide the model server with `HERMES_BASE_URL` / `HERMES_MODEL` / `HERMES_API_KEY`. If the model server is on the host machine, use the `host.docker.internal` address.

## 5. The same thing without Docker

The same flow works without Docker:

```bash
node scripts/team.ts --server http://192.168.1.20:7700 --repo acme/urun
```

Setup asks for the repo access token; the input is hidden. You can also pass it as an environment variable: `AGENTS_ROOM_GIT_TOKEN=github_pat_… node scripts/team.ts …`. To work over SSH, use `--repo git@github.com:acme/urun.git --ssh-key ~/.ssh/deploy_key`.
