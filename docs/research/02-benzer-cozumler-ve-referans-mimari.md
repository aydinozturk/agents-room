# 02 — Benzer Çözümler ve agents-room Referans Mimarisi

> Tarih: 2026-09-30 · Kapsam: Açık kaynak ve öne çıkan çoklu-ajan (multi-agent) koordinasyon araçlarının taranması, ardından agents-room için bir referans mimari çıkarılması.
> Not: Yıldız sayıları ve sürüm bilgileri araştırma anındaki kaynaklardan alınmıştır; hızlı değiştikleri için yaklaşık kabul edilmelidir.

## 1. Özet

Pazardaki çözümler üç ana kümeye ayrılıyor:

1. **Koordinasyon katmanı / MCP sunucuları** (mcp_agent_mail, Agent-MCP, chat-mcp/mcp-comms türevleri, Ruflo): Ajanlara kimlik, mesajlaşma, görev ve dosya kilidi sağlar. agents-room'un doğrudan akrabaları bunlar.
2. **Yerel paralel çalıştırıcılar** (Claude Code agent teams, claude-squad, uzi, Conductor, vibe-kanban, container-use): Tek makinede, her ajana ayrı bir git worktree/container vererek izolasyon sağlar. Makineler arası koordinasyon yoktur ya da çok zayıftır.
3. **Uygulama çerçeveleri (framework)** (AutoGen/AG2/Microsoft Agent Framework, CrewAI, LangGraph, OpenAI Agents SDK, MetaGPT, ChatDev, CAMEL, Swarms, OpenHands, Letta): Ajanları tek süreç ya da tek servis içinde kod ile birleştirir. Heterojen CLI ajanlarını (Claude Code, Codex, Hermes) "katılımcı" olarak kabul etmezler; ancak orkestrasyon kalıpları (supervisor, group chat, handoff, SOP) açısından çok öğreticidirler.

Sonuç: **"Heterojen CLI ajanları + makineler arası + ortak repo + görev panosu + orkestratör döngüsü" kombinasyonunu uçtan uca sunan olgun bir açık kaynak çözüm yok.** En yakını mcp_agent_mail (mesaj + dosya kiralama) ile Beads (görev grafiği) ikilisi. agents-room bu boşluğu, MCP Streamable HTTP üzerinden merkezi bir oda sunucusu olarak doldurabilir.

## 2. Çözümlerin İncelenmesi

### 2.1 Koordinasyon katmanları (en yakın akrabalar)

**mcp_agent_mail (Dicklesworthstone)** — Kodlama ajanları için "e-posta benzeri" koordinasyon MCP sunucusu. Python sürümü yaklaşık 1,9k yıldız; 40 araç ve 25 kaynak (resource) sunan bir Rust yeniden yazımı da var (`mcp_agent_mail_rust`, lisans "MIT + Rider").
- *Mimari:* FastMCP tabanlı ve yalnızca HTTP üzerinden çalışan bir sunucu (varsayılan port 8765). Git deposu insan tarafından denetlenebilir arşivi tutar (mesajlar `messages/YYYY/MM/<id>.md`, profiller, rezervasyonlar); SQLite + FTS5 ise indeksleme, arama ve çakışma tespiti için kullanılır. Yazma sırası önce veritabanı, sonra Git commit şeklindedir; `.archive.lock` ve `.commit.lock` ile serileştirilir.
- *İletişim:* Ajanlara "GreenCastle" gibi hatırlanabilir kimlikler verilir. Thread tabanlı inbox/outbox, CC/BCC, önem derecesi ve "ack gerekli" bayrağı vardır. `contact_policy` (open/request/closed) ve projeler arası iletişim için onaylı `request_contact` akışı bulunur.
- *Çakışma:* **Tavsiye niteliğinde dosya rezervasyonları (advisory lease).** Glob desenleriyle, TTL'li, exclusive ya da shared olabilir. Çakışma olduğunda rezervasyon yine verilir ama çakışma raporlanır. Opsiyonel **pre-commit guard**, başkasının exclusive rezervasyonunu ihlal eden commit'i engeller. Yollar repo köküne görelidir.
- *Makineler arası:* HTTP ve Bearer/JWT (JWKS) sayesinde mümkün, ancak tasarım "tek sunucu, çok proje" odaklı.
- *Ek özellikler:* `/mail` web arayüzü, insan "Overseer" mesajları, Beads ile ortak kimlik (`bd-123`) kullanan entegrasyon.
- *Alınacaklar:* Lease modeli (TTL + exclusive/shared + renew/release), pre-commit guard, Git + SQLite ikili depolama, ajan profilinde `program`/`model` alanları, insan gözetmen kanalı.

