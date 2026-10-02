# agents-room agent imajı: Claude Code, Codex CLI, Gemini CLI ve GitHub CLI hazır; Hermes isteğe bağlı.
# Konteyner açılınca scripts/team.ts ön planda çalışır: kayıt olur, ortak repoyu klonlar, agent'ları başlatır.
# Ayar yoksa bekler; içeride "agents-room setup" ile kurulur (docs/docker.md).
#
#   docker compose -f docker/compose.yaml up -d --build      (ayrıntılar: docs/docker.md)
ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-bookworm-slim

ARG INSTALL_CLAUDE=1
ARG INSTALL_CODEX=1
ARG INSTALL_GEMINI=1
ARG INSTALL_HERMES=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git openssh-client procps python3 ripgrep \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN set -eu; pkgs=""; \
    [ "$INSTALL_CLAUDE" = 1 ] && pkgs="$pkgs @anthropic-ai/claude-code"; \
    [ "$INSTALL_CODEX" = 1 ] && pkgs="$pkgs @openai/codex"; \
    [ "$INSTALL_GEMINI" = 1 ] && pkgs="$pkgs @google/gemini-cli"; \
    if [ -n "$pkgs" ]; then npm install -g $pkgs && npm cache clean --force; fi

# Kalıcı birimler imajdaki dizinin sahipliğini devralır: /data agent kullanıcısına ait olmalı.
RUN mkdir -p /data/workspaces && chown -R node:node /data \
 && ln -s /opt/agents-room/docker/entrypoint.sh /usr/local/bin/agents-room

# Agent'lar root olmayan "node" kullanıcısıyla çalışır.
USER node
ENV HOME=/home/node
# Hermes resmi kurulum betiğiyle kurulur (deneysel; imajı büyütür).
RUN if [ "$INSTALL_HERMES" = 1 ]; then curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash; fi
ENV PATH=/home/node/.local/bin:$PATH

COPY --chown=node:node scripts /opt/agents-room/scripts
COPY --chown=node:node skills /opt/agents-room/skills
COPY --chown=node:node docker/entrypoint.sh /opt/agents-room/docker/entrypoint.sh

# Çalışma alanı (klonlar, loglar, team.json) ve istemci oturumları kalıcı birimlerde tutulur.
ENV AGENTS_ROOM_WORKSPACES=/data/workspaces \
    AGENTS_ROOM_IN_DOCKER=1
RUN mkdir -p /home/node/.agents/skills /home/node/.claude/skills \
 && ln -s /opt/agents-room/skills/agents-room /home/node/.agents/skills/agents-room \
 && ln -s /opt/agents-room/skills/agents-room /home/node/.claude/skills/agents-room
WORKDIR /opt/agents-room
# Ayar yoksa konteyner kurulumu bekler: docker exec -it <konteyner> agents-room setup
ENTRYPOINT ["/opt/agents-room/docker/entrypoint.sh"]
CMD ["start"]
