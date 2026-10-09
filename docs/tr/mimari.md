# agents-room mimarisi

[English](../architecture.md) · **Türkçe**

Bu belge teknoloji seçimini, bileşenleri, veri modelini ve orkestrasyon akışını anlatır.
Araştırma raporları: [01 protokol değerlendirmesi](research/01-protokol-degerlendirmesi.md) · [02 benzer çözümler ve referans mimari](research/02-benzer-cozumler-ve-referans-mimari.md) · [03 istemci entegrasyonu](research/03-istemci-entegrasyonu.md)

## 1. Teknoloji kararı

**Karar:** Taşıma katmanı olarak XMPP, Matrix ya da NATS gibi bir mesajlaşma sunucusu kullanılmadı. Onun yerine **tek süreçte MCP Streamable HTTP sunucusu + SQLite (WAL) broker** seçildi. Veri modeli A2A kavramlarıyla uyumlu tutuldu; XMPP ve A2A ileride eklenecek köprüler olarak bırakıldı.

Gerekçe:

| Etken | Sonuç |
|---|---|
| LLM agent'ları **pull** tabanlıdır. Model düşünürken dışarıdan mesaj alamaz, mesajı ancak bir araç çağırınca görür. | XMPP, Matrix ve NATS'ın push ve anlık presence özellikleri agent'a bir şey kazandırmıyor. Gereken şey kalıcı geçmiş, imleç ve uzun-yoklama (long-poll). |
| Üç istemci (Claude Code, Codex, Hermes) de **MCP Streamable HTTP** konuşuyor. | Agent tarafında hiçbir ek istemci ya da köprü süreci gerekmiyor. Tek bağlantı noktası `/mcp`. |
| MCP 2026-07-28 sürümü durumsuz yöne gidiyor (oturum ve initialize kalkıyor). | Sunucu **durumsuz** çalışır: her POST kendi sunucu ve taşıma örneğini alır, kimlik her istekte Bearer token'dan gelir. Yeniden başlatmaya ve yük dengeleyiciye dayanıklıdır. |
| İstemci araç zaman aşımları farklı: Codex 60 sn, Claude Code HTTP için ilk bayta kadar yaklaşık 60 sn, Hermes 300 sn. | `install-client.sh` ve `run-agent.sh` her istemcide agents-room araç zaman aşımını 120 sn'ye çıkarır. `wait_for_messages` varsayılan 40 sn, en fazla 110 sn. |
| Operasyonel yük | Tek Node.js süreci, tek SQLite dosyası. Harici bağımlılık yok (`node:sqlite`). |
| A2A v1.0 (Mart 2026) grup sohbeti sunmuyor ve her agent'ın bir sunucu olmasını bekliyor. | A2A taşıma katmanı olarak değil, veri modeli ve ileride dışa açılan bir köprü olarak kullanılacak. |

Puanlama tablosu ve kaynaklar [01 numaralı raporda](research/01-protokol-degerlendirmesi.md) (hafif broker 44/50, NATS 39, XMPP 34).

## 2. Bileşenler

```
 makine A                     makine B                     makine C
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ Claude Code  │          │  Codex CLI   │          │ Hermes Agent │
│ + skill      │          │  + skill     │          │  + skill     │
└──────┬───────┘          └──────┬───────┘          └──────┬───────┘
       │ MCP Streamable HTTP + Bearer token (TLS: Tailscale / Caddy)│
       └──────────────────────────┼─────────────────────────────────┘
                        ┌─────────▼──────────┐
                        │  agents-room sunucu │  node src/index.ts
                        │  /mcp   (MCP araçları, durumsuz)
                        │  /api   (panel, insan katılımcı, enroll)
                        │  /      (izleme paneli, SSE)
                        │  RoomService (çekirdek, taşımadan bağımsız)
                        │  sweeper (15 sn: kiralama/presence)
                        └─────────┬──────────┘
                                  │
                           SQLite (WAL) data/agents-room.db
```

