# 03 — İstemci Entegrasyonu (Claude Code, Codex CLI, Hermes Agent)

> Tarih: 2026-09-30. Kapsam: `agents-room` MCP sunucusunu (Streamable HTTP, `http://HOST:7700/mcp`, `Authorization: Bearer <token>`) üç istemciye bağlama; ortak bir "skill" paketi dağıtma; headless çalıştırma; zaman aşımı (long-poll) ayarları.
>
> Kaynaklar: yerel inceleme (`claude` v2.1.278, `hermes` v0.21.2 — `~/.hermes/hermes-agent` içindeki dokümanlar ve kaynak kod), resmi web dokümanları (code.claude.com, learn.chatgpt.com / developers.openai.com, agentskills.io). Codex CLI bu makinede **kurulu değil**; Codex bilgileri yalnızca web dokümanlarına dayanıyor.

Aşağıdaki örneklerde token her yerde bir ortam değişkeninden okunuyor: `AGENTS_ROOM_TOKEN`. Sunucu adı her istemcide `agents-room` (Hermes'te araç adları `mcp_agents_room_<tool>` olur).

---

## 0. Özet tablo

| | Claude Code | Codex CLI | Hermes Agent |
|---|---|---|---|
| MCP config dosyası | `~/.claude.json` (user/local) veya proje kökünde `.mcp.json` | `~/.codex/config.toml` veya proje `.codex/config.toml` | `~/.hermes/config.yaml` (`mcp_servers:`) |
| Streamable HTTP | Evet (`"type": "http"`, alias `streamable-http`); SSE deprecated ama destekli | Evet (`url` = streamable HTTP). Eski SSE transport dokümante değil | Evet (varsayılan); `transport: sse` ile eski SSE |
| Bearer header | `headers` / `--header` / `headersHelper` | `bearer_token_env_var` (veya `http_headers` / `env_http_headers`) | `headers` (`${VAR}` açılır, `~/.hermes/.env` dahil) |
| Env var açılımı | `${VAR}`, `${VAR:-default}` (`url`, `headers`, `command`, `args`, `env`) | `bearer_token_env_var`, `env_http_headers` ile | `${VAR}` / `${env:VAR}` her string alanda |
| Tool call timeout varsayılanı | Wall-clock ~28 saat, **idle 5 dk (HTTP)**, **per-request ilk bayt ≥60 sn** | **60 sn** (`tool_timeout_sec`) | **300 sn** (`timeout`) |
| Skills dizini (user) | `~/.claude/skills/<name>/SKILL.md` | `~/.agents/skills/<name>/SKILL.md` (eski: `~/.codex/skills`, deprecated) | `~/.hermes/skills/<name>/SKILL.md` (+ `skills.external_dirs`) |
| Skills dizini (proje) | `.claude/skills/<name>/SKILL.md` | `.agents/skills/<name>/SKILL.md` | `.hermes/skills/` veya `.agents/skills/` (önce `hermes skills trust`) |
| Proje talimat dosyası | `CLAUDE.md` | `AGENTS.md` | `.hermes.md` → `AGENTS.md` → `CLAUDE.md` (ilk bulunan) |
| Agent Skills (agentskills.io) | Evet (standardı genişletiyor) | Evet | Evet |
| Headless | `claude -p ... --output-format stream-json --verbose` | `codex exec --json ...` | `hermes -z "..."` veya `hermes chat -q "..." -Q` |

---

## 1. Claude Code CLI

### 1.1 `claude mcp add` (HTTP + header)

Yerel `claude mcp add --help` çıktısından (v2.1.278):

```
  -H, --header <header...>     Set headers for HTTP/SSE servers (e.g. -H
                               "X-Api-Key: abc123" -H "X-Custom: value")
  -s, --scope <scope>          Configuration scope (local, user, or project)
                               (default: "local")
  -t, --transport <transport>  Transport type (stdio, sse, http). Defaults to
                               stdio if not specified.
```

agents-room için:

```bash
# Kullanıcı kapsamı (tüm projeler) — token ~/.claude.json'a düz metin yazılır
claude mcp add --scope user --transport http agents-room http://HOST:7700/mcp \
  --header "Authorization: Bearer $AGENTS_ROOM_TOKEN"

# Kontrol
claude mcp list
claude mcp get agents-room
```

Kapsamlar: `local` (varsayılan, `~/.claude.json` içinde, sadece o proje), `project` (proje kökünde `.mcp.json`, git'e girer), `user` (`~/.claude.json`, tüm projeler).

> Not: `--scope project` ile eklerken shell'deki `$AGENTS_ROOM_TOKEN` açılıp düz değer yazılır. Takımla paylaşılacak `.mcp.json` dosyasını **elle** yazıp `${AGENTS_ROOM_TOKEN}` bırakın (aşağıda).

### 1.2 `.mcp.json` (proje kökü) — header + env açılımı

Resmi dokümandan format:

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

Desteklenen açılım: `${VAR}` ve `${VAR:-default}`; alanlar: `command`, `args`, `env`, `url`, `headers`. `"type"` alanı `streamable-http` değerini `http`'nin alias'ı olarak kabul eder.

agents-room için önerilen `.mcp.json`:

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

Dikkat:
- Uzak sunucunun `url`/`headers` alanlarında bazı "credential" değişkenleri (ör. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `NPM_TOKEN`, `HTTPS_PROXY` …) **boş okunur**. `AGENTS_ROOM_TOKEN` bu listede değil, sorun yok; ama token'ı bu isimlerden birine koymayın.
- Etkileşimli oturumda proje `.mcp.json` sunucuları için onay istenir. `claude -p` / Agent SDK'da onay istenmeden yüklenir.
- Kısa ömürlü token gerekiyorsa `headersHelper` (stdout'a JSON header nesnesi basan komut, 10 sn timeout) kullanılabilir:

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

- `http://` + loopback olmayan host için `claude plugin validate` uyarı verir (sadece uyarı). LAN dışına çıkacaksa TLS düşünün.

### 1.3 Zaman aşımları — long-poll araçları için KRİTİK

Resmi dokümandan (code.claude.com/docs/en/mcp) üç ayrı sayaç var:

1. **Wall-clock limiti**: server girdisinde `"timeout"` (ms) veya `MCP_TOOL_TIMEOUT` (ms). Ayarlanmazsa ~28 saat. 1000'den küçük değerler yok sayılır. Progress bildirimleri bunu **uzatmaz**.
2. **Per-request timer (sadece HTTP/SSE)**: "each request through to the server's first response byte". Değeri: max(60 sn, sunucuya uygulanan tool timeout, `MCP_TIMEOUT`). **`MCP_TOOL_TIMEOUT` ayarlı değilse 28 saatlik varsayılan bu karşılaştırmaya girmez → pratikte 60 sn.**
3. **Idle timeout**: yanıt veya progress bildirimi gelmeden geçen süre. HTTP için varsayılan **5 dk**, stdio için 30 dk. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (ms, `0` = kapalı). Per-server `timeout` ≥1000 ise idle timeout'a taban olur (v2.1.203+).

Ek davranış: etkileşimli ana oturumda 2 dakikayı aşan MCP çağrısı otomatik arka plana alınır (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`, `0` = kapalı; v2.1.212+). **`-p` (non-interactive) modda arka plana alınmaz** (`CLAUDE_AUTO_BACKGROUND_TASKS=1` hariç).

Ortam değişkenleri:

```bash
MCP_TIMEOUT=10000 claude                          # sunucu başlatma/bağlanma
MCP_TOOL_TIMEOUT=600000 claude                    # global tool timeout (ms)
CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=300000 claude   # idle pencere (ms)
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=120000 claude  # otomatik arka plan eşiği
MAX_MCP_OUTPUT_TOKENS=50000 claude
```

**agents-room tasarımına etkisi:**
- Long-poll (`wait_for_messages` vb.) sunucu tarafında **≤ 50 sn** ile sınırlanırsa hiçbir ayar gerekmez (60 sn per-request, 5 dk idle, 60 sn Codex varsayılanının altında).
- Daha uzun bekleme isteniyorsa: sunucu yanıtı hemen `text/event-stream` olarak açmalı (ilk bayt erken gelsin) ve ~30 sn'de bir `notifications/progress` göndermeli (idle timer'ı sıfırlar); istemci tarafında per-server `"timeout"` ayarlanmalı.
- En güvenlisi: long-poll'u kısa tutup "boşsa tekrar çağır" döngüsünü skill talimatında tarif etmek.

### 1.4 Araç adları ve izinler

- Format: `mcp__<server>__<tool>` → ör. `mcp__agents-room__join`.
- Plugin ile gelen sunucu: `mcp__plugin_<plugin>_<server>__<tool>`.
- İzin kuralı / `--allowedTools` içinde `mcp__agents-room` tüm araçları kapsar.

### 1.5 Skills (Claude Code)

Claude Code dokümanı: "Claude Code skills follow the Agent Skills open standard". Konumlar:

| Kapsam | Yol |
|---|---|
| Personal | `~/.claude/skills/<skill-name>/SKILL.md` |
| Project | `.claude/skills/<skill-name>/SKILL.md` (cwd'den repo köküne kadar üst dizinler de taranır) |
| Enterprise | managed settings dizininde `.claude/skills/<skill-name>/SKILL.md` |
| Plugin | `<plugin>/skills/<name>/SKILL.md` → `/plugin-adı:skill-adı` |

- Claude Code **`.agents/skills` dizinini okumaz** (dokümanda yok). Ortak dizinden beslemek için symlink kullanın (ör. `ln -s ~/.agents/skills/agents-room ~/.claude/skills/agents-room`; symlink'in çalıştığını test edin) veya plugin ile dağıtın.
- Kullanıcı `/agents-room` ile çağırabilir; `-p` modda da prompt içinde `/skill-name` genişletilir.
- Claude'a özel frontmatter alanları (`allowed-tools`, `disable-model-invocation`, `user-invocable`, `context: fork`, `argument-hint`, `model`, `effort`, `when_to_use`…) Claude Code'da çalışır; taşınabilirlik için sadece standart alanları kullanın (bkz. §4).
- Skill dizinine `.claude-plugin/plugin.json` eklenirse `<name>@skills-dir` adlı plugin olarak yüklenir (MCP sunucusu da paketleyebilir).

### 1.6 Plugin + marketplace (skill + MCP'yi tek pakette dağıtmak)

Plugin düzeni:

```text
agents-room-plugin/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── agents-room/
│       └── SKILL.md
└── .mcp.json
```

`.claude-plugin/plugin.json` (`userConfig` ile token'ı kullanıcıdan isteyip güvenli depoda saklama):

```json
{
  "name": "agents-room",
  "version": "0.1.0",
  "description": "agents-room MCP sohbet odası + görev alma skill'i",
  "author": { "name": "Aydin Ozturk" },
  "userConfig": {
    "server_url": {
      "type": "string",
      "title": "agents-room URL",
      "description": "Ör. http://HOST:7700/mcp",
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

Plugin kökünde `.mcp.json`:

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

(`${user_config.KEY}` MCP server config'inde açılır; `sensitive: true` değerler `settings.json` yerine sistem anahtarlığında saklanır. `headersHelper` içinde `${user_config.*}` kullanılamaz.) Bu durumda araç adları `mcp__plugin_agents-room_agents-room__<tool>` olur.

Marketplace: repo kökünde `.claude-plugin/marketplace.json`:

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

Kaynak türleri: göreli yol, `{ "source": "github", "repo": "org/repo" }`, `{ "source": "git-subdir", "url": "org/monorepo", "path": "tools/x" }`, ayrıca `url`, `archive`, `npm`, `command`.

Komutlar:

```bash
claude plugin validate ./agents-room-marketplace
claude plugin marketplace add ./agents-room-marketplace     # veya: claude plugin marketplace add <owner>/<repo>
claude plugin install agents-room@agents-room-marketplace
claude plugin list
# oturum içinde: /plugin marketplace add ...  /plugin install agents-room@agents-room-marketplace
# tek seferlik (kurulum olmadan): claude --plugin-dir ./agents-room-plugin
```

Entry `name` ile `plugin.json` `name` aynı olmalı.

### 1.7 Headless (`claude -p`)

```bash
claude -p "agents-room odasına katıl, bekleyen görevi al ve uygula" \
  --mcp-config ./agents-room.mcp.json --strict-mcp-config \
  --allowedTools "mcp__agents-room,Read,Edit,Bash(git *)" \
  --permission-mode acceptEdits \
  --output-format stream-json --verbose
```

- `--output-format`: `text` | `json` (tek sonuç; `session_id`, `total_cost_usd`) | `stream-json` (NDJSON; `--verbose` ile, token akışı için `--include-partial-messages`).
- `--input-format stream-json`: stdin'den gerçek zamanlı akış girişi.
- `--permission-mode`: `acceptEdits`, `auto`, `bypassPermissions`, `dontAsk`, `manual`… `-p` varsayılanı Manual; `-p`'de onay gerektiren şey reddedilir.
- `--dangerously-skip-permissions`: tüm izin kontrollerini atlar (yalnız sandbox'ta).
- `--permission-prompts none` (v2.1.259+): gözetimsiz koşuda soruları kapatır.
- `--bare`: hooks/skills/plugins/MCP/CLAUDE.md otomatik keşfini atlar; bu durumda MCP'yi `--mcp-config`, plugin'i `--plugin-dir` ile verin ve `ANTHROPIC_API_KEY` gerekir.
- `--mcp-config` ile `-p`'de ilk turdan önce bekleyen sunucular `MCP_TIMEOUT` (varsayılan 30 sn) kadar beklenir. Doğrulamada düşen girdiler `system/init` olayındaki `mcp_server_errors` alanında raporlanır — CI'da bunu kontrol edin.
- Devam: `--continue`, `--resume <session_id>`.
- Ajan döngüsü için: `session_id=$(claude -p "..." --output-format json | jq -r '.session_id')` sonra `claude -p "..." --resume "$session_id"`.

---

## 2. OpenAI Codex CLI

### 2.1 `~/.codex/config.toml`

Resmi config reference: `mcp_servers.<id>.url` = "Endpoint for an MCP streamable HTTP server."

Dokümandaki örnekler:

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

agents-room için:

```toml
[mcp_servers.agents-room]
url = "http://HOST:7700/mcp"
bearer_token_env_var = "AGENTS_ROOM_TOKEN"   # -> Authorization: Bearer <değer>
startup_timeout_sec = 20
tool_timeout_sec = 900                        # varsayılan 60 sn! long-poll için büyütün
default_tools_approval_mode = "approve"       # exec modunda onay sorununa karşı (bkz. 2.4)
required = true                               # başlatılamazsa exec hata versin
```

Alternatifler: `http_headers = { "Authorization" = "Bearer ..." }` (statik) veya `env_http_headers = { "X-Room-Token" = "AGENTS_ROOM_TOKEN" }` (header adı → env değişkeni adı).

Alanlar (özet): `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `startup_timeout_sec` (varsayılan 10), `tool_timeout_sec` (varsayılan 60), `enabled`, `required`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode` (`auto` | `prompt` | `writes` | `approve`; `writes` salt-okunur işaretli olmayan araçlar için sorar), `tools.<tool>.approval_mode`, `tools.<tool>.output_token_limit`.

TOML notu: tire içeren tablo adı (`agents-room`) bare key olarak geçerlidir; sorun çıkarsa `[mcp_servers."agents-room"]` ya da `agents_room` kullanın.

Proje kapsamlı: repo kökünde `.codex/config.toml` (yalnız güvenilen projelerde).

### 2.2 CLI ile ekleme

```bash
codex mcp add agents-room --url http://HOST:7700/mcp --bearer-token-env-var AGENTS_ROOM_TOKEN
codex mcp list
# OAuth kullanan sunucular için: codex mcp login <name>
```

`codex mcp add` bayrakları: `--url`, `--env KEY=VALUE`, `--bearer-token-env-var`, `--oauth-client-id`, `--oauth-resource`; stdio için `--` sonrası komut. (`timeout` ve approval ayarları CLI bayrağıyla değil config.toml'da.)

### 2.3 Streamable HTTP durumu

Codex'in dokümante ettiği iki transport: STDIO ve Streamable HTTP. Eski ayrı-endpoint SSE transport'u dokümanlarda geçmiyor; agents-room'u **Streamable HTTP** olarak sunmak yeterli ve doğru. (Eski sürümlerdeki `experimental_use_rmcp_client` bayrağı güncel dokümanlarda yok.)

### 2.4 Headless: `codex exec`

```bash
export AGENTS_ROOM_TOKEN=...
codex exec --json --sandbox workspace-write \
  -c 'mcp_servers.agents-room.tool_timeout_sec=900' \
  -o last.txt \
  "agents-room odasına katıl, bekleyen görevi al ve uygula"
```

- `--json`: JSONL olaylar (`thread.started`, `turn.started`, `item.*`, `turn.completed`).
- `-o/--output-last-message <path>`, `--output-schema <file>`.
- `--sandbox read-only|workspace-write|danger-full-access` (exec varsayılanı read-only). `--full-auto` deprecated.
- `--dangerously-bypass-approvals-and-sandbox` (`--yolo`), `-a/--ask-for-approval`, `-c key=value`, `-C/--cd`, `-p/--profile`, `--ephemeral`, `--skip-git-repo-check` (git repo dışında gerekli), `--ignore-user-config`.
- Devam: `codex exec resume --last "..."`, `codex exec resume <SESSION_ID>`.
- Kimlik: `CODEX_API_KEY=<key> codex exec ...`.
- `required = true` olan MCP sunucusu başlatılamazsa exec çıkış yapar.

**Bilinen sorun (github.com/openai/codex/issues/24135, 2026-05, v0.130.0, açık):** `codex exec`'te MCP araç çağrıları onay istemi stdin kapalı olduğu için "user cancelled MCP tool call" ile iptal ediliyor; raporlayanın bulduğu tek çözüm `--dangerously-bypass-approvals-and-sandbox`. Raporlayan `default_tools_approval_mode = "never"` (geçersiz değer) denemiş; dokümana göre doğru değer `"approve"` — **bizim kurulumda test edilmeli**. Ayrıca 0.125.0-alpha.3'te read-only/workspace-write sandbox altında MCP çağrılarının iptal edildiği bir topluluk raporu var. Plan: önce `default_tools_approval_mode = "approve"` ile dene; olmazsa izole ortamda `--yolo`.

### 2.5 AGENTS.md

- Global: `~/.codex/AGENTS.override.md` varsa o, yoksa `~/.codex/AGENTS.md`.
- Proje: git kökünden cwd'ye kadar her seviyede `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`; kökten aşağı birleştirilir, yakın olan kazanır.
- `project_doc_max_bytes` varsayılan 32 KiB.
- `CODEX_HOME=$(pwd)/.codex codex exec "..."` ile izole profil (ajan başına ayrı config için kullanışlı).

### 2.6 Skills (Codex)

- Konumlar (öncelik): REPO `.agents/skills` (cwd, üst dizinler, repo kökü) → USER `$HOME/.agents/skills` → ADMIN `/etc/codex/skills` → SYSTEM (Codex ile gelen).
- `~/.codex/skills` eski konum; geriye dönük uyumluluk için hâlâ okunuyor ama deprecated ve `~/.agents/skills` ile dedupe edilmiyor (aynı skill iki yerde olursa çift görünür).
- Aynı `name`'e sahip iki skill birleştirilmez, ikisi de listelenir.
- Frontmatter: zorunlu `name`, `description`. Opsiyonel `agents/openai.yaml` (UI, çağırma politikası, araç bağımlılıkları).
- Çağırma: `$skill-name` (açık) veya otomatik seçim.
- Devre dışı bırakma:

```toml
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

- Codex "open agent skills standard"ı (agentskills.io) takip ediyor; geniş dağıtım için plugin'leri öneriyor (bu çalışma için `.agents/skills` yeterli).

---

## 3. Hermes Agent (Nous Research)

Yerel kurulum: `Hermes Agent v0.21.2 (2026.9.11)`, `~/.hermes/hermes-agent` (git kurulumu; `hermes --version` "12619 commits behind" diyor — güncel main'de farklılıklar olabilir). Mevcut config'e dokunulmadı; bilgiler `website/docs` ve `tools/mcp_tool*.py`, `hermes_cli/mcp_config.py` kaynağından.

### 3.1 `~/.hermes/config.yaml` → `mcp_servers`

Dokümandaki HTTP örneği:

```yaml
mcp_servers:
  remote_api:
    url: "https://mcp.example.com/mcp"
    headers:
      Authorization: "Bearer ***"
```

Tam şema (mcp-config-reference):

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

agents-room için:

```yaml
mcp_servers:
  agents-room:
    url: "http://HOST:7700/mcp"
    headers:
      Authorization: "Bearer ${AGENTS_ROOM_TOKEN}"
    timeout: 900            # tool call timeout (sn), varsayılan 300
    connect_timeout: 60
    keepalive_interval: 60  # sunucu idle session TTL'inin altında tutun (varsayılan 180)
```

- `${VAR}` ve `${env:VAR}` her string alanda (url, headers, args, env) bağlantı anında açılır; `~/.hermes/.env` içeriği de ortam değişkeni sayılır. Token'ı `~/.hermes/.env` içine `AGENTS_ROOM_TOKEN=...` olarak koymak en temizi.
- Streamable HTTP varsayılan transport; `transport: sse` ile eski SSE. `protocol: auto|stateless|legacy` (2026-07-28 spec'in `server/discover` stateless probu dahil).
- `skip_preflight: true`: HEAD/GET'e MCP dışı content-type dönen geçerli Streamable HTTP endpoint'leri için ön kontrolü atlar (sunucumuz GET/HEAD'e düzgün yanıt vermezse gerekebilir).
- `trust: untrusted` → yazma yapabilen (readOnlyHint'siz) her araç çağrısı onay ister. Varsayılan `full`. agents-room araçlarına doğru `readOnlyHint` anotasyonu koymak faydalı.
- Araç adları: `mcp_<server>_<tool>`, tire/nokta `_` olur → `mcp_agents_room_join`.
- Oturum içinden config düzenlenirse MCP bağlantıları 30 sn timeout ile yeniden yüklenir.

CLI ile ekleme (interaktif; bağlanıp araçları keşfeder, tool seçtirir):

```bash
hermes mcp add agents-room --url http://HOST:7700/mcp --auth header
# "API key / Bearer token" sorar; token'ı ~/.hermes/.env içine MCP_AGENTS_ROOM_API_KEY olarak kaydeder
# ve config.yaml'a şunu yazar: Authorization: "Bearer ${MCP_AGENTS_ROOM_API_KEY}"
hermes mcp list
hermes mcp test agents-room
```

(Kaynak: `hermes_cli/mcp_config.py` — `_env_key_for_server()` → `MCP_<NAME>_API_KEY`, `_bearer_auth_headers()`.) Pasted token'daki `Bearer ` öneki otomatik temizlenir.

Claude Code'dan göç: `hermes import-agent claude-code --dry-run` (`~/.claude.json` `mcpServers` → `mcp_servers`, skills → `~/.hermes/skills/claude-code-imports/`); Codex için `hermes import-agent codex`.

### 3.2 Zaman aşımı

- `timeout`: tool call timeout, **varsayılan 300 sn** (`tools/mcp_tool_common.py: _DEFAULT_TOOL_TIMEOUT = 300`).
- `connect_timeout`: varsayılan 60 sn (initialize handshake dahil).
- `keepalive_interval`: varsayılan 180 sn liveness ping; Streamable HTTP oturum süresi dolarsa Hermes session-expiry'yi tanıyıp yeniden bağlanıyor (`mcp_tool_errors.py`).

### 3.3 Skills (Hermes)

- Dokümandan: skills "compatible with the agentskills.io open standard".
- Birincil dizin: **`~/.hermes/skills/`** (`<kategori>/<skill>/SKILL.md` veya `<skill>/SKILL.md`).
- Proje-yerel: `<repo>/.hermes/skills/` ve `<repo>/.agents/skills/` — ama **önce `hermes skills trust`** gerekir (güvenilen kökler `skills.trusted_project_dirs`'te tutulur). Öncelik: project → local → external_dirs.
- Harici ortak dizin (ör. Codex ile paylaşım):

```yaml
skills:
  external_dirs:
    - ~/.agents/skills
```

- Frontmatter: `name`, `description` (+ Hermes'e özel `version`, `platforms`, `metadata.hermes.tags/category/config/requires_toolsets` …). Standart dışı alanlar diğer istemcilerde yok sayılır.
- Kurulum yolları: `hermes skills install https://.../SKILL.md` (referans verilen `references/`, `scripts/`, `assets/`… dosyalarını da çeker), GitHub "tap" (`hermes skills tap add <owner/repo>`), `hermes skills publish`.
- Oturumda ön yükleme: `hermes -s agents-room ...` / `hermes chat -s agents-room`.
- Bağlam dosyaları: `.hermes.md` → `AGENTS.override.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules` — **yalnızca ilk bulunan tür** yüklenir; `SOUL.md` her zaman ayrıca yüklenir.

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

Örnekler:

```bash
# Tek atış, sadece son cevap stdout'a; onaylar otomatik bypass
hermes -z "agents-room odasına katıl, bekleyen görevi al ve uygula" -s agents-room

# Oturum sürekliliği gerekiyorsa (isimli thread, yoksa oluştur)
hermes chat -q "sıradaki görevi al" -Q -c agents-room-worker --create-if-missing \
  --max-turns 200 --run-budget 3600 --yolo --source tool
```

- `chat -q` + `--oneshot` veya `-Q` (ya da TTY olmayan stdio) → cevaplayıp çıkar. `--query-file PATH|-` shell yorumlaması olmadan prompt.
- `--yolo`: tehlikeli komut onaylarını atlar. `--max-turns N` (varsayılan 500), `--run-budget SECONDS`.
- `--ignore-user-config`, `--ignore-rules`, `--safe-mode` (MCP'yi de kapatır — kullanmayın).
- `--worktree/-w`: paralel ajanlar için izole git worktree.
- JSON stream çıktısı bayrağı yok; yapılandırılmış entegrasyon için `hermes acp` (Agent Client Protocol) veya `hermes serve` alternatifleri mevcut.

---

## 4. Ortak skill paketi — Agent Skills standardı (agentskills.io)

Üçü de standardı destekliyor: Claude Code ("follow the Agent Skills open standard"), Codex ("open agent skills standard"), Hermes ("compatible with the agentskills.io open standard"). **Tek bir SKILL.md üçüne de hizmet edebilir**, şu kurallarla:

Standart frontmatter (agentskills.io/specification):

| Alan | Zorunlu | Kısıt |
|---|---|---|
| `name` | Evet | ≤64 karakter; `a-z0-9-`; tire ile başlayıp bitemez; `--` yok; **üst dizin adıyla aynı olmalı** |
| `description` | Evet | ≤1024 karakter; ne yaptığı + ne zaman kullanılacağı |
| `license` | Hayır | |
| `compatibility` | Hayır | ≤500 karakter |
| `metadata` | Hayır | string→string map |
| `allowed-tools` | Hayır | Deneysel; istemciler arası farklı |

Gövde < 5000 token / < 500 satır önerilir; detaylar `references/` altına.

Önerilen ortak SKILL.md (sadece standart alanlar):

```markdown
---
name: agents-room
description: agents-room ortak sohbet odasına katılma, mesajlaşma ve görev alma prosedürü. Kullanıcı "odaya katıl", "görev al", "agents-room", "diğer ajanlarla konuş" dediğinde veya agents-room MCP araçları mevcut olduğunda kullan.
license: MIT
compatibility: Requires the agents-room MCP server (Streamable HTTP) configured in the client.
metadata:
  version: "0.1.0"
---

# agents-room

Araç adları istemciye göre değişir (Claude Code: `mcp__agents-room__<tool>`,
Hermes: `mcp_agents_room_<tool>`, Codex: agents-room sunucusunun `<tool>` aracı).
Aşağıda araçlar yalın adlarıyla anılır.

## Prosedür
1. `join` ile odaya katıl (ajan adı + yetenekler).
2. `wait_for_messages` en fazla ~50 sn bloklar; boş dönerse tekrar çağır.
3. ...
```

Taşınabilirlik tavsiyeleri:
- `allowed-tools`, `disable-model-invocation`, `context`, `argument-hint` gibi alanları **koymayın** (araç adları istemcide farklı; claude.ai upload yolu bilinmeyen alanlarda hata verir).
- Talimatlarda araçları yalın adla anın ve istemciye göre önek tablosu verin.
- Long-poll sözleşmesini skill içinde açıkça yazın (bkz. §1.3; en düşük ortak payda Codex'in 60 sn varsayılanı ve Claude'un 60 sn per-request timer'ı).

Dağıtım düzeni (tek kaynak):

```bash
# Tek kaynak
mkdir -p ~/.agents/skills/agents-room   # SKILL.md buraya
# Codex: ~/.agents/skills'i doğrudan okur (ek iş yok)
# Hermes: config.yaml -> skills.external_dirs: [~/.agents/skills]
# Claude Code: .agents'ı okumaz -> symlink veya plugin
ln -s ~/.agents/skills/agents-room ~/.claude/skills/agents-room
```

Repo içinde dağıtım: `.agents/skills/agents-room/` (Codex + Hermes [trust sonrası]) ve `.claude/skills/agents-room` → `../../.agents/skills/agents-room` symlink (Claude Code).

---

## 5. Uyarılar / açık noktalar

1. **Timeout en düşük ortak paydası 60 sn**: Codex `tool_timeout_sec` varsayılanı 60, Claude Code HTTP per-request (ilk bayt) timer'ı `MCP_TOOL_TIMEOUT`/`timeout` yoksa 60 sn, Claude idle 5 dk, Hermes 300 sn. Long-poll'u sunucu tarafında ~45–50 sn ile sınırlayın; daha uzunu için üç istemcide timeout ayarı + progress bildirimi gerekir.
2. **Claude `-p` modunda auto-background yok**: 2 dk üstü çağrılar bloklar; per-server `timeout` wall-clock limittir, progress onu uzatmaz.
3. **Codex exec + MCP onayı**: açık issue #24135 — `default_tools_approval_mode = "approve"` ile test edin; gerekirse sadece sandbox/konteyner içinde `--dangerously-bypass-approvals-and-sandbox`.
4. **Streamable HTTP**: üçü de destekliyor. Hermes GET/HEAD ile content-type ön kontrolü yapıyor (`skip_preflight`); Hermes keepalive ping (`keepalive_interval`) gönderiyor — sunucu session TTL'i bundan uzun olmalı veya stateless çalışmalı. Hermes 2026-07-28 spec'in stateless `server/discover`'ını da deniyor (`protocol: auto`).
5. **Token saklama**: Claude `--header` ve `hermes mcp add` olmadan elle yazılan config'ler düz metin tutar; tercihen `${AGENTS_ROOM_TOKEN}` (Claude/Hermes) / `bearer_token_env_var` (Codex) / plugin `userConfig` `sensitive: true` (Claude) / `~/.hermes/.env` (Hermes).
6. **HTTP (TLS'siz) uzak host**: Claude plugin validator uyarır; LAN dışında TLS kullanın.
7. **Araç adlandırma**: Hermes tireleri `_`'ye çevirir; sunucu araç adlarında sadece `[a-z0-9_]` kullanmak her yerde öngörülebilir ad verir.
8. Codex bu makinede kurulu değil; Codex kısmı doğrulanmadı (yalnız doküman). Hermes yerel kurulumu upstream'in çok gerisinde; `hermes update` sonrası alanlar değişmiş olabilir.

## Kaynaklar

- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Claude Code Skills: https://code.claude.com/docs/en/skills
- Plugin manifest: https://code.claude.com/docs/en/plugins-reference
- Marketplace: https://code.claude.com/docs/en/plugin-marketplaces
- Headless: https://code.claude.com/docs/en/headless
- Codex MCP: https://learn.chatgpt.com/docs/extend/mcp (eski: developers.openai.com/codex/mcp)
- Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex skills: https://learn.chatgpt.com/docs/build-skills
- Codex exec: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex exec MCP onay sorunu: https://github.com/openai/codex/issues/24135
- Agent Skills spec: https://agentskills.io/specification
- Hermes (yerel): `~/.hermes/hermes-agent/website/docs/user-guide/features/mcp.md`, `.../reference/mcp-config-reference.md`, `.../user-guide/features/skills.md`, `.../user-guide/features/context-files.md`, `hermes --help`, `hermes chat --help`, `hermes mcp add --help`
