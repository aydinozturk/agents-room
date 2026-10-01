#!/usr/bin/env bash
# Pilot ortamı: GitHub yerine yerel bir bare repo ("origin"), agent başına ayrı klon, oda ve agent token'ları.
#   AGENTS_ROOM_ADMIN_TOKEN=$(cat server/data/admin.token) scripts/pilot-setup.sh [çalışma-dizini]
# Çıktı: <dizin>/origin.git, <dizin>/<agent>/ klonları, <dizin>/<agent>.env (token'lar, chmod 600)
set -euo pipefail
WS="${1:-$(cd "$(dirname "$0")/.." && pwd)/pilot-workspace}"
BASE="${AGENTS_ROOM_BASE:-http://127.0.0.1:7700}"
: "${AGENTS_ROOM_ADMIN_TOKEN:?admin token gerekli (server/data/admin.token)}"
ROOM="${PILOT_ROOM:-pilot-todo}"
REPO_ID="local/todo-cli"
AGENTS=("pilot-orch:claude-code:orchestrator:planning,review,typescript"
        "pilot-claude:claude-code:worker:typescript,testing,docs"
        "pilot-hermes:hermes:worker:typescript,research,docs")

api() { curl -fsS -X POST "$BASE$1" -H "Authorization: Bearer $AGENTS_ROOM_ADMIN_TOKEN" -H 'content-type: application/json' -d "$2"; }

mkdir -p "$WS"
if [[ ! -d "$WS/origin.git" ]]; then
  git init -q --bare -b main "$WS/origin.git"
  SEED="$(mktemp -d)"
  git -C "$SEED" init -q -b main
  cat > "$SEED/README.md" <<'EOF'
# todo-cli

agents-room pilot projesi. Hedef: bağımlılıksız bir Node.js komut satırı yapılacaklar uygulaması.
EOF
  cat > "$SEED/package.json" <<'EOF'
{
  "name": "todo-cli",
  "version": "0.0.0",
  "type": "module",
  "bin": { "todo": "./bin/todo.js" },
  "scripts": { "test": "node --test" }
}
EOF
  printf 'node_modules/\n.todo.json\n' > "$SEED/.gitignore"
  git -C "$SEED" add -A && git -C "$SEED" -c user.name=pilot -c user.email=pilot@local commit -qm "chore: iskelet"
  git -C "$SEED" push -q "$WS/origin.git" main
  rm -rf "$SEED"
  echo "✓ origin: $WS/origin.git"
fi

api /api/rooms "{\"name\":\"$ROOM\",\"topic\":\"Pilot: Todo CLI (çoklu agent)\",\"repo\":\"$REPO_ID\"}" >/dev/null
echo "✓ oda: $ROOM (repo=$REPO_ID)"

for spec in "${AGENTS[@]}"; do
  IFS=: read -r NAME KIND ROLE CAPS <<<"$spec"
  CAPS_JSON="[\"${CAPS//,/\",\"}\"]"
  TOKEN=$(api /api/agents "{\"name\":\"$NAME\",\"kind\":\"$KIND\",\"role\":\"$ROLE\",\"capabilities\":$CAPS_JSON,\"machine\":\"$(hostname -s)\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [[ -d "$WS/$NAME" ]] || git clone -q "$WS/origin.git" "$WS/$NAME"
  git -C "$WS/$NAME" config user.name "$NAME"
  git -C "$WS/$NAME" config user.email "$NAME@agents-room.local"
  ( umask 077; printf 'export AGENTS_ROOM_URL=%q\nexport AGENTS_ROOM_TOKEN=%q\n' "$BASE/mcp" "$TOKEN" > "$WS/$NAME.env" )
  echo "✓ $NAME ($KIND, $ROLE) → klon $WS/$NAME, kimlik $WS/$NAME.env"
done
echo
echo "Başlatma (ayrı terminallerde):"
echo "  source $WS/pilot-orch.env   && scripts/run-agent.sh --client claude --role orchestrator --room $ROOM --repo $WS/pilot-orch --goal '<hedef>'"
echo "  source $WS/pilot-claude.env && scripts/run-agent.sh --client claude --role worker --room $ROOM --repo $WS/pilot-claude"
echo "  source $WS/pilot-hermes.env && HERMES_PROFILE=agentsroom scripts/run-agent.sh --client hermes --role worker --room $ROOM --repo $WS/pilot-hermes"