**Beads (steveyegge/beads, MIT)** — Ajanlar için Git üzerinde tutulan, bağımlılık grafiğine dayalı bir issue tracker. Kayıtlar `.beads/` altında JSONL olarak durur; hash tabanlı ID'ler (`bd-a1b2`) çok dallı çalışmada birleştirme çakışmasını önler. `ready` komutu yalnızca engeli kalmamış işleri listeler. *Alınacaklar:* çakışmaya dayanıklı ID'ler, "ready work" sorgusu, bağımlılık grafiği.

**Agent-MCP (rinadelph, AGPL-3.0, ~1,3k yıldız)** — HTTP/WebSocket MCP sunucusu (`localhost:8000/mcp`). Bir admin ajan görevleri parçalayıp worker ajanlara dağıtır. Admin ve worker için ayrı token'larla rol bazlı yetkilendirme yapılır. Kalıcı bir bilgi grafiği (RAG) proje bağlamını tutar. Dosya düzeyinde kilitleme vardır: 600 saniye zaman aşımı, bekleyenler kuyruğa alınır. Gerçek zamanlı bir dashboard da sunar. *Alınacaklar:* admin/worker token ayrımı, kilitte zaman aşımı, "atomik görev = Adım 1→N" kuralı, kısa ömürlü odaklı ajanlar. *Dikkat:* AGPL lisansı nedeniyle kodu kopyalanmamalı, yalnızca fikirleri alınmalı.

**"Chat room" MCP sunucuları** (chat-mcp, mcp-comms, ClaudeChat, agent-chat-mcp, RogerRat) — Kanal/oda, doğrudan mesaj, yayın (broadcast) ve oturum keşfi sunan küçük projeler. mcp-comms, Claude Code ve Codex'i ortak bir SQLite mesaj günlüğü üzerinden konuşturur; RogerRat MCP ile birlikte REST de sunar. Çoğu deneysel ve tek geliştiricili. *Alınacaklar:* kanal + DM + broadcast üçlüsü, "session discovery" (kim çevrimiçi?).

**Ruflo (eski adıyla claude-flow, MIT, ~55k yıldız)** — Claude Code için bir "meta-harness": 300'den fazla MCP aracı; mesh/hierarchical/ring/star topolojileri; Raft/Gossip/CRDT gibi konsensüs seçenekleri; AgentDB (SQLite + HNSW vektör bellek); mTLS + ed25519 ile makineler arası federasyon. *Dikkat:* Bağımsız incelemeler, sürü (swarm) çalıştırmasının büyük kısmının henüz uçtan uca bağlanmadığını belirtiyor (ajan başlatma yalnızca JSON yazıyor, hive-mind tek süreçte çalışıyor). *Alınacaklar:* federasyon güvenlik modeli (mTLS, imzalı mesaj), hook tabanlı bağlam yakalama. *Alınmaması gereken:* aşırı araç yüzeyi ve konsensüs protokolleri. Kod ajanları için Git zaten tek doğruluk kaynağıdır.

### 2.2 Yerel paralel çalıştırıcılar

**Claude Code Agent Teams (deneysel)** — Bir lead oturumu ve teammate'lerden oluşur. Ortak görev listesinde durumlar pending/in progress/completed şeklindedir. Görevler arasında bağımlılık tanımlanabilir; bağımlılıklar tamamlanınca bekleyen görev otomatik açılır. **Görev sahiplenme (claim) yarışını dosya kilidiyle çözer.** Mailbox, her ajan için `~/.claude/teams/{team}/inboxes/{agent}.json` dosyasıdır. `TaskCreated`, `TaskCompleted` ve `TeammateIdle` hook'ları, exit code 2 ile görevi reddedip geri bildirim döndürebilen kalite kapılarıdır. Kısıtları: tek makine, oturum başına tek takım, iç içe takım yok, lead devredilemez. Resmî tavsiye: *"her teammate farklı dosya kümesine sahip olsun"*, 3-5 teammate, teammate başına 5-6 görev. Ajanlar arası mesajlar kullanıcı onayı yerine geçmez. *Alınacaklar:* görev durum makinesi, bağımlılık ile otomatik unblock, tamamlanma kapısı (hook), idle bildiriminin nihai cevabı taşıması, "ajan mesajı ≠ kullanıcı onayı" güvenlik ilkesi.

