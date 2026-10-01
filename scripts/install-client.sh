#!/usr/bin/env bash
# agents-room istemci kurulumu: skill paketini kurar ve MCP bağlantısını yapılandırır.
#
#   scripts/install-client.sh --client claude|codex|hermes|gemini|all --url https://masa.example.ts.net/mcp [--token ar_...]
#   scripts/install-client.sh --client all --url ... --enroll-secret S --name codex-mac2 --kind codex --caps typescript,testing
#
# Token verilmez ve --enroll-secret verilirse sunucunun /api/enroll ucundan token alınır.
# Token ~/.config/agents-room/env dosyasına (chmod 600) yazılır; shell profilinizden `source` edin.
set -euo pipefail

CLIENT=all URL="" TOKEN="${AGENTS_ROOM_TOKEN:-}" ENROLL="" NAME="" KIND="" ROLE=worker CAPS="" DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --client) CLIENT="$2"; shift 2 ;;
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --enroll-secret) ENROLL="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --kind) KIND="$2"; shift 2 ;;
    --role) ROLE="$2"; shift 2 ;;
    --caps) CAPS="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n 2,9p "$0"; exit 0 ;;
    *) echo "bilinmeyen argüman: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$URL" ]] || { echo "--url gerekli (ör. http://127.0.0.1:7700/mcp)" >&2; exit 2; }
[[ "$URL" == */mcp ]] || URL="${URL%/}/mcp"
BASE="${URL%/mcp}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="$ROOT/skills/agents-room"
run() { if [[ $DRY == 1 ]]; then echo "+ $*"; else "$@"; fi; }

# ---------------------------------------------------------------- 1) token
if [[ -z "$TOKEN" && -n "$ENROLL" ]]; then
  [[ -n "$NAME" ]] || { echo "--enroll-secret ile --name gerekli" >&2; exit 2; }
  CAPS_JSON=$(printf '%s' "$CAPS" | awk -F, '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')
  RESP=$(curl -fsS -X POST "$BASE/api/enroll" -H 'content-type: application/json' \
    -d "{\"secret\":\"$ENROLL\",\"name\":\"$NAME\",\"kind\":\"${KIND:-other}\",\"role\":\"$ROLE\",\"capabilities\":$CAPS_JSON,\"machine\":\"$(hostname -s)\"}")
  TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [[ -n "$TOKEN" ]] || { echo "kayıt başarısız: $RESP" >&2; exit 1; }
  echo "✓ kayıt tamam: $NAME"
fi
[[ -n "$TOKEN" ]] || { echo "Token yok: --token verin, AGENTS_ROOM_TOKEN ayarlayın ya da --enroll-secret kullanın" >&2; exit 2; }

ENV_DIR="$HOME/.config/agents-room"
run mkdir -p "$ENV_DIR"
if [[ $DRY == 0 ]]; then
  umask 077
  printf 'export AGENTS_ROOM_URL=%q\nexport AGENTS_ROOM_TOKEN=%q\n' "$URL" "$TOKEN" > "$ENV_DIR/env"
fi
echo "✓ kimlik bilgisi: $ENV_DIR/env  (shell profilinize ekleyin: source $ENV_DIR/env)"

# Bağlantı testi
if [[ $DRY == 0 ]]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL" -H "Authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' || true)
  [[ "$CODE" == 200 ]] && echo "✓ sunucuya erişildi ($URL)" || echo "⚠️  sunucu yanıtı: HTTP $CODE — URL/token/ağ erişimini kontrol edin"
fi

# ---------------------------------------------------------------- 2) skill (tek kopya, üç istemci)
# Kanonik yer ~/.agents/skills (Codex ve Gemini CLI okur); Claude Code ve Hermes için symlink.
CANON="$HOME/.agents/skills/agents-room"
run mkdir -p "$HOME/.agents/skills"
if [[ -L "$CANON" || ! -e "$CANON" ]]; then run ln -sfn "$SKILL_SRC" "$CANON"; else echo "⚠️  $CANON zaten var (symlink değil), dokunulmadı"; fi

want() { [[ "$CLIENT" == all || "$CLIENT" == "$1" ]]; }

# ---------------------------------------------------------------- 3) istemciler
if want claude; then
  if command -v claude >/dev/null; then
    run mkdir -p "$HOME/.claude/skills"
    run ln -sfn "$SKILL_SRC" "$HOME/.claude/skills/agents-room"
    run claude mcp remove --scope user agents-room >/dev/null 2>&1 || true
    run claude mcp add --scope user --transport http agents-room "$URL" --header "Authorization: Bearer $TOKEN"
    echo "✓ Claude Code: MCP 'agents-room' (user kapsamı) + skill ~/.claude/skills/agents-room"
    echo "  Not: uzun-yoklama için MCP_TOOL_TIMEOUT=120000 önerilir."
  else echo "- claude bulunamadı, atlandı"; fi
fi

if want codex; then
  CFG="$HOME/.codex/config.toml"
  run mkdir -p "$HOME/.codex"
  if [[ -f "$CFG" ]] && grep -q '^\[mcp_servers\.agents-room\]' "$CFG"; then
    echo "- Codex: $CFG içinde [mcp_servers.agents-room] zaten var, dokunulmadı"
  elif [[ $DRY == 0 ]]; then
    cat >> "$CFG" <<EOF

[mcp_servers.agents-room]
url = "$URL"
bearer_token_env_var = "AGENTS_ROOM_TOKEN"
tool_timeout_sec = 120
startup_timeout_sec = 20
EOF
    echo "✓ Codex: $CFG güncellendi (token AGENTS_ROOM_TOKEN ortam değişkeninden okunur); skill ~/.agents/skills/agents-room"
  fi
fi

if want hermes; then
  if command -v hermes >/dev/null; then
    run mkdir -p "$HOME/.hermes/skills"
    run ln -sfn "$SKILL_SRC" "$HOME/.hermes/skills/agents-room"
    echo "✓ Hermes: skill ~/.hermes/skills/agents-room"
    cat <<EOF
  Hermes MCP bağlantısı için ~/.hermes/config.yaml içine ekleyin (ya da 'hermes mcp add agents-room --url $URL --auth header'):
    mcp_servers:
      agents-room:
        url: "$URL"
        headers:
          Authorization: "Bearer \${AGENTS_ROOM_TOKEN}"
        timeout: 120
EOF
  else echo "- hermes bulunamadı, atlandı"; fi
fi

if want gemini; then
  if command -v gemini >/dev/null; then
    # Token ayar dosyasına açık yazılmaz: Gemini ${AGENTS_ROOM_TOKEN} ifadesini çalışırken ortamdan açar.
    run gemini mcp remove --scope user agents-room >/dev/null 2>&1 || true
    run gemini mcp add --scope user --transport http --trust --timeout 120000 \
      --header 'Authorization: Bearer ${AGENTS_ROOM_TOKEN}' agents-room "$URL"
    echo "✓ Gemini CLI: MCP 'agents-room' (~/.gemini/settings.json, token AGENTS_ROOM_TOKEN ortam değişkeninden) + skill ~/.agents/skills/agents-room"
  else echo "- gemini bulunamadı, atlandı"; fi
fi

echo
echo "Hazır. Bir agent'ı başlatmak için: scripts/run-agent.sh --client <claude|codex|hermes|gemini> --role worker --room <oda> --repo <yerel-repo-yolu>"
