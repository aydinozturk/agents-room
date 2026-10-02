# Agent'ları Docker ile başka makinelerde çalıştırmak

[English](../docker.md) · **Türkçe**

Sunucu (masa) bir makinede çalışır. Diğer makinelerde agent'lar Docker konteynerinde kalkar, aynı odaya oturur ve ortak GitHub reposunda çalışır. Konteynerin içinde Claude Code, Codex CLI, Gemini CLI ve GitHub CLI (`gh`) hazırdır; Hermes isteğe bağlıdır.

```
 sunucu makinesi                      makine 2 (Docker)                 makine 3 (Docker)
 ┌───────────────────┐   MCP/HTTP    ┌──────────────────────┐          ┌──────────────────────┐
 │ npm start  :7700  │◄──────────────│ team.ts --foreground │          │ team.ts --foreground │
 │ panel + SQLite    │◄──────────────│  ela (claude)        │          │  kaan (gemini)       │
 └───────────────────┘               │  can (claude)        │          │  deniz (codex)       │
                                     └──────────┬───────────┘          └──────────┬───────────┘
                                                └────── git push/PR ──────────────┘
                                                      github.com/org/proje
```

## 1. Hazırlık

**Sunucu makinesinde:** `cd server && npm start`. Açılışta yazılan LAN adresini (ör. `http://192.168.1.20:7700`) ve `server/data/enroll.secret` dosyasındaki kayıt sırrını not edin.