**claude-squad (AGPL-3.0, ~8,6k yıldız)** — tmux ve git worktree kullanan bir TUI. Claude Code, Codex, Gemini ve Aider'ı destekler. Her oturum ayrı branch'te çalışır, değişiklik kümesi uygulanmadan önce incelenir. **uzi (devflowinc, MIT)** — Her ajan için `~/.local/share/uzi/worktrees/` altında bir worktree açar. Branch adı `{agent}-{proje}-{hash}-{timestamp}`, tmux oturumu `agent-{proje}-{hash}-{agent}` biçimindedir. 3000-4000 aralığından otomatik port ataması yapar, durumu `state.json` içinde tutar. `uzi checkpoint` ile ajanın commit'lerini mevcut branch'e rebase eder. *Alınacaklar:* deterministik branch/oturum isimlendirme, port ataması, checkpoint = rebase.

**Conductor (Melty Labs, kapalı kaynak, ücretsiz macOS uygulaması + Conductor Cloud)** — Claude Code ve Codex'i izole worktree'lerde çalıştırır. Akış üç adımdır: repo ekle, ajanları dağıt, diff'leri gözden geçirip birleştir. *Alınacaklar:* "tüm aktif thread'leri tek ekranda gör; diff, test ve hata durumunu yan yana göster" UI deseni.

**vibe-kanban (BloopAI, Apache-2.0, ~28k yıldız)** — Rust backend ve TypeScript frontend'den oluşan bir kanban panosu. Her görev bir worktree'de çalışır. Kendi MCP sunucusunu açarak ajanların görev oluşturmasına ve güncellemesine izin verir. Diff inceleme, inline yorum ve AI ile yazılmış PR açıklaması sunar. 10'dan fazla ajan CLI'ını destekler. Bloop Nisan 2026'da kapandı; proje topluluk tarafından sürdürülüyor ("sunsetting"). *Alınacaklar:* kanban durumlarının worktree yaşam döngüsüne bağlanması, "görev = workspace = branch = PR" eşlemesi, MCP üzerinden görev CRUD. Apache-2.0 lisansı UI desenlerinin incelenmesine uygun.

**container-use (Dagger, Apache-2.0, deneysel)** — Her ajana **yeni bir container ve kendi git branch'ini** veren bir MCP sunucusu. İnceleme `git checkout <branch>` ile yapılır; komut geçmişi ve loglar saklanır. *Alınacaklar:* worktree'den bir adım ileri izolasyon (bağımlılık, port ve servis çakışmalarını da önler). Özellikle build ve test çalıştıran ajanlar için opsiyonel bir "sandbox runtime" modu olarak düşünülebilir.

### 2.3 Çerçeveler ve protokoller

