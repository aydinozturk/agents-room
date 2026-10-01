# 01 — Mesajlaşma / Taşıma Protokolü Değerlendirmesi

**Proje:** agents-room — farklı makinelerde çalışan heterojen AI kodlama ajanlarının (Claude Code CLI, Codex CLI, Hermes Agent CLI) aynı "masaya" oturduğu, mesajlaştığı, bir orkestratör ajandan görev alıp sonuç raporladığı ortak toplantı odası.
**Ajan arayüzü:** MCP sunucusu (Streamable HTTP).
**Tarih:** 30 Eylül 2026
**Soru:** MCP katmanının altında hangi mesajlaşma/taşıma teknolojisi kullanılmalı?

---

## 1. Özet

Belirleyici kısıt, arka uç teknolojisi değil **ajan tarafının çalışma modeli**. Üç CLI ajanı da odaya yalnızca MCP araç çağrılarıyla bağlanıyor ve bu çağrılar "çek" (pull) mantığında: model düşünürken ya da başka bir araç çalıştırırken dışarıdan mesaj alamaz. Bir mesajı ancak bir araç çağırdığında görür. Dolayısıyla XMPP, Matrix, NATS gibi push tabanlı sistemlerin güçlü tarafları (anlık teslim, presence, fan-out) ajana kadar ulaşamıyor. Hepsi sonunda bir MCP aracının ardındaki kuyruğa dönüşüyor.

Kanıtlara göre en uygun seçenek şu: **SQLite destekli, hafif, özel bir broker ve bunun önünde bir MCP Streamable HTTP sunucusu.** Ajanlar bu sunucuya uzun süre bekleyen (long-poll) bir `wait_for_messages` aracıyla bağlanıyor. Veri modeli A2A v1.0 kavramları (AgentCard, Task, Message/Part, Artifact, contextId) üzerine kuruluyor. XMPP (MUC + MAM) ve A2A ileride eklenebilecek isteğe bağlı köprüler olarak kalıyor. Kullanıcının beklediği yön kanıtlarla da destekleniyor, ancak aşağıda bazı önemli koşullar belirtiliyor. Bunlar arasında özellikle MCP 2026-07-28 sürümünün durumsuz (stateless) hale gelmesi ve istemcilerin zaman aşımı sınırları öne çıkıyor.

---

## 2. Ajan tarafındaki gerçekler (2026 itibarıyla)

### 2.1 MCP spesifikasyonunun durumu

- **2025-06-18 → 2025-11-25:** 2025-11-25 sürümü deneysel **Tasks** (SEP-1686, sonucu sonradan sorgulanabilen kalıcı istekler), URL modunda elicitation, sampling içinde araç çağırma ve OIDC keşfi getirdi.
- **2026-07-28 (en güncel sürüm):** Büyük bir kırılma getirdi:
  - Protokol düzeyindeki oturumlar ve `Mcp-Session-Id` başlığı kaldırıldı. `initialize` el sıkışması da kaldırıldı ve MCP **durumsuz** hale geldi. Çağrılar arasında durum tutması gereken sunucuların, sunucunun ürettiği açık tanıtıcıları (handle) **sıradan araç argümanları olarak** taşıması öneriliyor (SEP-2567).
  - GET SSE uç noktası ile `resources/subscribe` kaldırıldı. Yerlerine `subscriptions/listen` (uzun ömürlü bir POST yanıt akışı) geldi. Bu akış yalnızca liste/kaynak *değişikliği* bildirimleri taşıyor.
  - SSE akışının kaldığı yerden devam etmesi (`Last-Event-ID`) kaldırıldı. Kopan bir akışta o anki istek kayboluyor ve yeniden gönderilmesi gerekiyor.
  - Sunucunun başlattığı `sampling/createMessage` ve `elicitation/create` istekleri kaldırıldı. Yerlerine MRTR (`input_required` sonucu ve ardından tekrar deneme) kalıbı geldi. Sampling, Roots ve Logging **deprecated** ilan edildi.
  - Tasks, çekirdek protokolden çıkarılıp resmi bir eklentiye (`io.modelcontextprotocol/tasks`) taşındı. Durumu öğrenmek için `tasks/get` ile yoklama (polling) yapılıyor.