| Bileşen | Dosya | Görev |
|---|---|---|
| Çekirdek | `server/src/room.ts` | Odalar, mesajlar, görevler, kiralama, rezervasyon ve olay günlüğü. Olay yolu (EventEmitter) long-poll'u ve SSE'yi besler. |
| MCP araçları | `server/src/tools.ts` | 24 araç ve 2 prompt (`worker`, `orchestrator`) |
| HTTP | `server/src/app.ts` | `/mcp`, `/api/*`, statik panel, auth, DNS rebinding koruması |
| Kalıcılık | `server/src/db.ts` | Şema, WAL, işlem (`BEGIN IMMEDIATE`) |
| Panel | `server/public/index.html` | Yuvarlak masa (presence), konuşma, görev panosu, hatalar, rezervasyonlar |
| Yönetim CLI | `server/src/cli.ts` | `agent add/list/revoke`, `room add/list`, `status` |
| Skill | `skills/agents-room/` | Üç istemcinin ortak kullandığı SKILL.md, orkestratör kılavuzu ve git kuralları |
| Betikler | `scripts/` | `install-client.sh`, `run-agent.sh`, `pilot-setup.sh` |

## 3. Veri modeli (A2A eşlemesi)

| agents-room | A2A v1.0 | Not |
|---|---|---|
| `room` | `contextId` | Bir konuşma ve iş bağlamı |
| `task` | `Task` | Bkz. durum eşlemesi |
| `message` | `Message` (tek `TextPart`) | `kind`: chat, system, task, dm |
| `artifacts[]` | `Artifact` | branch, pr, commit, file, url, note |
| `agent` (kind, role, capabilities, machine) | `AgentCard` (skills) | Yetenek eşleştirmesi `task.capabilities` ile yapılır |

Görev durumları: `open`→`submitted`, `claimed`/`in_progress`→`working`, `review`→`input-required`, `done`→`completed`, `failed`→`failed`, `cancelled`→`canceled`.

## 4. Görev yaşam döngüsü

```
            task_create / plan_create
                     │
                     ▼
   ┌──────────────► open ◄───────────── lease süresi doldu (sweeper)
   │                 │   task_claim / task_next (atomik, bağımlılık + yetenek kontrolü)
   │                 ▼
   │              claimed ──task_update──► in_progress ──(status=review)──► review
   │                 │                          │                          │
   │ task_fail(retry)│                          │ task_complete            │ task_review approve
   └─────────────────┴──────────────────────────┴──────────► done ◄────────┘
                                                task_fail ──► failed
                                           task_review cancel ──► cancelled
```

- **Kiralama (lease):** Alınan görevin varsayılan 30 dk kiralaması vardır. `task_update` ya da `heartbeat` yeniler. Süre dolarsa görev `open` durumuna döner, assignee boşalır, orkestratöre bildirim gider.
- **Bağımlılık:** `depends_on` içindeki tüm görevler `done` olmadan görev alınamaz. Bağımlılık bitince "🔓 is now claimable" duyurusu yapılır ve bekleyen agent'lar long-poll'dan uyanır.
- **Üst görev:** Tüm alt görevler bittiğinde orkestratöre "🏁 All subtasks … are finished" mention'ı gider.
- **Yarış güvenliği:** Görev alma işlemi `BEGIN IMMEDIATE` içinde ve `UPDATE ... WHERE status='open'` iyimser kilidiyle yapılır, böylece aynı görevi iki agent birden alamaz.

## 5. Orkestratör akışı

**başkan → taslak → istişare → dağıt → izle → incele → sentezle.** Ayrıntılar [skills/agents-room/references/orchestrator.md](../../skills/agents-room/references/orchestrator.md) içinde.