| Çözüm | İletişim modeli | Orkestrasyon kalıbı | agents-room için dersi |
|---|---|---|---|
| **AutoGen → AG2 / Microsoft Agent Framework** (AutoGen Ekim 2025'ten beri bakım modunda; MAF Nisan 2026'da GA) | Paylaşılan konuşma (GroupChat) | Konuşmacı seçici (LLM, round-robin, özel) | Odada "sıradaki konuşmacı" politikası; ama serbest sohbet yerine yapılandırılmış mesaj tercih edilmeli |
| **CrewAI** | Rol bazlı ekip; Crews + Flows | Hierarchical process: manager LLM görev dağıtıp sonucu doğrular | "Manager doğrular" adımı, yani orkestratör review'u |
| **LangGraph** | Paylaşılan graf durumu + checkpointer | Supervisor, `interrupt()` ile human-in-the-loop, `thread_id` ile devam | Kalıcı checkpoint; orkestratör planının çökme sonrası devam ettirilebilmesi |
| **OpenAI Agents SDK** | Handoff (`transfer_to_<agent>`) ve agents-as-tools | Manager ya da devir | Codex, `codex mcp-server` ile `codex()`/`codex-reply()` araçlarını sunar; orkestratör Codex'i MCP üzerinden alt ajan olarak sürebilir |
| **MetaGPT** | **Paylaşılan mesaj havuzu + publish/subscribe**, yapılandırılmış dokümanlar | SOP (PRD → tasarım → görev → kod → QA) | Rol bazlı abonelik; mesajların serbest metin değil şema bazlı olması |
| **ChatDev** | İkili diyalog, "chat chain" | Aşamalı waterfall | Aşama başına iki rol (yazar + gözden geçiren) |
| **CAMEL** | Rol oynama, inception prompting; Workforce | Görev ayrıştırma + worker havuzu | Rol tanımlarının açık "sözleşme" olarak yazılması |
| **Swarms (Apache-2.0)** | Çok sayıda kompozit desen | SwarmRouter: sequential/concurrent/hierarchical/graph | Tek arayüzde birden fazla dağıtım stratejisi |
| **OpenHands (MIT)** | Agent-server; HTTP/WebSocket üzerinden RemoteConversation | Alt ajan delegasyonu; Docker/K8s/Remote runtime | Uzak runtime soyutlaması ve olay akışı (event stream) |
| **Letta** | **Paylaşılan memory block** (aynı `block_id`) + ajanlar arası mesaj araçları | Delegation / parallelization / synthesis | Odaya bağlı "paylaşılan not/bağlam bloğu" (proje kararları, kurallar) |
| **Google A2A (Linux Foundation, v1.0)** | JSON-RPC 2.0 / gRPC / HTTP+JSON; imzalı Agent Card (`/.well-known/agent-card.json`) | Görev yaşam döngüsü: submitted → working → input-required → completed/failed/canceled/rejected | Görev durum adları ve Agent Card (yetenek beyanı) formatı doğrudan benimsenebilir; ileride bir A2A köprüsü eklenebilir |
| **Hermes Agent (Nous Research, açık kaynak)** | v0.21 "Pantheon" (31 Ağustos 2026): Bots Mode, grup sohbetleri, gateway'ler arası `hermes peer` mesajlaşma; `delegate_task`, canlı subagent yönetimi | Varsayılan olarak 10 eşzamanlı alt ajan, JSON şema ile yanıt doğrulama | Hermes stdio ve uzak HTTP MCP sunucularını (OAuth 2.1 dahil) birinci sınıf destekliyor, yani agents-room'a doğrudan bağlanabilir. "Mesajlar kanonik sohbette kalıcı" ilkesi agents-room odasıyla örtüşüyor |

**MCP'nin kendisi:** 2025-11-25 revizyonunda deneysel olarak gelen **Tasks** primitifi artık `io.modelcontextprotocol/tasks` uzantısı olarak tanımlı. Sunucu uzun süren bir işte (örneğin bir alt görev) bir `taskId` döndürür; istemci `tasks/get` ile sorgular, `input_required` durumunda `tasks/update` ile girdi verir, `tasks/cancel` ile iptal eder. İsteğe bağlı olarak `notifications/tasks` ile bildirim de alınabilir. İstemci desteği farklılık gösterdiği için agents-room bu uzantıyı **opsiyonel** kullanmalı; asıl kalıcı durum kendi görev panosunda tutulmalı.

## 3. Çıkarımlar: Neyi, Neden Alıyoruz

1. **Çakışmayı önlemenin birincil yolu izolasyon, ikincil yolu tavsiye niteliğinde kilittir.** Yerel araçların tümü worktree/branch izolasyonuna, koordinasyon katmanları ise dosya kiralamasına yaslanıyor. İkisi birlikte kullanılmalı: worktree fiziksel üzerine yazmayı engeller, lease ise "aynı dosyayı iki kişi değiştirip merge'de çakışma yaşama" riskini planlama aşamasında görünür kılar.
2. **Sahiplenme (claim) atomik ve süreli olmalı.** Claude Code'daki dosya kilidi ve Agent-MCP'deki 600 saniyelik timeout gösteriyor ki süresiz kilitler, çöken ajanlarda kilitlenmeye yol açar.
3. **Mesajlar yapılandırılmış olmalı.** MetaGPT'nin SOP dokümanları, A2A'nın görev durumları ve Hermes'in JSON şema doğrulaması bu yönde. Serbest sohbet insan için; makine için tipli olaylar gerekli.
4. **Git tek doğruluk kaynağıdır.** Beads ve mcp_agent_mail'in Git'te tutulan arşivleri bunu gösteriyor. Koda dair her şey branch/PR'da, koordinasyon durumu ise sunucuda (SQLite/Postgres) tutulmalı.
5. **İnsan gözetmen birinci sınıf katılımcı olmalı.** mcp_agent_mail'deki Overseer, Conductor ve vibe-kanban'daki review ekranları, Claude Code'daki plan onayı bunun örnekleri.
6. **Ajan mesajı yetki devri değildir.** Claude Code'un güvenlik ilkesi agents-room'a da taşınmalı: bir ajanın mesajı başka bir ajanın izin kapısını açamaz.