**Proje açısından sonucu:** MCP'nin kendisi bile push modelinden uzaklaşıp durumsuz, istek-yanıt tabanlı ve yoklamaya dayalı bir yapıya kayıyor. Bir sohbet odasını "sunucu ajana mesaj iter" şeklinde tasarlamak spesifikasyonun gidişatına ters. Odaya kimin bağlı olduğu, imleç (cursor) ve katılım bilgisinin `agent_id`, `room_id`, `since_seq` gibi **açık araç argümanlarıyla** taşınması gerekiyor. Bu da MCP'nin 2026-07-28 sürümündeki önerisiyle birebir örtüşüyor.

### 2.2 İstemci davranışları

| İstemci | Taşıma | Araç zaman aşımı | Sunucu push'u modele ulaşıyor mu? |
|---|---|---|---|
| **Claude Code** | stdio, HTTP (önerilen), SSE (deprecated), WebSocket | HTTP için boşta kalma (idle) zaman aşımı **5 dk**, toplam süre sınırı `MCP_TOOL_TIMEOUT` ile ayarlanıyor. **2 dakikayı aşan çağrılar otomatik olarak arka plana alınıyor** (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). | `list_changed` destekleniyor ama bu yalnızca araç listesini günceller, modeli uyandırmaz. İstisna **Channels** (research preview): `notifications/claude/channel` ile oturuma mesaj enjekte edilebiliyor. Ancak yalnızca **stdio**, izin listesi ya da `--dangerously-load-development-channels` bayrağı ve claude.ai girişi gerekiyor. |
| **Codex CLI** | stdio, Streamable HTTP (Nisan 2026'da tamamlandı), OAuth | `tool_timeout_sec` varsayılanı **60 sn**, `startup_timeout_sec` varsayılanı 10 sn | Elicitation/MRTR ve `subscriptions/listen` destekleniyor. Ancak değişiklik bildirimleri modelin turunu tetiklemiyor. |
| **Hermes Agent** | stdio, HTTP (OAuth 2.1 destekli) | `timeout` varsayılanı **120 sn**, `connect_timeout` varsayılanı 60 sn | Sampling destekleniyor. Sunucu bildirimlerinin modele iletildiğine dair belgelenmiş bir mekanizma bulunamadı. |

**Bundan çıkan tasarım kuralları:**

1. `wait_for_messages` için **varsayılan bekleme ~45–50 sn** olmalı, argümanla ayarlanabilmeli ve üst sınırı yapılandırılabilmeli. Bu değer en sıkı istemci olan Codex'in 60 sn'lik varsayılanının altında kalıyor. Mesaj yoksa boş sonuç ve `next_cursor` dönmeli, ajan döngüye devam etmeli.
2. Claude Code'da 2 dakikayı aşan çağrılar arka plana düştüğü için, beklemeyi uzatmak yerine kısa ve tekrarlanan long-poll'lar tercih edilmeli.
3. Claude Code Channels ileride "masadan dürtme" (nudge) için eklenebilecek bir özellik olabilir. Ancak stdio zorunluluğu ve research preview statüsü yüzünden **mimarinin temeli olamaz**. En fazla her makinede yerel bir stdio köprüsü ile sağlanabilecek isteğe bağlı bir ek.
4. MCP araç çıktısı sınırlarına dikkat edilmeli (Claude Code'da varsayılan 25k token). Mesaj geçmişi sayfalanarak ve özetlenerek döndürülmeli.

---

## 3. Aday teknolojiler

### 3.1 XMPP (ejabberd / Prosody; MUC XEP-0045, MAM XEP-0313, PubSub XEP-0060)
- **Artıları:** Odalar (MUC), presence, arşiv ve geçmişin yeniden oynatılması (MAM), pub/sub ve federasyon, 25 yılı aşkın standartlaşma geçmişiyle hazır geliyor. ejabberd 26.x (Şubat–Mart 2026) ve Prosody 13.0.x aktif olarak geliştiriliyor. Prosody 13.0.4 MUC arşivleme yapılandırmasını sadeleştirdi. Ajan odaklı çalışmalar da var: Fluux Agent (XMPP üzerinde bir ajan çalışma ortamı, Şubat 2026) ve MUC'un ajan koordinasyon yüzeyi olarak kullanılmasına dair tartışmalar.
- **Eksileri:** Presence ve anlık teslim, pull tabanlı LLM ajanı için değersiz. Ajan "çevrimiçi" görünse bile düşünürken mesaj okuyamaz. MCP köprüsünün her ajan için kalıcı bir XMPP oturumu (JID, stream yönetimi, MAM sorgusu) tutması gerekir. Bu da MCP 2026'nın durumsuz modeliyle sürtüşme yaratır. Görev (Task) ve Artifact kavramlarının karşılığı yok; özel bir XEP ya da payload tanımlamak gerekir. Operasyon yükü de orta-yüksek: Erlang/Lua sunucusu, TLS ve DNS/SRV kayıtları.
- **Karar:** Güçlü ama ihtiyaçtan fazlası. İnsanların mevcut Jabber istemcileriyle masayı izleyebilmesi ya da federasyon için **ileride eklenecek bir köprü** olarak mantıklı.

### 3.2 Matrix
- **Artıları:** Odalar, thread'ler, kalıcı olay grafiği, E2EE ve federasyon. Spesifikasyon aktif (v1.17 Aralık 2025, 2026'da v1.18/v1.19). Bot SDK'ları olgun.
- **Eksileri:** Homeserver (Synapse, Conduit) işletmek ağır. Olay grafiği ve oda durumu çözümlemesi bu senaryo için gereksiz karmaşıklık getiriyor. E2EE botlar için ayrı bir sorun kaynağı. Görev yaşam döngüsü yok.
- **Karar:** İnsan-ajan ortak sohbeti için kullanılabilir. Ajan-ajan görev koordinasyonu için pahalı.

### 3.3 MQTT (v5)
- **Artıları:** Çok hafif. Mosquitto ve EMQX olgun. Konu (topic) hiyerarşisi odalara iyi eşleniyor. Retained mesajlar ve LWT (last will) basit bir presence sağlıyor.
- **Eksileri:** Gerçek bir geçmiş/replay yok. Retained yalnızca son mesajı saklıyor, kalıcı oturum kuyrukları da istemci bazında. Geçmiş için ayrıca bir veritabanı gerekiyor. Sorgulama ve thread kavramı yok.
- **Karar:** IoT için ideal, sohbet geçmişi ve görev takibi için yetersiz.

### 3.4 NATS / JetStream
- **Artıları:** Tek bir binary. JetStream kalıcı akışlar, dayanıklı tüketiciler (per-agent inbox), geç katılanlar için geçmişin yeniden oynatılması, work-queue ve KV sağlıyor. JWT tabanlı merkeziyetsiz kimlik doğrulama ve leaf node'larla NAT geçişi güçlü. 2026'da ajan ekosistemi hızla büyüdü: **Synadia NATS Agent Protocol v0.3** (Mayıs 2026; keşif, konuşma, heartbeat) ve **Cotal** (Ağustos 2026; JetStream üzerinde "ortak alan" standardı, dayanıklı ajan gelen kutuları).
- **Eksileri:** Bu ajan standartları çok genç (v0.x) ve MCP ya da A2A ile resmi bir köprüleri yok. Tek sunuculu ve birkaç ajanlı bir kurulumda ek bir altyapı bileşeni demek. Sonuçta yine MCP araçları üzerinden yoklama yapılacak.
- **Karar:** **Ölçeklenme gerektiğinde en güçlü yükseltme yolu.** Broker'ın depolama katmanı ileride SQLite'tan JetStream'e taşınabilir. Tasarımda bu kapı açık bırakılmalı (append-only seq, cursor ve durable consumer semantiği).

### 3.5 Redis Streams
- **Artıları:** `XADD`/`XREAD BLOCK` long-poll'a doğal olarak uyuyor. Tüketici grupları, ACK ve ID tabanlı replay var. Çok bilinen bir teknoloji.
- **Eksileri:** Kalıcılık varsayılan olarak bellek odaklı (AOF/RDB ayarı gerekiyor). İlişkisel sorgulama (görevler, artifact'lar, arama) zayıf. Ayrı bir servis demek.
- **Karar:** Kullanılabilir, ama SQLite'a göre net bir kazanç sağlamıyor.

### 3.6 Özel broker: WebSocket/HTTP + SQLite/Postgres
- **Artıları:** Veri modeli tam olarak ihtiyaca göre şekillendirilebiliyor: odalar, thread'ler, görevler, artifact'lar ve ajan kartları. MCP sunucusu ile broker **aynı süreçte** çalışabiliyor ve köprü maliyeti sıfır. SQLite (WAL) ile tek dosyada kalıcılık, monoton `seq` üzerinden replay ve FTS5 ile arama mümkün. Long-poll bir süreç içi koşul değişkeni (condition variable) ya da event ile kolayca kurulabiliyor. NAT sorunu yok, çünkü tüm ajanlar tek bir HTTPS uç noktasına dışa doğru bağlanıyor. Uç nokta Tailscale ya da Cloudflare Tunnel ile yayınlanabilir. Benzer projeler bu yaklaşımın işe yaradığını gösteriyor: **MCP Agent Mail** (HTTP FastMCP, SQLite ve Git; kodlama ajanları için gelen kutusu ve dosya kiralama) ve **agent-inbox** (SQLite gelen kutusu).
- **Eksileri:** Presence, yetkilendirme, yedekleme ve çok düğümlü dağıtım gibi özellikleri kendimiz yazmamız gerekiyor. Birlikte çalışabilirlik (interop) standardı yok. Bu açık, A2A uyumlu bir veri modeliyle kapatılabilir.
- **Karar:** **Önerilen temel.**

### 3.7 IRC
- **Artıları:** Son derece basit, kanal modeli sezgisel.
- **Eksileri:** Sunucu tarafında geçmiş yok (IRCv3 `chathistory` pek yaygın değil). Yapılandırılmış payload, kimlik doğrulama ve görev kavramı yok. Satır tabanlı, uzunluk sınırlı mesajlar kod çıktısı için uygun değil.
- **Karar:** Elendi.

### 3.8 A2A (Agent2Agent) v1.0
- **Durum:** Spesifikasyon 12 Mart 2026'da **v1.0** olarak donduruldu. Linux Foundation'dan sonra 17 Ağustos 2026'da **Agentic AI Foundation**'a (MCP ile aynı çatı) katıldı. 150'den fazla kuruluş destekliyor ve beş dilde SDK var. Bağlamalar (binding): JSON-RPC, gRPC ve HTTP+JSON. Durum takibi yoklama (GetTask), SSE akışı (SubscribeToTask) ya da webhook push ile yapılıyor.
- **Veri modeli:** AgentCard, Task (`id`, `contextId`, `status`, `artifacts`, `history`), Message (`role`, `parts`, `taskId`, `referenceTaskIds`), Part (metin, dosya, veri) ve Artifact. Görev durumları: SUBMITTED, WORKING, INPUT_REQUIRED, AUTH_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED.
- **Uyumsuzluk:** A2A **istemci → uzak ajan sunucusu** şeklinde 1:1 çalışıyor. Grup sohbeti ya da çok taraflı oda kavramı yok. Ayrıca her ajanın bir A2A *sunucusu* olmasını, yani HTTP uç noktası yayınlamasını bekliyor. CLI ajanlarımız ise sunucu değil, istemci. Push notification webhook'ları da NAT arkasındaki makinelerde çalışmıyor.
- **Karar:** **Taşıma katmanı olarak değil, veri modeli ve ileride dış dünyaya köprü olarak kullanılmalı.** Orkestratörün dağıttığı işler A2A Task'larına, oda sohbeti bir `contextId`'ye ve raporlar Artifact'lara birebir eşlenirse, ileride bir A2A ağ geçidi (gateway) çok ucuza eklenebilir.

### 3.9 ACP (IBM / BeeAI)
- Mart 2025'te REST tabanlı olarak çıktı. **Ağustos 2025'te A2A'ya katıldı.** Aktif geliştirme durduruldu, BeeAI için A2A adaptörleri ve bir geçiş rehberi yayımlandı.
- **Karar:** Elendi (A2A'ya dahil oldu).

### 3.10 ANP (Agent Network Protocol)
- W3C DID (did:wba, did:web, did:webvh) ve JSON-LD tabanlı, açık internet için tasarlanmış merkeziyetsiz bir ajan ağı. W3C AI Agent Protocol Community Group'ta hâlâ taslak aşamasında tartışılıyor (Temmuz 2026 toplantıları).
- **Karar:** Kapalı, güvenilir bir ekip ortamı için ağır ve olgunlaşmamış. Elendi.

### 3.11 MCP'nin kendisi (taşıma olarak)
- MCP ajan↔araç protokolü. Ajan↔ajan ya da oda semantiği tanımlamıyor. Streamable HTTP tek bir istek-yanıt çiftini taşıyor. 2026-07-28 ile oturum ve resumability kaldırıldı. Sampling (sunucunun ajanın LLM'ini çağırması) deprecated. Hermes destekliyor ama Claude Code ve Codex'te bu yolla "ajana mesaj teslim etmek" mümkün değil. Elicitation insan onayı içindir, ajanlar arası mesaj için değil.
- **Karar:** **Ajana bakan arayüz olarak zorunlu, arka uç taşıması olarak yetersiz.** Oda semantiği MCP araçlarının arkasındaki broker'da yaşamalı.

---

## 4. Karşılaştırma tablosu

Puanlama: 1 (zayıf) – 5 (güçlü). "Operasyonel kolaylık" sütununda yüksek puan daha az operasyon yükü anlamına geliyor. "Pull-model uyumu", teknolojinin LLM ajanının yoklama/long-poll döngüsüne ne kadar doğal oturduğunu gösteriyor.

| Kriter | XMPP | Matrix | MQTT | NATS/JS | Redis Str. | **Özel broker + SQLite** | IRC | A2A | ANP | MCP (tek başına) |
|---|---|---|---|---|---|---|---|---|---|---|
| Pull-model uyumu (long-poll) | 2 | 3 | 2 | 4 | 5 | **5** | 1 | 3 | 2 | 3 |
| Kalıcılık / geçmiş replay | 4 (MAM) | 5 | 1 | 5 | 4 | **5** | 1 | 3 | 2 | 1 |
| Oda / thread modeli | 5 | 5 | 3 | 3 | 2 | **5** (tasarıma göre) | 3 | 2 (contextId, çok taraflı değil) | 2 | 1 |
| Görev / artifact semantiği | 1 | 1 | 1 | 2 | 1 | **5** (A2A modeli) | 1 | 5 | 3 | 3 (Tasks eklentisi) |
| Presence | 5 | 4 | 3 (LWT) | 4 (heartbeat) | 2 | 3 (last_seen + heartbeat) | 3 | 1 | 1 | 1 |
| Kimlik doğrulama / yetkilendirme | 4 | 4 | 3 | 5 | 3 | 4 (Bearer/OAuth, MCP ile ortak) | 1 | 5 | 4 | 4 |
| NAT geçişi (farklı makineler) | 4 | 4 | 4 | 5 | 3 | **5** (tek dışa giden HTTPS) | 4 | 2 (push webhook) | 2 | 5 |
| Operasyonel kolaylık | 2 | 1 | 4 | 4 | 4 | **5** | 4 | 3 | 1 | 5 |
| Ekosistem olgunluğu | 5 | 4 | 5 | 4 (ajan std. v0.x) | 5 | 2 (bize özel) | 3 | 4 (v1.0, yeni) | 1 | 5 |
| MCP köprüleme kolaylığı | 2 | 2 | 3 | 3 | 4 | **5** (aynı süreç) | 2 | 3 | 1 | – |
| **Toplam (/50)** | **34** | **33** | **29** | **39** | **33** | **44** | **23** | **31** | **19** | *(arayüz, sıralamaya dahil değil)* |

**Yorum:** Toplam puanda özel broker öne çıkıyor. Yalnızca "ekosistem olgunluğu" ve "presence" sütunlarında geride, bu iki açığı da sırasıyla A2A uyumlu veri modeli ve basit heartbeat kapatıyor. NATS/JetStream açık ara ikinci sırada ve ölçeklenme gerektiğinde doğal yükseltme yolu. XMPP ve Matrix, insanlara dönük sohbet özelliklerinde güçlü. Ancak bu güçlü yanlar pull tabanlı ajanlara aktarılamıyor ve bedeli operasyon yükü olarak ödeniyor.

---

## 5. Analiz: neden "akıllı taşıma" yerine "akıllı veri modeli"

1. **Push, ajanın bağlamına ulaşamıyor.** Hangi broker seçilirse seçilsin, mesaj ajana ancak bir MCP araç sonucu olarak ulaşıyor. Bu durumda broker'ın push yeteneği yalnızca MCP sunucusu içindeki long-poll'u uyandırmaya yarıyor. Bu da tek bir süreç içinde bir event ile çözülüyor.
2. **Durumsuz MCP, açık imleç modelini gerektiriyor.** MCP 2026-07-28 oturumları ve SSE resumability'yi kaldırdı. Güvenilir teslim artık istemcinin `since_seq` imlecini göndermesine ve sunucunun "bu imleçten sonrasını" döndürmesine dayanıyor. Bu, SQLite'taki monoton bir `seq` sütunuyla ya da JetStream sıra numarasıyla doğal olarak sağlanıyor. XMPP ve Matrix'te ise bir çeviri katmanı gerektiriyor.
3. **Zaman aşımları beklemeyi sınırlıyor.** Codex 60 sn, Hermes 120 sn, Claude Code HTTP 5 dk idle ve 2 dk sonra arka plana alma. Bu değerler 45–50 sn'lik long-poll ile ajanın her turda "yeni bir şey var mı?" döngüsünü zorunlu kılıyor. Bu yüzden `wait_for_messages` ucuz, idempotent ve imleç tabanlı olmalı.
4. **Görev yaşam döngüsü sohbetten daha önemli.** Orkestratör → görev → ilerleme → sonuç akışı, A2A'nın Task durum makinesiyle birebir örtüşüyor. XMPP ve Matrix'te bu yapı serbest metin ya da özel payload olarak kalıyor. Durum makinesini broker'da A2A adlarıyla (SUBMITTED, WORKING, INPUT_REQUIRED, COMPLETED, FAILED, CANCELED, REJECTED) tutmak hem LLM'ler için anlaşılır bir sözleşme sunuyor hem de ileride A2A'ya köprüyü mekanik hale getiriyor.
5. **NAT sorunu hub-and-spoke ile ortadan kalkıyor.** Tüm ajanlar tek bir HTTPS uç noktasına dışa doğru bağlandığı için eşler arası (P2P), STUN/TURN ya da federasyon gerekmiyor. Uç nokta Tailscale ya da Cloudflare Tunnel ile yayınlanabilir. Kimlik doğrulama için ajan başına bir Bearer token (Claude Code `headers`/`headersHelper`, Codex ve Hermes HTTP başlıkları) yeterli. İleride MCP'nin OAuth 2.1 akışına geçilebilir.
6. **Güvenlik: oda bir prompt enjeksiyonu yüzeyi.** Claude Code Channels belgesinin kendisi, kapısız (ungated) bir kanalın prompt enjeksiyon vektörü olduğunu açıkça söylüyor. Başka bir ajanın mesajı, alıcı ajan için *veri* olmalı, *talimat* değil. Broker her mesajı gönderen kimliğiyle (odaya göre değil, göndericiye göre) doğrulamalı. Araç sonuçlarında mesajları açıkça "şu ajandan gelen içerik" olarak etiketlemeli. Orkestratör dışındaki ajanların görev atamasını da yetkiyle sınırlamalı.

---

## 6. Nihai öneri

**Temel mimari:**
- **Tek bir süreç:** MCP Streamable HTTP sunucusu ve gömülü broker birlikte çalışıyor. Depolama için SQLite (WAL modu, arama için FTS5) kullanılıyor. Mesaj tablosu append-only ve her odada monoton `seq` ile ilerliyor.
- **Araç yüzeyi (kavramsal):** `join_room` / `leave_room`, `post_message`, `wait_for_messages(room, since_seq, timeout_s≤50)`, `get_history` (sayfalı), `create_task` / `update_task_status` / `submit_artifact`, `list_agents` (AgentCard ve last_seen). Tüm durum bilgisi (ajan kimliği, oda, imleç) **açık argüman** olarak taşınıyor. Bu, MCP 2026-07-28 ile ve eski 2025-06-18/2025-11-25 istemcileriyle uyumlu.
- **Veri modeli:** A2A v1.0 kavramları. Oda veya toplantı = `contextId`, iş = `Task` (A2A durum adlarıyla), mesaj = `Message{role, parts[]}`, çıktı = `Artifact`, katılımcı = `AgentCard` (ad, beceriler, çalıştığı makine, istemci türü).
- **Presence:** Her araç çağrısında `last_seen` güncelleniyor, ayrıca bir heartbeat aracı var. Sınıflandırma "aktif / meşgul (görevde) / sessiz". Gerçek zamanlı presence iddiası yapılmıyor.
- **Ağ:** Tek bir HTTPS uç noktası (Tailscale ya da Cloudflare Tunnel) ve ajan başına Bearer token.

**Yol haritası (isteğe bağlı köprüler):**
1. **A2A ağ geçidi.** Odadaki Task/Artifact'ları dış A2A ajanlarına açıyor ve dış A2A ajanlarını odaya "misafir" olarak alıyor. Veri modeli aynı olduğu için dönüşüm maliyeti düşük.
2. **XMPP (MUC + MAM) köprüsü.** İnsanların Jabber istemcileriyle masayı izleyip yazabilmesi ya da kurumsal federasyon için.
3. **NATS/JetStream'e geçiş.** Çok sayıda ajan, birden fazla broker düğümü ya da yüksek hacim gerektiğinde depolama ve dağıtım katmanı JetStream'e taşınıyor. Cotal ve NATS Agent Protocol olgunlaşırsa bunlarla uyum da değerlendirilebilir.
4. **Claude Code Channels ile "dürtme".** Research preview statüsünden çıkarsa, yerel bir stdio köprüsüyle Claude Code oturumunu yeni mesajda uyandırmak için eklenebilir. Bu bir optimizasyon olur, temel mekanizma olmaz.

**Bu öneriyi değiştirebilecek koşullar:** (a) MCP istemcileri sunucu olaylarını modele tur olarak iletmeyi standart hale getirirse (şu an yalnızca Claude Code Channels'ta, deneysel olarak var), push tabanlı arka uçların değeri artar. (b) Ekip ajan sayısını onlarla ölçülecek bir düzeye ve çoklu bölgeye çıkarırsa, doğrudan NATS/JetStream ile başlamak daha ekonomik olur. (c) Asıl kullanıcı insanlar olursa ve ajanlar ikincil kalırsa, Matrix ya da XMPP daha anlamlı hale gelir.

---

## 7. Kaynaklar

**MCP**
- MCP 2026-07-28 Changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP Changelog (latest): https://modelcontextprotocol.io/specification/latest/changelog
- MCP 2025-11-25 değişiklikleri: https://modelcontextprotocol.info/specification/2025-11-25/changelog/
- Claude Code MCP belgeleri (taşımalar, zaman aşımları, list_changed, çıktı sınırları): https://code.claude.com/docs/en/mcp
- Claude Code Channels referansı: https://code.claude.com/docs/en/channels-reference.md
- Claude Code MCP zaman aşımı sorunları: https://github.com/anthropics/claude-code/issues/20335 , https://claudeissues.com/issue/69487-bug-mcp-tool-call-wedges-indefinitely-without-client-side-timeout-cli-no-mcp-too
- Codex CLI MCP belgeleri: https://developers.openai.com/codex/mcp.md
- Codex CLI Streamable HTTP: https://codex.danielvaughan.com/2026/04/20/remote-mcp-http-codex-cli-enterprise-tool-services/
- Codex CLI ve MCP 2026-07-28: https://codex.danielvaughan.com/2026/08/31/mcp-2026-07-28-stateless-protocol-codex-cli-operators-guide/
- Codex CLI MCP olgunlaşması (elicitation, resources): https://codex.danielvaughan.com/2026/04/11/codex-cli-mcp-maturation-resource-reads-outputschema/
- Hermes Agent MCP: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
- Hermes MCP yapılandırması: https://www.mintlify.com/NousResearch/hermes-agent/user-guide/features/mcp

**Ajan protokolleri**
- A2A spesifikasyonu (v1.0.0): https://a2a-protocol.org/latest/specification/
- A2A v1.0 Builder's Guide (AAIF): https://aaif.io/blog/a2a-v1-0-a-builder-s-guide-part-1-discovery-tasks-and-clients
- A2A'nın ilk yılı (Linux Foundation): https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
- ACP → A2A birleşmesi: https://tyk.io/learning-center/agent-protocols-a-complete-guide-to-mcp-a2a-and-acp/ , https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026
- ANP / W3C AI Agent Protocol CG: https://lists.w3.org/Archives/Public/public-agentprotocol/2026Jul/0010.html , https://atlan.com/know/mcp/how-to-choose-mcp-a2a-anp/

**Mesajlaşma altyapıları**
- NATS Agent Protocol: https://nats.io/blog/nats-native-protocol-for-ai-agents/
- Cotal (NATS üzerinde ajan ekipleri): https://nats.io/blog/coordinating-ai-agent-teams-on-nats/
- XMPP MUC: https://wiki.xmpp.org/web/Tech_pages/Multi-User_Chat
- Prosody 13.0.4: https://blog.prosody.im/prosody-13.0.4-released/
- ejabberd 26.3.0: https://hex.pm/packages/ejabberd/26.3.0 ; yol haritası: https://docs.ejabberd.im/roadmap/
- Matrix v1.17: https://matrix.org/blog/2025/12/18/matrix-v1.17-release/ ; sürümler: https://matrix.org/blog/category/releases

**Benzer projeler**
- MCP Agent Mail: https://glama.ai/mcp/servers/@Dicklesworthstone/mcp_agent_mail/blob/5fa08841bb5783e805d166bec4754a72b6dc1ac8/README.md
- agent-inbox: https://pypi.org/project/agent-inbox/0.13.3/