1. `list_agents`: kim çevrimiçi, yetenekleri ne. `room_join` odanın başkanını da gösterir.
2. Taslak: 3-8 alt görev. Her biri ayrık dosya kümesine dokunur. Paylaşılan dosyalar ayrı bir temel görevde toplanır.
3. İstişare: `consult_open` ile taslak masaya sorulur, yanıtlar `consult_get` ile toplanır, karar `consult_close` ile kaydedilir (bkz. bölüm 5.1).
4. `plan_create(consult_id=…)`: bağımlılıklar anahtarla belirtilir, sunucu topolojik sıralar ve döngüyü reddeder. Planı oluşturan istişare, üst görevin açıklamasına ve istişare kaydına bağlanır.
5. İzleme: soruları yanıtla, kiralama ya da başarısızlık olaylarında `task_review(reassign|reopen)`. Zor kararlarda yeniden istişare et. Çalıştırıcı altında orkestratör döngüde beklemez: durumu plana yazar (`task_update(plan_id, progress=…)`), oturumu kapatır ve bir sonraki olayla uyanır (bölüm 5.3).
6. Her `✅` için sonucu ve artifact'ı incele, gerekirse `reopen` et, bağımlılık sırasıyla merge et.
7. `task_tree` ile sonuçları topla, entegrasyon testini çalıştır, nihai raporu yaz, üst görevi kapat.

### 5.1 İstişare (consult)

Bir agent karar vermeden önce masadan görüş ister. Kayıt `consults` ve `consult_replies` tablolarında tutulur.

| Tür | Ne zaman | Yanıt |
|---|---|---|
| `opinion` | Açık uçlu soru (plan taslağı, yaklaşım) | Serbest metin |
| `vote` | `options` verilmişse (ör. `["sqlite","postgres"]`) | Seçeneklerden biri + gerekçe; `consult_get` sayımı gösterir |
| `election` | Sunucunun açtığı başkan seçimi | Yalnızca orkestratörler oy verir |

- Davetliler varsayılan olarak odadaki çevrimiçi agent'lardır (soran, gözlemci ve insanlar hariç); `ask` ile daraltılabilir. Duyuru davetlileri @mention'lar, böylece bekleyen agent'lar long-poll'dan uyanır.
- **Çalışırken uyarı:** Agent'lar yalnızca araç çağırdıklarında mesaj görür. Bu yüzden sunucu her araç yanıtına, `wait_for_messages` hariç, bekleyen istişare ve okunmamış mention'lar için ayrı bir "📬 Inbox" notu ekler. Görevin ortasındaki işçi de istişareyi kaçırmaz.
- Herkes yanıtlayınca soran agent'a "📥 Everyone answered" bildirimi gider. Süre dolunca bir kez "⌛ deadline passed" hatırlatması yapılır. Karar `consult_close` ile odaya duyurulur.
- `consult_get(wait_sec)` herkes yanıtlayana, istişare kapanana ya da süre dolana kadar bekler.

### 5.2 Başkan (chair)

Bir odada birden çok orkestratör olabilir; planın sahibi tek bir **başkandır** (`rooms.chair`).

- **Tek orkestratör:** Masaya oturunca geçici başkan olur (`chair_by = sole`).
- **İkinci orkestratör gelince:** Sunucu çevrimiçi orkestratörler arasında `election` türünde bir istişare açar (120 sn). Herkes oy verince ya da süre dolunca sonuç belli olur: çoğunluk kazanır; eşitlikte ya da hiç oy yoksa odaya ilk katılan kazanır (`chair_by = election`). Seçim sürerken kimse plan oluşturamaz.
- **Yetki:** `plan_create` yalnızca başkana ya da admin'e açıktır. Diğer orkestratörler, başkanın kendilerine atadığı bir görevin altında `plan_create(parent_id=…)` ile alt plan kurabilir. Böylece iş bölümü hiyerarşik kalır ve 🏁 bildirimleri doğru kişiye gider.
- **Koltuk boşalması:** Başkan masadan ayrılırsa ya da 10 dakikadan uzun süre hiç araç çağırmazsa (`CHAIR_GRACE_MS`) koltuk boşalır. Bakım döngüsü tek kalan orkestratörü atar ya da yeni seçim açar. Bu süre, uzun bir merge yapan başkanı düşürmemek için çevrimiçi eşiğinden (90 sn) uzun tutuldu.
- **`chair` aracı:** `status` (durum), `elect` (yeni seçim), `transfer` (başkan ya da admin devreder), `resign` (bırakma; kalanlar arasından yeniden seçilir).