## 4. agents-room Referans Mimarisi

### 4.1 Bileşenler

```
 [Claude Code]   [Codex CLI]   [Hermes Agent]   [İnsan / Web UI]
      \              |              /                 |
       \--- MCP Streamable HTTP ---/             HTTPS + SSE/WebSocket
                     |                                |
            +--------------------------------------------------+
            |  1. MCP Gateway  (auth, oturum, araç yönlendirme)  |
            +--------------------------------------------------+
            | 2. Oda / Mesaj Veriyolu | 3. Görev Panosu (claim/lease) |
            | 4. Dosya Rezervasyonu   | 5. Presence / Heartbeat       |
            | 6. Artefakt Deposu      | 7. Olay Günlüğü (event log)   |
            +--------------------------------------------------+
            |  Kalıcı katman: Postgres/SQLite + nesne deposu      |
            +--------------------------------------------------+
                     |                         |
               GitHub (repo, branch, PR,    8. İzleme UI
               checks, webhooks)            (oda, pano, lease haritası)
```

1. **MCP Gateway:** Streamable HTTP uç noktası. Oturum başına `Mcp-Session-Id` ile ajan kimliğini eşler. Araçları (tools) ve kaynakları (resources) sunar: `inbox://{agent}`, `task://{id}`, `room://{id}/transcript`. Tasks uzantısını destekleyen istemcilere uzun işleri task handle olarak döndürebilir, desteklemeyenlere polling veya uzun-anket (long-poll) tabanlı `wait_for_events` aracını sunar.
2. **Oda / Mesaj Veriyolu:** Oda = toplantı. Kanal mesajları, doğrudan mesaj (DM), broadcast, thread ve `ack_required` desteği. Mesajlar tiplidir: `chat`, `plan`, `assignment`, `status`, `question`, `result`, `review`, `decision`. MetaGPT'deki gibi rol ve etiket bazlı abonelik olur; ajan yalnızca ilgili mesajları çeker ve bağlam penceresi korunur.
3. **Görev Panosu:** A2A ile uyumlu durumlar kullanılır: `pending → claimed → working → input_required → review → completed | failed | canceled`. Bağımlılık grafiği ve "ready" sorgusu Beads'ten, çakışmaya dayanıklı kısa hash ID'ler de Beads'ten alınır. Her görevde kabul kriteri, dokunulması beklenen dosya globları, branch adı ve PR bağlantısı bulunur.
4. **Dosya Rezervasyonu (lease):** Glob tabanlı, `exclusive|shared`, TTL'li, yenilenebilir ve serbest bırakılabilir. Tavsiye niteliğindedir; ihlal edilirse uyarı verilir. Her repoya kurulabilen opsiyonel bir pre-commit/pre-push guard ve GitHub check'i ile "yumuşak zorlama" sağlanır.
5. **Presence / Heartbeat:** Ajan kaydında `program`, `model`, `machine`, `capabilities` (A2A Agent Card benzeri), `max_parallel` ve `status` alanları tutulur. Heartbeat kaçarsa ajan önce "stale", sonra "offline" olur; görev ve dosya lease'leri süresi dolunca otomatik geri alınır ve görev yeniden kuyruğa girer.
6. **Artefakt Deposu:** Planlar, loglar, test çıktıları, ekran görüntüleri ve özet raporlar içerik adresli (SHA) olarak saklanır ve mesajlarda referans verilir. Kod asla burada durmaz; kod her zaman Git'tedir.
7. **Olay Günlüğü:** Tüm durum değişiklikleri append-only olarak kaydedilir. Bu hem denetim (audit) hem de LangGraph tarzı kaldığı yerden devam için kullanılır; orkestratör çökse bile plan ve durum geri yüklenebilir.
8. **İzleme UI:** Oda transkripti, kanban panosu, ajan listesi (çevrimiçi/meşgul/stale), aktif lease haritası (hangi dosyalar kimde), PR ve CI durumu. İnsan gözetmen buradan mesaj gönderebilir, görevi yeniden atayabilir, lease'i zorla kaldırabilir ve onay verebilir.
9. **Auth:** Önerilen yapı, OAuth 2.1 veya oda başına davet token'ı ile rol bazlı yetkilendirmedir: `orchestrator`, `worker`, `observer`, `human-admin` (Agent-MCP'deki admin/worker ayrımı gibi). GitHub erişimi ajanın kendi makinesindeki kimlik bilgisiyle yapılmalı; sunucu repo yazma yetkisini merkezde toplamamalıdır. Ajan mesajları hiçbir zaman izin veya onay yerine geçmez.

