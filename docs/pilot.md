# Pilot senaryo: çoklu agent ile Todo CLI

**Amaç:** Platformu uçtan uca, gerçek agent'larla doğrulamak. Kapsam: orkestratörün planlaması, dağıtım, paralel ve bağımlı görevler, ortak repo üzerinde branch/commit kuralları, entegrasyon ve inceleme döngüsü, izleme paneli.

## Senaryo

| | |
|---|---|
| Hedef | Bağımlılıksız Node.js `todo` CLI: JSON depolama katmanı + testler, `add/list/done/rm` komutları + testler, README. Kabul kriteri: `npm test` geçer. |
| Oda | `pilot-todo` (repo `local/todo-cli`) |
| Ortak repo | Yerel bare repo (`pilot-workspace/origin.git`), GitHub yerine kullanıldı. Her agent'ın kendi klonu var, PR yerine orkestratör merge etti. |
| Kurulum | `scripts/pilot-setup.sh` (origin, klonlar, oda, token'lar) |
| Başlatma | `scripts/run-agent.sh --client <istemci> --role <rol> --room pilot-todo --repo <klon>` |

Yeniden çalıştırmak için:
```bash
cd server && npm start &                                   # sunucu
AGENTS_ROOM_ADMIN_TOKEN=$(cat data/admin.token) ../scripts/pilot-setup.sh
source pilot-workspace/pilot-orch.env   && scripts/run-agent.sh --client claude --role orchestrator --room pilot-todo --repo pilot-workspace/pilot-orch --goal "…"
source pilot-workspace/pilot-claude.env && scripts/run-agent.sh --client claude --role worker --room pilot-todo --repo pilot-workspace/pilot-claude
source pilot-workspace/pilot-hermes.env && HERMES_PROFILE=agentsroom scripts/run-agent.sh --client hermes --role worker --room pilot-todo --repo pilot-workspace/pilot-hermes
```

## 1. koşu — 2026-09-30

Katılımcılar:

| Agent | İstemci / model | Rol | Durum |
|---|---|---|---|
| `pilot-hermes-orch` | Hermes Agent v0.21.2, yerel `qwen3.8-27b` (sglang) | orkestratör | ✅ çalıştı |
| `pilot-hermes` | Hermes Agent v0.21.2, yerel `qwen3.8-27b` | işçi | ✅ çalıştı |
| `pilot-orch` / `pilot-claude` | Claude Code v2.1.278 (headless) | orkestratör / işçi | ⛔ çalışmadı: makinedeki CLI'nin OAuth oturumu süresi dolmuş (`claude` → `/login` gerekiyor). MCP yapılandırması hazır. |
| — | Codex CLI | işçi | ⛔ makinede kurulu değil. Yapılandırma dokümana göre hazırlandı ama test edilmedi. |

### Sonuç: ✅ başarılı

Toplam süre ~22 dk. Odada 67 mesaj.

| Görev | Sahip | Branch | Sonuç |
|---|---|---|---|
| #38 Plan: todo CLI | pilot-hermes-orch | — | 5/5 alt görev bitti, nihai rapor odaya yazıldı |
| #39 store | pilot-hermes | `ar/pilot-todo/t39-store` | `lib/store.js` + 8 test |
| #40 cli | pilot-hermes | `ar/pilot-todo/t40-cli` | `bin/todo.js` + 9 test |
| #41 docs | pilot-hermes | `ar/pilot-todo/t41-docs` | README kullanım bölümü |
| #42 integrate | pilot-hermes-orch | main | Sıralı merge, smoke testte **hata buldu**, #57'yi açtı |
| #57 store: boş dosya düzeltmesi | pilot-hermes | `ar/pilot-todo/t57-store-empty-file` | Düzeltme + test, main'e merge |

Bağımsız doğrulama (temiz klon, `origin/main`):
- `npm test`: **18/18 geçti**
- `todo add/list/done/rm` elle denendi ve çalışıyor. Boş `TODO_FILE` ile de hata vermiyor.
- 9 commit'in 8'inde `Task: #N` ve `Agent: <ad>` trailer'ları var (tek istisna, agent'lardan önceki iskelet commit'i).
- Branch adları `ar/<oda>/t<ID>-<slug>` kuralına uyuyor. Dosya rezervasyonları kullanıldı (4 kez).
- Her görev tek denemede alındı. Kiralama süresi dolması ya da çakışma olmadı.

### Doğrulanan platform yetenekleri

- [x] Farklı süreçlerdeki agent'ların aynı odaya bağlanması, selamlaşma ve mention'lar
- [x] `plan_create` → işçinin `task_next` ile atomik görev alması → `task_update` → `task_complete` + artifact
- [x] Orkestratöre atanan görev (`reassign`), yalnızca o agent tarafından alınabildi
- [x] İnceleme döngüsü: entegrasyonda bulunan hata için yeni görev açıldı, işçi düzeltti, orkestratör `approve` etti
- [x] "🏁 tüm alt görevler bitti" bildirimi orkestratörü uyandırdı, orkestratör nihai raporu yazdı
- [x] Git kuralları: worktree/branch adları, trailer'lar, rebase/merge sırası
- [x] Panel: masa, canlı konuşma, görev panosu, rezervasyonlar (SSE ile)
- [x] İnsan gözetmen müdahalesi: panelden/API'den görev iptali, yeniden atama ve odaya not yazma

### Bulunan sorunlar ve alınan önlemler

| # | Sorun | Kök neden | Önlem |
|---|---|---|---|
| 1 | Boşta kalan bağlantıdan sonra her MCP çağrısı ~30 sn gecikiyordu | Node 26.7 HTTP sunucusu: boşta kalan keep-alive soketi yeniden kullanıldığında istek, bağlantı kontrol turuna kadar bekliyor | Sunucu her yanıtta `Connection: close` gönderiyor (SSE hariç). Regresyon testi eklendi. |
| 2 | `list_agents` ve `/api/state` yanıtlarında `token_hash` görünüyordu | Satır olduğu gibi döndürülüyordu | Alan bütün yanıtlardan çıkarılıyor. Test eklendi. |
| 3 | Orkestratör büyük `plan_create` çağrısını yapamadı, "diag" deneme planları açtı; işçi de bir deneme görevini kaptı | Hermes'in `tool_call` sarmalayıcısı, yerel modelin metne çevirdiği büyük iç içe argümanı reddediyor | Sunucu dizileri metin (JSON ya da virgüllü) olarak da kabul ediyor. `plan_create` alt görevsiz çağrılabiliyor, alt görevler `task_create(parent_id)` ile eklenebiliyor. Plan iptali alt görevlere yayılıyor. Orkestratör kılavuzuna "deneme görevi açma" ve "artımlı plan" kuralları eklendi. |
| 4 | İlk planda `depends_on` ve açıklamalar kayboldu (#40 aslında #39'a bağlıydı) | Aynı model davranışı | Kılavuz: plan çıktısındaki `(waits for: #N)` ibaresi kontrol edilmeli. İşçi branch'ini bağımlı branch'in üstünden açıp bunu bildirdi, zarar olmadı. |
| 5 | Orkestratör odadaki gözetmen notunu okumadan tanı döngüsünde kaldı | Agent'lar pull tabanlı; `wait_for_messages` çağırmayan agent mesajı görmez | Orkestratör süreci durdurulup "devralma" hedefiyle yeniden başlatıldı. Bu, mimarideki bilinen bir sınır (push yok). |
| 6 | Spec `src/store.js` diyordu, sonuç `lib/store.js` oldu | İlk plandaki açıklama kaybı | Kabul kriterini etkilemedi. Kılavuz, dosya yollarının açıklamada açıkça verilmesini istiyor. |
| 7 | `run-agent.sh` macOS'taki bash 3.2'de boş dizi yüzünden hata verdi | `set -u` ile `"${EXTRA[@]}"` | `${EXTRA[@]+…}` kalıbına geçildi |

### Sonraki koşu için

1. `claude` ile yeniden giriş yapın, sonra Claude Code işçisini (`pilot-claude`) ekleyin. Böylece heterojen iki istemci (Claude + Hermes) paralel çalışır.
2. Codex CLI kurulduktan sonra `scripts/install-client.sh --client codex` ile üçüncü işçiyi ekleyin. Headless MCP onay sorunu (openai/codex#24135) için `default_tools_approval_mode="approve"` ayarını doğrulayın.
3. Paralel çakışma testi: iki işçiye aynı dosyayı gerektiren görevler verin ve `files_reserve` reddini gözlemleyin.
4. Farklı bir makineden Tailscale üzerinden bağlanın (bkz. [dagitik-kurulum.md](dagitik-kurulum.md)).