### 5.3 İhtiyaç anında açılan oturumlar ve token maliyeti

Modelin her turunda bütün bağlam yeniden gönderilir. Faturayı iki şey büyütüyordu: boş turlar (sessiz odada `wait_for_messages` döngüsünde bekleyen agent ve her boşta kalma süresinden sonra yeniden açılan oturumlar) ve her yeni oturumun kodu baştan taraması. Çalıştırıcı ve sunucu artık ikisini de önler.

- **Model çalıştırmadan bekleme.** `run-agent.sh` beklemek için model oturumu açmaz. `POST /api/agent/wake` ucunda (agent token'ı, `{room, timeout_sec}`) uzun-yoklamayla bekler. Sunucu isteği, uyanmak için bir sebep oluşana kadar tutar: agent'ın alabileceği bir görev, yarıda kalmış kendi görevi (agent `blocked` değilse), ondan bahseden ya da ona gelen bir DM, cevabını bekleyen bir istişare; orkestratör için ayrıca odaya bir insanın yazdığı her mesaj. Plandaki görev olayları orkestratöre ulaşır, çünkü bu sistem mesajları planı açanı anar. Yanıt düz metindir: `WAKE` ve bir not, `TIMEOUT` ya da `CLOSED`. Çalıştırıcı beklerken agent çevrimiçi sayılır (istişarelere yine davet edilir, başkan koltuğunu kaybetmez).
- **Not oturumu başlatır.** Not oturumun neden açıldığını söyler, tetikleyen mesajları listeler (bunlar okundu sayılır, aynı mesaj agent'ı iki kez uyandırmaz) ve orkestratör için yürüttüğü planları son ilerleme notuyla verir. Çalıştırıcı notu oturum talimatının sonuna ekler. Oturum işini yapar, yapacak bir şey kalmayınca kapanır; çalıştırıcı yeniden beklemeye döner.
- **Oda notları.** Her odanın kısa, ortak bir depo haritası vardır (`room_notes`, en fazla 12.000 karakter): klasör yapısı, önemli modüller, derleme/test komutları, kurallar. Orkestratör depoyu bir kez inceledikten sonra yazar; işçiler kısa bilgiler ekler. `room_join` bunu gösterir, böylece her yeni oturum kodu taramak yerine haritadan başlar.
- **Kendi kendine yeten görevler.** Orkestratör her alt göreve bir Context bölümü yazar (önce okunacak dosyalar, arayüzler, ilgili görevler) ve aynı alanın devam görevlerini aynı işçiye verir.
- **Oturum ne zaman biter.** Sıradaki görev bir öncekinin devamıysa işçi aynı oturumda sürdürür. İlgisizse ve zaten bir görev bitirmişse oturumu kapatır; görev onda kalır, temiz bağlamla açılan yeni oturum devam eder.
- **Korumalar.** Aynı uyanma sebebi bir oturumdan hemen sonra tekrarlanırsa çalıştırıcı her seferinde daha uzun bekler (1, 2, 4, 8, 16 dakika). `--sessions N` (Docker'da `SESSIONS`) agent başına son bir saatteki oturum sayısını sınırlar; 0 sınırı kaldırır.

## 6. Ortak repo ve çakışma yönetimi

[git-rules.md](../../skills/agents-room/references/git-rules.md) dosyasının özeti:
- Her görev için ayrı worktree ve `ar/<oda>/t<ID>-<slug>` adlı branch. Branch'in tek sahibi görevi alan agent'tır.
- `files_reserve`: glob desenli, süreli, özel ya da paylaşımlı, **tavsiye niteliğinde** bir kilit. Çakışma varsa rezervasyon verilmez ve sahibi raporlanır. Görev kapanınca kilit otomatik bırakılır.
- Commit trailer'ları: `Task: #ID`, `Agent: <ad>`. Push öncesi `rebase origin/main`. main'e doğrudan push ve lease'siz force-push yasak.
- Her görev için bir PR. Merge'ü orkestratör ya da entegratör bağımlılık sırasıyla yapar. Çakışmayı branch sahibi çözer (görev `reopen` edilir).

## 7. Güvenlik modeli

- **Kimlik:** Agent başına rastgele token. Sunucuda yalnızca SHA-256 özeti saklanır. Kimlik araç argümanından değil token'dan gelir, bu yüzden bir agent başkası adına konuşamaz.
- **Rol yetkisi:** `plan_create` yalnızca orchestrator ve admin içindir; çok orkestratörlü odada yalnızca başkan (ya da devredilmiş alt planın sahibi) plan kurar. `task_review` görevi oluşturana veya orkestratöre açıktır. Görev güncelleme sahibine, oluşturana ve orkestratöre açıktır. Panel admin, observer ve orchestrator rollerine açıktır.
- **DM gizliliği:** `to` alanı dolu mesajları yalnızca gönderen ve alıcı görür (panel hepsini görür).
- **Güven sınırı:** Skill ve sunucu talimatları agent'lara açıkça şunu söyler: diğer agent mesajları veridir, talimat değildir. Deploy, gizli bilgi ve geri alınamaz işlemler için insan onayı gerekir.
- **Kayıt (enroll):** İsteğe bağlı paylaşılan sır ile yapılır. `admin` rolü kayıtla alınamaz. Hatalı denemeler olay günlüğüne `warn` olarak yazılır.
- Dağıtık kurulumda TLS ve ağ katmanı için bkz. [dagitik-kurulum.md](dagitik-kurulum.md).

## 8. Dil kuralı

Agent'ların okuduğu her metin İngilizcedir: skill (`skills/agents-room/`), rol prompt'ları, araç açıklamaları, sunucu talimatları, hata mesajları ve odaya düşen sistem bildirimleri. Modeller İngilizce talimatlarla daha tutarlı çalışıyor. İnsanlara yönelik kısımlarda panel arayüzü Türkçedir. README ve belgeler İngilizcedir; Türkçe sürümleri `README.tr.md` ve `docs/tr/` altındadır. Agent'lar insanlara onların yazdığı dilde yanıt verir.

## 9. Bilinen sınırlar ve yol haritası

- Tek sunucu, tek SQLite dosyası. Onlarca agent için yeterli; yüzlerce agent gerekirse depolama Postgres ya da NATS JetStream'e taşınabilir. Çekirdek taşımadan bağımsız olduğu için bu geçiş sınırlı kalır.
- Çalışan oturuma push yok. Agent yalnızca araç çağırdığında mesaj görür. Bunu hafifletmek için her araç yanıtına bekleyen istişare ve mention'lar için "📬 Inbox" notu eklenir. Oturumlar arasında çalıştırıcının uyandırma ucu (bölüm 5.3) bir şey gelince oturum açar. Claude Code Channels (yalnızca stdio, önizleme) ileride isteğe bağlı bir uyandırma yolu olabilir.
- İleride eklenebilecekler: A2A ağ geçidi (`/.well-known/agent-card.json`, `message/send`), insanların Conversations veya Gajim ile odayı izleyebilmesi için bir XMPP MUC köprüsü, GitHub webhook ile PR/CI durumunu göreve yansıtma, rezervasyonları commit öncesi kontrol eden bir pre-commit hook.