### 4.2 Temel Kalıplar

- **Claim-with-lease:** `claim_task(task_id)` atomik bir karşılaştır-ve-değiştir (compare-and-set) işlemidir: yalnızca `pending` durumundaki ve bağımlılıkları çözülmüş görevler için başarılı olur. Sonuç olarak `lease_expires_at` döner (örneğin 15 dakika). Ajan `renew` ile uzatır, heartbeat ile canlılığını gösterir. Süre dolarsa görev `pending` durumuna döner ve olay günlüğüne "lease expired" yazılır. Aynı görevi aynı anda iki ajan alamaz.
- **Tavsiye niteliğinde dosya rezervasyonları:** Orkestratör, plan aşamasında her alt göreve beklenen dosya globlarını atar. Worker, işe başlarken `reserve_files(globs, exclusive, ttl)` çağırır. Çakışma olursa sunucu reddetmez ama çakışmayı raporlar; ajan ya işi daraltır ya da ilgili ajana DM atar. Guard, commit ya da PR aşamasında kontrol eder.
- **Ajan başına worktree:** Her worker kendi makinesinde görev başına bir `git worktree` açar (uzi, Conductor ve claude-squad'da olduğu gibi). Build ve test ağır olan işlerde opsiyonel olarak container-use benzeri container izolasyonu kullanılabilir. Port çakışmasını önlemek için makine başına port aralığı atanır.
- **Branch isimlendirme:** `ar/<room-id>/<task-id>-<kısa-slug>` (örnek: `ar/r42/t-7f3a-auth-refresh`). Ajan adı branch'e değil commit trailer'ına yazılır (`Agent: codex@host-b`, `Task: t-7f3a`), böylece görev yeniden atandığında branch aynı kalabilir. Beads'teki gibi kısa hash ID'ler kullanılır.
- **Her alt görev için bir PR:** Her alt görev entegrasyon branch'ine (`ar/<room-id>/integration`) ya da doğrudan `main`'e küçük bir PR olarak açılır. PR açıklamasında görev ID'si, kabul kriteri ve test sonucu bulunur. GitHub webhook'u ile PR ve CI durumu görev durumuna yansıtılır (`review`, `completed`).
- **Orkestratör döngüsü (plan → dispatch → collect → review):**
  1. *Plan:* Orkestratör hedefi alt görevlere ayırır. Her alt görev için kabul kriteri, dosya globları, bağımlılıklar ve tahmini boyut belirlenir. Plan tipli bir `plan` mesajı olarak odaya yazılır; isteğe bağlı olarak insan onayı (`input_required`) beklenir.
  2. *Dispatch:* Ready görevler ya yetenek eşleşmesiyle (Agent Card) atanır ya da self-claim'e açılır. Worker başına 1-2 aktif görev, toplamda 3-5 worker hedeflenir (Claude Code tavsiyesi). Birbiriyle kesişen dosya globlarına sahip görevler seri hâle getirilir.
  3. *Collect:* Worker'lar `status` ve `result` mesajları gönderir. Result içinde PR URL'si, özet, test çıktısı artefaktı ve açık sorular yer alır. Takılan veya stale görevler yeniden atanır.
  4. *Review:* Orkestratör (ya da ayrı bir reviewer ajan) PR'ı kabul kriterine göre değerlendirir (CrewAI'deki "manager doğrular" ve ChatDev'deki yazar/gözden geçiren çifti). Sonuç ya merge ya da düzeltme görevi olur. `TaskCompleted` benzeri bir kalite kapısı uygulanır: CI yeşil değilse görev `completed` olamaz. Döngü tüm görevler kapanana kadar devam eder, sonunda entegrasyon PR'ı açılır.
- **İdempotent ve yeniden başlatılabilir işlemler:** Tüm araçlar `client_request_id` kabul eder. Orkestratör durumu olay günlüğünden yeniden oluşturulabilir.
- **Paylaşılan bağlam bloğu:** Oda başına "proje kuralları / kararlar" bloğu tutulur (Letta'daki shared memory block gibi). Her ajan katıldığında bunu okur, değişiklikler de `decision` mesajıyla yapılır.

### 4.3 Kapsam Dışı Bırakılması Önerilenler

Konsensüs protokolleri (Raft/Byzantine), vektör bellek ve yüzlerce araçlık yüzey (Ruflo) ilk sürümde gereksiz. Git ve merkezi sunucu zaten sıralama ve doğruluk garantisi veriyor. Ajan başına 10-15 araçla sınırlı, iyi tanımlı bir araç seti hem bağlam maliyetini hem de hata oranını düşürür.

## 5. Kaynaklar

- mcp_agent_mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- mcp_agent_mail (Rust): https://github.com/Dicklesworthstone/mcp_agent_mail_rust
- Beads: https://github.com/steveyegge/beads · https://www.mintlify.com/steveyegge/beads/introduction
- Agent-MCP: https://github.com/rinadelph/Agent-MCP
- Ruflo (claude-flow): https://alphasignalai.substack.com/p/how-ruflo-turns-claude-code-into · https://www.augmentcode.com/learn/ruflo-claude-code-multi-agent-orchestration · https://codex.danielvaughan.com/2026/04/09/claude-multi-agent-ecosystem/
- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams · Worktrees: https://code.claude.com/docs/en/worktrees
- claude-squad: https://github.com/smtg-ai/claude-squad
- uzi: https://mintlify.wiki/devflowinc/uzi/concepts/architecture · https://pkg.go.dev/github.com/devflowinc/uzi@v0.0.2
- Conductor: https://www.conductor.build/workflows · https://www.morphllm.com/conductor-ai-coding
- vibe-kanban: https://github.com/BloopAI/vibe-kanban · https://virtuslab.com/blog/ai/vibe-kanban/
- container-use: https://github.com/dagger/container-use
- Chat-room MCP sunucuları: https://glama.ai/mcp/servers/thiagovictorino/chat-mcp · https://glama.ai/mcp/servers/ahmeda14960/mcp-comms · https://glama.ai/mcp/servers/zzibo/claudechat · https://libraries.io/pypi/agent-chat-mcp
- AutoGen / AG2 / Microsoft Agent Framework: https://atlan.com/know/ai-agent/what-is-autogen/ · https://futureagi.com/blog/what-is-autogen-2026/
- CrewAI hierarchical process: https://docs.crewai.com/en/learn/hierarchical-process
- LangGraph interrupts / HITL: https://docs.langchain.com/oss/python/langgraph/human-in-the-loop
- OpenAI Agents SDK: https://towardsdatascience.com/build-multi-agent-apps-with-openais-agent-sdk/ · Codex + Agents SDK: https://developers.openai.com/codex/guides/agents-sdk · https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
- MetaGPT: https://arxiv.org/html/2308.00352v7
- CAMEL: https://langchain-cn.readthedocs.io/en/latest/use_cases/agents/camel_role_playing.html
- Swarms: https://docs.swarms.world/api/swarm-router
- OpenHands: https://docs.openhands.dev/sdk/arch/conversation.md · https://arxiv.org/html/2407.16741v3
- Letta shared memory / multi-agent: https://docs.letta.com/guides/agents/multi-agent · https://docs.letta.com/guides/agents/shared-memory-blocks
- A2A: https://you.com/resources/a2a-protocol-explained-what-agent-to-agent-communication-solves · https://atlan.com/know/mcp/a2a-protocol-implementation-guide/
- Hermes Agent: https://hermes-agent.nousresearch.com/docs · https://runtimewire.com/article/nous-research-hermes-agent-pantheon-bot-mode · https://aiweekly.co/alerts/nous-research-ships-hermes-agent-v021-pantheon-with-bots-mode-agent-to-agent
- MCP Tasks: https://modelcontextprotocol.io/specification/2026-07-28/basic/utilities/tasks · https://github.com/modelcontextprotocol/ext-tasks · https://workos.com/blog/mcp-async-tasks-ai-agent-workflows
