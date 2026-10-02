#!/usr/bin/env bash
# agents-room konteyneri. Konteynerin içinde "agents-room" komutu olarak da çalışır:
#
#   agents-room setup                     etkileşimli kurulum: masa, oda, repo + anahtar, ekip, model girişleri
#   agents-room login claude|codex|gemini model hesabına tarayıcıyla giriş (token gerekmez)
#   agents-room status                    kayıtlı ayar, girişler ve çalışan agent'lar
#   agents-room reset                     kayıtlı ayarı siler
#   agents-room start                     (konteyner açılışı) ayar varsa ekibi başlatır, yoksa kurulumu bekler
#
# Ayar önceliği: konteyner ortamı (compose .env) > /data/agents-room.env (setup'ın kaydettiği).
set -Eeuo pipefail
# set -e ile sessizce çıkılmasın: son başarısız komut kaydedilir, hata koduyla çıkılırsa yazılır.
LAST_ERR=""
trap 'LAST_ERR="satır $LINENO: $BASH_COMMAND"' ERR
trap 'rc=$?; if [[ $rc != 0 && -n "$LAST_ERR" ]]; then echo "agents-room: hata (kod $rc, $LAST_ERR)" >&2; fi' EXIT

CONFIG=/data/agents-room.env
TEAM=/opt/agents-room/scripts/team.ts
KEYS=(AGENTS_ROOM_SERVER AGENTS_ROOM_ENROLL_SECRET AGENTS_ROOM_ROOM AGENTS_ROOM_TOPIC AGENTS_ROOM_REPO
  AGENTS_ROOM_GIT_TOKEN AGENTS_ROOM_SSH_KEY REOPEN_ROOM ORCHESTRATORS ORCH_CLIENTS CLAUDE_WORKERS CODEX_WORKERS
  GEMINI_WORKERS HERMES_WORKERS AGENTS_ROOM_GOAL AGENT_NAMES AGENT_PREFIX SESSIONS
  CLAUDE_MODEL CLAUDE_EFFORT CODEX_MODEL CODEX_EFFORT GEMINI_MODEL CLAUDE_ALLOWED_TOOLS AGENTS_ROOM_PERMISSIONS
  CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY HERMES_BASE_URL HERMES_MODEL HERMES_API_KEY)
SECRET_KEYS=" AGENTS_ROOM_ENROLL_SECRET AGENTS_ROOM_GIT_TOKEN CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY HERMES_API_KEY "
COMPOSE_HINT="docker compose -f docker/compose.yaml"

# Boş değişkenler "verilmemiş" sayılır (compose .env'deki boş satırlar kayıtlı ayarı ezmesin).
for v in "${KEYS[@]}"; do [[ -z "${!v:-}" ]] && unset "$v"; done

load_config() {
  [[ -f "$CONFIG" ]] || return 0
  local line key
  while IFS= read -r line; do
    [[ "$line" =~ ^([A-Z_]+)= ]] || continue
    key="${BASH_REMATCH[1]}"
    [[ -z "${!key:-}" ]] && eval "export $line"
  done < "$CONFIG"
  return 0 # son satırın anahtarı ortamda zaten varsa döngü 1 döner; set -e konteyneri sessizce kapatırdı
}
configured() { [[ -n "${AGENTS_ROOM_SERVER:-}" && -n "${AGENTS_ROOM_ROOM:-}" && -n "${AGENTS_ROOM_ENROLL_SECRET:-}" ]]; }
uses() { [[ ( "${ORCHESTRATORS:-0}" != 0 && "${ORCH_CLIENTS:-claude}" == *"$1"* ) || "${2:-0}" != 0 ]]; }

logged_in() {
  case "$1" in
    claude) [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]] || claude auth status 2>/dev/null | grep -q '"loggedIn": true' ;;
    codex) [[ -f "$HOME/.codex/auth.json" || -n "${OPENAI_API_KEY:-}" ]] ;;
    gemini) [[ -f "$HOME/.gemini/oauth_creds.json" || -n "${GEMINI_API_KEY:-}" ]] ;;
    hermes) [[ -n "${HERMES_BASE_URL:-}" ]] || grep -q '^model:' "$HOME/.hermes/profiles/agentsroom/config.yaml" 2>/dev/null ;;
  esac
}