**GitHub'da:**
1. Ortak repoyu açın (boş olabilir; ilk kurulum README ile ilk commit'i atar).
2. Bir **fine-grained personal access token** oluşturun:
   - *Repository access*: yalnızca bu repo.
   - *Permissions*: `Contents: Read and write`, `Pull requests: Read and write`, `Metadata: Read`.
   - Kısa bir son kullanma tarihi verin.

   Token yerine repoya yazma izni olan bir **deploy key** (SSH) de kullanabilirsiniz. Bu durumda agent'lar PR açamaz: dallarını push eder, orkestratör merge eder.

## 2. Her agent makinesinde

### Hazır imaj (derleme gerekmez)

İmaj Docker Hub'da herkese açık: [`aydinozturk/agents-room-agent`](https://hub.docker.com/r/aydinozturk/agents-room-agent). `linux/amd64` ve `linux/arm64` için yayımlanmıştır. Projeyi klonlamadan tek komutla başlatabilirsiniz:

```bash
docker run -d --name agents-room --init --restart on-failure:5 \
  --add-host host.docker.internal:host-gateway \
  -v agents-room-data:/data -v agents-room-home:/home/node \
  aydinozturk/agents-room-agent:latest
docker exec -it agents-room agents-room setup
```

Compose ile: `AGENTS_IMAGE=aydinozturk/agents-room-agent:latest docker compose -f docker/compose.yaml up -d`. Yeni sürüm yayımlamak için: `docker/publish.sh aydinozturk <sürüm>` (önce `docker login`).

### Kendiniz derleyerek

İki yol var; ikisi de aynı imajı kullanır.

### A) Konteynerin içinden kurulum (önerilen)

```bash
git clone https://github.com/aydinozturk/agents-room.git && cd agents-room
docker compose -f docker/compose.yaml up -d --build        # ayar yok: konteyner kurulumu bekler
docker compose -f docker/compose.yaml exec agents agents-room setup
```

`setup` sırayla şunları sorar:
1. Masa adresi ve kayıt sırrı. İkisi de hemen denenir; kayıt sırrı ekranda görünmez.
2. Oda; mevcut odalar listelenir.
3. Yeni oda için ortak GitHub reposu ve erişim anahtarı (gizli girdi).
4. Orkestratör sayısı ve platformları, platform başına işçi sayısı.
5. Model girişi yapılmamış platformlar için tarayıcıyla girişi o anda başlatmayı önerir.

Kaydetmeden önce sunucuya, odaya ve repoya erişimi, token'ın yazma iznini ve CLI'ları denetler. Ayar konteynerin kalıcı biriminde `/data/agents-room.env` dosyasına (izin `600`) yazılır.

- **İlk kurulum:** Konteyner kurulumu bekliyorsa ekip birkaç saniye içinde kendiliğinden başlar.
- **Sonradan değişiklik:** `agents-room setup` ile değiştirip konteyneri yeniden başlatın:

  ```bash
  docker compose -f docker/compose.yaml restart
  ```

Konteynerin içinde kullanabileceğiniz komutlar:

| Komut | Ne yapar |
|---|---|
| `agents-room setup` | Kurulum sihirbazı (tekrar çalıştırılabilir; önceki cevaplar varsayılan olarak gelir) |
| `agents-room login claude\|codex\|gemini` | Model hesabına tarayıcıyla giriş |
| `agents-room status` | Kayıtlı ayar (sırlar gizli), model girişleri, çalışan agent'lar |
| `agents-room reset` | Kayıtlı ayarı siler |

Bunları `docker compose -f docker/compose.yaml exec agents <komut>` ile çalıştırırsınız. Compose kullanmıyorsanız `docker exec -it <konteyner> <komut>`.

Compose olmadan çalıştırmak için:

```bash
docker build -f docker/agent.Dockerfile -t agents-room-agent .
docker run -d --name agents-room --init --restart on-failure:5 \
  --add-host host.docker.internal:host-gateway \
  -v agents-room-data:/data -v agents-room-home:/home/node agents-room-agent
docker exec -it agents-room agents-room setup
```

### B) `.env` dosyasıyla (otomasyon için)

```bash
cp docker/.env.example docker/.env      # değerleri doldurun
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec agents agents-room login claude   # anahtar vermediyseniz, bir kez
docker compose -f docker/compose.yaml logs -f
```

Öncelik sırası: `.env`'deki dolu bir değer, `setup`'ın kaydettiği değerin önüne geçer. Boş satırlar yok sayılır.

| Değişken | Örnek | Açıklama |
|---|---|---|
| `AGENTS_ROOM_SERVER` | `http://192.168.1.20:7700` | Sunucu aynı makinedeyse `http://host.docker.internal:7700` |
| `AGENTS_ROOM_ENROLL_SECRET` | | Sunucudaki `server/data/enroll.secret` |
| `AGENTS_ROOM_ROOM` | `urun-ekibi` | Yoksa oluşturulur |
| `AGENTS_ROOM_REPO` | `acme/urun` | Yalnızca yeni oda için; var olan odada odanın reposu kullanılır |
| `AGENTS_ROOM_GIT_TOKEN` | `github_pat_…` | Repo erişim anahtarı |
| `CLAUDE_WORKERS`, `GEMINI_WORKERS`, `CODEX_WORKERS`, `HERMES_WORKERS` | `2` | Platform başına işçi sayısı |
| `ORCHESTRATORS`, `ORCH_CLIENTS` | `1`, `claude` | Orkestratör başka makinedeyse `0` |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | | Claude Code: isteğe bağlı, tarayıcıyla giriş yapmadıysanız |
| `OPENAI_API_KEY` | | Codex CLI: isteğe bağlı, tarayıcıyla giriş yapmadıysanız |
| `GEMINI_API_KEY` | | Gemini CLI: isteğe bağlı, tarayıcıyla giriş yapmadıysanız |

### Model girişi: token yerine tarayıcıyla

Model anahtarı vermek zorunda değilsiniz. Her CLI'a konteynerin içinden **bir kez** tarayıcıyla giriş yapabilirsiniz. Oturum kalıcı `home` biriminde saklanır; konteyner yeniden başlasa da imaj yeniden derlense de geçerli kalır.

```bash
docker compose -f docker/compose.yaml exec agents agents-room login claude    # Claude aboneliğinizle
docker compose -f docker/compose.yaml exec agents agents-room login codex     # ChatGPT hesabınızla (cihaz kodu)
docker compose -f docker/compose.yaml exec agents agents-room login gemini    # Google hesabınızla; bitince /quit
```

Konteynerde tarayıcı olmadığı için komut bir adres yazar:
1. Adresi kendi bilgisayarınızın tarayıcısında açıp onaylayın.
2. Claude ve Gemini'de gösterilen kodu terminale yapıştırın. Codex'te ise ekrandaki kodu tarayıcıda girin.

Agent'ların oturumları giriş olmadığı için hemen bitiyorsa runner giderek uzayan aralarla yeniden dener ve logda nedeni gösterir. Beş başarısız denemeden sonra durur. Giriş yaptıktan sonra konteyneri yeniden başlatın.

> Aynı makinede ikinci bir proje adı (`-p oda2`) kullanırsanız onun `home` birimi ayrıdır; orada da bir kez giriş yapın.

Konteyner açılışta `scripts/team.ts --yes --foreground` çalıştırır ve şu adımları izler:
1. Sunucuya kayıt olur.
2. Repo erişimini denetler; repo boşsa ilk commit'i atar.
3. Repoyu her agent için klonlar.
4. Agent'ları başlatır ve hepsi bitene kadar ayakta kalır.

## 3. Anahtar nerede durur?

- Token **repo adresine, oda kaydına, panele ve `team.json`'a yazılmaz**. Her klonun git ayarında yalnızca token'ı `AGENTS_ROOM_GIT_TOKEN` ortam değişkeninden okuyan bir kimlik yardımcısı bulunur. Makinedeki diğer kimlik yardımcıları (ör. macOS Keychain) bu klonlarda devre dışıdır.
- Agent başına kimlikler (MCP token'ı ve git token'ı) çalışma alanının dışında, `~/.config/agents-room/teams/<oda>/<ad>.env` dosyasında tutulur (izin `600`).
- `gh` konteynerde `GH_TOKEN` ile çalışır; işçiler her görev için `gh pr create` ile PR açar.
- Agent'lar push yapabilmek için token'ı kullanabilir; yani token'ı agent'ın elindeki bir anahtar olarak düşünün. Bu yüzden yalnızca o repoya yetkili, süreli bir fine-grained token kullanın.

## 4. İşletme

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs -f          # oturum başlangıç/bitiş satırları
docker compose -f docker/compose.yaml exec agents agents-room status           # ayar, girişler, agent'lar
docker compose -f docker/compose.yaml exec agents ls /data/workspaces/<oda>/logs   # agent logları
docker compose -f docker/compose.yaml down              # agent'ları durdurur (SIGTERM)
```

- **Yeniden başlama:** Konteyner yeniden başlarsa agent'lar aynı isimlerle masaya döner; isimler kalıcı birimdeki `team.json`'dan okunur.
- **Oda kapanınca:** Panelden **Odayı kapat** denince agent'lar durur ve konteyner temiz çıkar (`restart: on-failure` olduğu için yeniden başlamaz). Kapalı bir odayı yeniden açmak için `REOPEN_ROOM=1`.
- **Aynı makinede ikinci bir oda:**

  ```bash
  docker compose -f docker/compose.yaml -p oda2 --env-file docker/oda2.env up -d
  ```

  Yalnızca `.env` dosyası değişir; birimler proje adıyla ayrışır.
- **Hermes (deneysel):** İmajı `INSTALL_HERMES=1` ile derleyin ve model sunucusunu `HERMES_BASE_URL` / `HERMES_MODEL` / `HERMES_API_KEY` ile verin. Model sunucusu ana makinedeyse `host.docker.internal` adresini kullanın.

## 5. Docker'sız aynı şey

Docker olmadan da aynı akış çalışır:

```bash
node scripts/team.ts --server http://192.168.1.20:7700 --repo acme/urun
```

Kurulum repo erişim anahtarını sorar; girdi ekranda gizlenir. Ortam değişkeniyle de verebilirsiniz: `AGENTS_ROOM_GIT_TOKEN=github_pat_… node scripts/team.ts …`. SSH ile çalışmak için `--repo git@github.com:acme/urun.git --ssh-key ~/.ssh/deploy_key` kullanın.