do_login() {
  case "${1:-}" in
    claude)
      echo "Claude Code girişi: yazılan adresi kendi tarayıcınızda açın, onaylayın ve verilen kodu buraya yapıştırın."
      claude auth login ;;
    codex)
      echo "Codex girişi: gösterilen adresi tarayıcınızda açıp ekrandaki kodu girin."
      codex login --device-auth ;;
    gemini)
      mkdir -p "$HOME/.gemini"
      [[ -f "$HOME/.gemini/settings.json" ]] || echo '{"security":{"auth":{"selectedType":"oauth-personal"}}}' > "$HOME/.gemini/settings.json"
      echo "Gemini girişi: \"Login with Google\" adresini tarayıcınızda açın, kodu yapıştırın; giriş bitince /quit yazın."
      NO_BROWSER=true gemini ;;
    *) echo "Kullanım: agents-room login claude|codex|gemini" >&2; return 2 ;;
  esac
}

# ------------------------------------------------------------------ setup (etkileşimli)
ask() { local ans; read -rp "$1${2:+ [$2]}: " ans; echo "${ans:-${2:-}}"; }
ask_secret() { local ans; read -rsp "$1${2:+ [kayıtlı, değiştirmek için yazın]}: " ans; echo >&2; echo "${ans:-${2:-}}"; }
ask_int() { local v; while :; do v=$(ask "$1" "$2"); [[ "$v" =~ ^[0-9]+$ ]] && { echo "$v"; return; }; echo "  bir sayı girin" >&2; done; }
ask_yes() { local a; a=$(ask "$1 (e/h)" "${2:-e}"); [[ "$a" =~ ^[eEyY] ]]; }

do_setup() {
  [[ -t 0 ]] || { echo "setup etkileşimlidir: docker exec -it <konteyner> agents-room setup" >&2; exit 2; }
  echo; echo "agents-room konteyner kurulumu"; echo "Cevaplar $CONFIG dosyasına kaydedilir (yalnızca bu konteynerin birimi)."; echo
  for v in "${KEYS[@]}"; do
    if [[ -n "${!v:-}" ]] && ! grep -q "^$v=" "$CONFIG" 2>/dev/null; then
      echo "Not: $v konteyner ortamında (compose .env) tanımlı; kayıtlı ayar yerine o kullanılır." >&2
    fi
  done

  local server secret room info room_json repo="" token="" sshkey="" topic="" reopen=0 orch orch_clients="" goal
  while :; do
    server=$(ask "Masa (sunucu) adresi" "${AGENTS_ROOM_SERVER:-http://host.docker.internal:7700}"); server="${server%/}"; server="${server%/mcp}"
    curl -fsS -m 5 "$server/healthz" >/dev/null 2>&1 && { echo "✓ sunucu: $server"; break; }
    echo "✗ $server adresine ulaşılamadı. Sunucu açık mı, adres doğru mu? (sunucu bu makinedeyse http://host.docker.internal:7700)" >&2
  done
  echo "  Kayıt sırrı sunucu makinesindeki server/data/enroll.secret dosyasındadır."
  while :; do
    secret=$(ask_secret "Kayıt sırrı" "${AGENTS_ROOM_ENROLL_SECRET:-}")
    info=$(curl -sS -m 10 -X POST "$server/api/enroll/info" -H 'content-type: application/json' \
      -d "$(node -e 'process.stdout.write(JSON.stringify({secret:process.argv[1]}))' "$secret")" || true)
    [[ "$info" == *'"rooms"'* ]] && break
    echo "✗ Kayıt sırrı kabul edilmedi." >&2
  done
  echo; echo "Odalar:"
  node -e 'const j=JSON.parse(process.argv[1]);for(const r of j.rooms)console.log(`  ${r.name.padEnd(22)} ${r.closed?"(kapalı)":`${r.members} üye, ${r.open_tasks} açık görev`}  ${r.repo?"repo: "+r.repo:""}`)' "$info"
  room=$(ask "Oda adı (var olanı seçin ya da yeni bir ad yazın)" "${AGENTS_ROOM_ROOM:-}")
  room_json=$(node -e 'const j=JSON.parse(process.argv[1]);const r=j.rooms.find(x=>x.name===process.argv[2]);process.stdout.write(r?JSON.stringify(r):"")' "$info" "$room")
  if [[ -z "$room_json" ]]; then
    echo "  yeni oda oluşturulacak: $room"
    topic=$(ask "Odanın konusu" "${AGENTS_ROOM_TOPIC:-$room ekibi}")
    repo=$(ask "Ortak GitHub reposu (ör. org/proje ya da https://github.com/org/proje)" "${AGENTS_ROOM_REPO:-}")
  else
    repo=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).repo||"")' "$room_json")
    [[ -n "$repo" ]] && echo "  var olan oda; repo: $repo" || repo=$(ask "Odanın reposu yok. Ortak GitHub reposu" "${AGENTS_ROOM_REPO:-}")
    if [[ "$room_json" == *'"closed":true'* ]]; then ask_yes "  Oda kapalı. Yeniden açılsın mı?" h && reopen=1 || { echo "Kapalı odaya ekip kurulamaz." >&2; exit 1; }; fi
  fi
  if [[ "$repo" == git@* || "$repo" == ssh://* ]]; then
    sshkey=$(ask "SSH deploy key dosyasının konteynerdeki yolu (birim olarak bağlanmış olmalı)" "${AGENTS_ROOM_SSH_KEY:-/run/secrets/deploy_key}")
  elif [[ -n "$repo" ]]; then
    echo "  Yalnızca bu repoya Contents + Pull requests yazma izni olan, süreli bir GitHub fine-grained token önerilir."
    token=$(ask_secret "Repo erişim anahtarı (GitHub token)" "${AGENTS_ROOM_GIT_TOKEN:-}")
  fi

  echo; echo "Platformlar:"
  local k
  for k in claude codex gemini hermes; do command -v "$k" >/dev/null && echo "  $k  ✓ kurulu" || echo "  $k  – imajda yok"; done
  orch=$(ask_int "Orkestratör sayısı (0 = orkestratör başka yerde)" "${ORCHESTRATORS:-0}")
  if (( orch > 0 )); then orch_clients=$(ask "Orkestratör platformları (virgülle, ör. claude,gemini)" "${ORCH_CLIENTS:-claude}"); fi
  local cw xw gw hw
  cw=$(ask_int "Claude Code işçi sayısı" "${CLAUDE_WORKERS:-2}")
  xw=$(ask_int "Codex işçi sayısı" "${CODEX_WORKERS:-0}")
  gw=$(ask_int "Gemini işçi sayısı" "${GEMINI_WORKERS:-0}")
  hw=$(ask_int "Hermes işçi sayısı" "${HERMES_WORKERS:-0}")
  (( orch + cw + xw + gw + hw > 0 )) || { echo "En az bir agent seçmelisiniz." >&2; exit 1; }
  goal=""; (( orch > 0 )) && goal=$(ask "Orkestratöre ilk hedef (boş = panelden yazacağım)" "${AGENTS_ROOM_GOAL:-}")

  local tmp; tmp=$(mktemp "$CONFIG.XXXXXX"); chmod 600 "$tmp"
  {
    echo "# agents-room setup tarafından yazıldı: $(date -u +%FT%TZ)"
    for kv in "AGENTS_ROOM_SERVER=$server" "AGENTS_ROOM_ENROLL_SECRET=$secret" "AGENTS_ROOM_ROOM=$room" "AGENTS_ROOM_TOPIC=$topic" \
      "AGENTS_ROOM_REPO=$repo" "AGENTS_ROOM_GIT_TOKEN=$token" "AGENTS_ROOM_SSH_KEY=$sshkey" "REOPEN_ROOM=$reopen" \
      "ORCHESTRATORS=$orch" "ORCH_CLIENTS=$orch_clients" "CLAUDE_WORKERS=$cw" "CODEX_WORKERS=$xw" "GEMINI_WORKERS=$gw" \
      "HERMES_WORKERS=$hw" "AGENTS_ROOM_GOAL=$goal" "SESSIONS=${SESSIONS:-20}"; do
      printf '%s=%q\n' "${kv%%=*}" "${kv#*=}"
    done
  } > "$tmp"

  echo; echo "Kontrol ediliyor (sunucu, oda, repo erişimi, platformlar)…"
  if ! (set -a; unset "${KEYS[@]}"; CONFIG="$tmp" load_config; build_args; node "$TEAM" "${ARGS[@]}" --check); then
    rm -f "$tmp"; echo; echo "✗ Kontrol başarısız; ayar kaydedilmedi. Sorunu giderip agents-room setup'ı yeniden çalıştırın." >&2; exit 1
  fi

  # Model girişleri: kayıt etkinleşmeden önce (ekip girişsiz başlamasın).
  local need=()
  (( cw > 0 )) || [[ $orch -gt 0 && "$orch_clients" == *claude* ]] && need+=(claude)
  (( xw > 0 )) || [[ $orch -gt 0 && "$orch_clients" == *codex* ]] && need+=(codex)
  (( gw > 0 )) || [[ $orch -gt 0 && "$orch_clients" == *gemini* ]] && need+=(gemini)
  for k in ${need[@]+"${need[@]}"}; do
    if logged_in "$k"; then echo "✓ $k: giriş var"
    elif ask_yes "$k için giriş yok. Şimdi tarayıcıyla giriş yapılsın mı?" e; then do_login "$k" || echo "⚠️  $k girişi tamamlanmadı; sonra: agents-room login $k" >&2
    else echo "  sonra: agents-room login $k"; fi
  done
  (( hw > 0 )) && ! logged_in hermes && echo "⚠️  Hermes için model sunucusu tanımlı değil: compose .env'e HERMES_BASE_URL / HERMES_MODEL ekleyin."

  mv "$tmp" "$CONFIG"
  echo; echo "✓ Ayar kaydedildi: $CONFIG"
  if [[ -f /tmp/agents-room.waiting ]]; then
    echo "  Konteyner kurulumu bekliyordu; ekip birkaç saniye içinde kendiliğinden başlar."
  else
    echo "  Yeni ayarla başlatmak için konteyneri yeniden başlatın: docker restart <konteyner>   (compose: $COMPOSE_HINT restart)"
  fi
  echo "  Loglar: docker logs -f <konteyner>"
}

# ------------------------------------------------------------------ ekibi başlat
ARGS=()
build_args() {
  ARGS=(--server "$AGENTS_ROOM_SERVER" --room "$AGENTS_ROOM_ROOM" --orch "${ORCHESTRATORS:-0}"
    --claude "${CLAUDE_WORKERS:-0}" --hermes "${HERMES_WORKERS:-0}" --codex "${CODEX_WORKERS:-0}" --gemini "${GEMINI_WORKERS:-0}"
    --sessions "${SESSIONS:-20}" --yes)
  [[ -n "${ORCH_CLIENTS:-}" ]] && ARGS+=(--orch-client "$ORCH_CLIENTS")
  [[ -n "${AGENTS_ROOM_REPO:-}" ]] && ARGS+=(--repo "$AGENTS_ROOM_REPO")
  [[ -n "${AGENTS_ROOM_TOPIC:-}" ]] && ARGS+=(--topic "$AGENTS_ROOM_TOPIC")
  [[ -n "${AGENTS_ROOM_GOAL:-}" ]] && ARGS+=(--goal "$AGENTS_ROOM_GOAL")
  [[ -n "${AGENT_NAMES:-}" ]] && ARGS+=(--names "$AGENT_NAMES")
  [[ -n "${AGENT_PREFIX:-}" ]] && ARGS+=(--prefix "$AGENT_PREFIX")
  [[ "${REOPEN_ROOM:-0}" == 1 ]] && ARGS+=(--reopen)
  # Kayıt sırrı ve git anahtarı argümanla değil ortamla geçer (ps çıktısında görünmesin).
  return 0
}

# Ekipte kullanılan ama girişi yapılmamış platformlar (claude/codex/gemini).
missing_logins() {
  local k w out=()
  for k in claude codex gemini; do
    w="${k^^}_WORKERS"
    if uses "$k" "${!w:-0}" && ! logged_in "$k"; then out+=("$k"); fi
  done
  echo "${out[*]}"
}

# Giriş yoksa agent'ları başlatmaz: oturumlar hemen biter, konteyner yeniden başlatma döngüsüne düşerdi.
# Giriş yapılınca kendiliğinden devam eder. Denetimi atlamak için AGENTS_ROOM_SKIP_LOGIN_CHECK=1.
wait_for_logins() {
  [[ "${AGENTS_ROOM_SKIP_LOGIN_CHECK:-0}" == 1 ]] && return 0
  local missing shown=""
  while missing=$(missing_logins); [[ -n "$missing" ]]; do
    if [[ "$missing" != "$shown" ]]; then
      shown="$missing"
      echo "agents-room: model girişi bekleniyor: $missing (ekip girişten sonra kendiliğinden başlar)" >&2
      for k in $missing; do
        echo "  Giriş:  docker exec -it $(hostname) agents-room login $k" >&2
      done
      echo "  (ya da compose .env'e anahtar yazın: CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)" >&2
    fi
    sleep 10
    load_config
  done
  [[ -n "$shown" ]] && echo "agents-room: giriş tamam, ekip başlatılıyor." >&2
  return 0
}

prepare_clients() {
  # Codex: API anahtarı verildiyse bir kez giriş yapılır (oturum kalıcı birimde durur).
  if uses codex "${CODEX_WORKERS:-0}" && [[ -n "${OPENAI_API_KEY:-}" && ! -f "$HOME/.codex/auth.json" ]]; then
    printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null
  fi
  # Hermes (deneysel): imaj INSTALL_HERMES=1 ile derlenmiş olmalı; model bağlantısı ortamdan gelir.
  if uses hermes "${HERMES_WORKERS:-0}"; then
    command -v hermes >/dev/null || { echo "Hermes imajda yok: $COMPOSE_HINT build --build-arg INSTALL_HERMES=1" >&2; exit 2; }
    hermes profile list 2>/dev/null | grep -q agentsroom || hermes profile create agentsroom --no-alias --description 'agents-room worker' >/dev/null
    local cfg="$HOME/.hermes/profiles/agentsroom/config.yaml"
    if [[ -n "${HERMES_BASE_URL:-}" ]] && ! grep -q '^model:' "$cfg" 2>/dev/null; then
      printf 'model:\n  provider: custom\n  base_url: "%s"\n  default: "%s"\n  api_key: "${HERMES_API_KEY}"\n' "$HERMES_BASE_URL" "${HERMES_MODEL:-default}" >> "$cfg"
    fi
  fi
}

do_start() {
  load_config
  if ! configured; then
    touch /tmp/agents-room.waiting
    cat <<EOF
agents-room: henüz kurulum yapılmadı; konteyner bekliyor.
  Kurulum:  docker exec -it $(hostname) agents-room setup
  (ya da compose .env'e AGENTS_ROOM_SERVER, AGENTS_ROOM_ENROLL_SECRET, AGENTS_ROOM_ROOM yazıp yeniden başlatın)
EOF
    until ( load_config; configured ); do sleep 3; done
    rm -f /tmp/agents-room.waiting
    echo "agents-room: ayar bulundu, ekip başlatılıyor."
    exec "$0" start
  fi
  mkdir -p "$AGENTS_ROOM_WORKSPACES"
  prepare_clients
  wait_for_logins
  build_args
  exec node "$TEAM" "${ARGS[@]}" --foreground
}

do_status() {
  load_config
  echo "Ayar ($CONFIG):"
  if configured; then
    for v in AGENTS_ROOM_SERVER AGENTS_ROOM_ROOM AGENTS_ROOM_REPO ORCHESTRATORS ORCH_CLIENTS CLAUDE_WORKERS CODEX_WORKERS GEMINI_WORKERS HERMES_WORKERS; do
      [[ -n "${!v:-}" ]] && echo "  $v=${!v}"
    done
    for v in AGENTS_ROOM_ENROLL_SECRET AGENTS_ROOM_GIT_TOKEN; do [[ -n "${!v:-}" ]] && echo "  $v=••••"; done
  else echo "  kurulum yapılmamış (agents-room setup)"; fi
  echo "Model girişleri:"
  for k in claude codex gemini; do logged_in "$k" && echo "  $k ✓" || echo "  $k – giriş yok (agents-room login $k)"; done
  echo "Agent'lar:"; node "$TEAM" status 2>/dev/null | sed 's/^/  /' || true
}

case "${1:-start}" in
  start) do_start ;;
  setup) do_setup ;;
  login) shift; do_login "${1:-}" ;;
  status) do_status ;;
  reset) rm -f "$CONFIG" && echo "Kayıtlı ayar silindi. Yeniden kurmak için: agents-room setup" ;;
  shell) exec bash ;;
  help|-h|--help) sed -n 2,10p "$0" ;;
  *) echo "Bilinmeyen komut: $1 (agents-room help)" >&2; exit 2 ;;
esac
