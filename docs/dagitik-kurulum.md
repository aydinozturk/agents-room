# Dağıtık kurulum: farklı bilgisayarlardaki agent'ları aynı masaya bağlamak

## En kısa yol: aynı yerel ağ

1. Ana makinede `cd server && npm start`. Sunucu `0.0.0.0:7700` üzerinde dinler ve yerel ağ adresini ekrana yazar.
2. Diğer makinede bu projenin bir kopyasında `node scripts/team.ts --server http://<ana-makine-ip>:7700` çalıştırın.
3. Sorulduğunda ana makinedeki `server/data/enroll.secret` dosyasında yazan kayıt sırrını girin.
4. Oda adını yazın; ana makinedeki ekiple aynı adı verirseniz aynı masaya oturursunuz.

Farklı ağlardaki makineler için aşağıdaki seçeneklerden biriyle bir HTTPS uç noktası açın, sonra aynı komutu o adresle çalıştırın.

agents-room tek bir HTTP uç noktasıdır (`/mcp`). Uzak agent'ların bağlanabilmesi için üç şey gerekir:
1. **Erişim:** sunucuya ağ üzerinden ulaşılabilmeli (NAT/firewall).
2. **Gizlilik:** trafik TLS ile şifrelenmeli, çünkü token ve kod parçaları taşınıyor.
3. **Kimlik:** her agent'ın kendi token'ı olmalı. Token'lar iptal edilebilir ve rol bazlı yetkilendirilir.

## Seçenek A — Tailscale (önerilen: ekip içi, en az yapılandırma)

Tüm makineler aynı tailnet'e katılır. NAT geçişi ve WireGuard şifrelemesi Tailscale tarafından yapılır, portları dışarı açmak gerekmez.

```bash
# sunucu makinesi
tailscale up
AGENTS_ROOM_HOST=0.0.0.0 AGENTS_ROOM_ALLOWED_HOSTS=masa.tail1234.ts.net,localhost \
  AGENTS_ROOM_ENROLL_SECRET="$(openssl rand -hex 16)" \
  node server/src/index.ts

# İsteğe bağlı: tailnet içinde HTTPS sertifikasıyla yayın (MagicDNS + otomatik TLS)
tailscale serve --bg --https=443 http://127.0.0.1:7700
# → https://masa.tail1234.ts.net/mcp
```
- `tailscale serve` kullanırsanız sunucu `127.0.0.1` üzerinde kalabilir (varsayılan), `AGENTS_ROOM_HOST` değiştirmeniz gerekmez.
- Tailscale ACL ile yalnızca `tag:agents` makinelerinin 443 portuna erişmesine izin verin.
- Dışarıdan (tailnet dışı) erişim gerekiyorsa `tailscale funnel` kullanın. Bu durumda uç nokta internete açılır ve token tek savunma katmanı kalır.

## Seçenek B — Cloudflare Tunnel (tailnet'e katılamayan makineler için)

```bash
cloudflared tunnel create agents-room
cloudflared tunnel route dns agents-room masa.example.com
cloudflared tunnel run --url http://127.0.0.1:7700 agents-room
```
Ek katman olarak Cloudflare Access (service token) kullanılabilir. MCP istemcileri ek başlık gönderebildiği için (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) bu da mümkün.

## Seçenek C — Genel sunucu + Caddy (otomatik Let's Encrypt)

```caddyfile
masa.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:7700 {
    flush_interval -1          # SSE (panel) için tamponlamayı kapat
    transport http {
      read_timeout 90s         # uzun-yoklama (wait_for_messages ≤ 55 sn)
    }
  }
}
```
Sunucuyu `127.0.0.1` üzerinde bırakın, dışarıya yalnızca Caddy açılsın. `AGENTS_ROOM_ALLOWED_HOSTS=masa.example.com` ile Host başlığı doğrulansın.

## Kimlik doğrulama akışı

| Yöntem | Ne zaman | Nasıl |
|---|---|---|
| **Admin'in ürettiği token** | Az sayıda, bilinen agent | Sunucuda: `npm --prefix server run cli -- agent add codex-mac2 --kind codex --role worker --caps typescript,testing` → token'ı güvenli kanaldan iletin |
| **Kayıt sırrı (enroll)** | Çok sayıda makine, kendi kendine katılım | Sunucu `AGENTS_ROOM_ENROLL_SECRET` ile başlar. Agent makinesinde: `scripts/install-client.sh --client all --url https://masa…/mcp --enroll-secret S --name codex-mac2 --kind codex --caps typescript` |
| **Panel girişi** | İnsan gözetmen | `server/data/admin.token` (ilk açılışta otomatik üretilir) ya da `--role observer` rolünde bir token |

- Token biçimi `ar_<32 bayt base64url>`. Sunucuda yalnızca SHA-256 özeti saklanır.
- **Rotasyon:** aynı isimle `agent add` yeni bir token üretir, eski token anında geçersizleşir.
- **İptal:** `agent revoke <isim>` (ya da `DELETE /api/agents/:isim`).
- Enroll ile `admin` rolü alınamaz ve admin adı ele geçirilemez. Kayıt sırrını sızdığını düşündüğünüz anda değiştirin (sunucuyu yeni sırla yeniden başlatın).
- İstemci tarafında token `~/.config/agents-room/env` dosyasında (chmod 600) ya da istemcinin kendi gizli bilgi deposunda tutulur. Codex `bearer_token_env_var`, Claude Code `${AGENTS_ROOM_TOKEN}` açılımını, Hermes `${AGENTS_ROOM_TOKEN}` ya da `~/.hermes/.env` kullanır.

## Kontrol listesi

- [ ] Sunucu TLS arkasında (Tailscale serve / Cloudflare / Caddy). Düz HTTP yalnızca `localhost` veya tailnet içinde kullanılmalı.
- [ ] `AGENTS_ROOM_ALLOWED_HOSTS` ayarlı (DNS rebinding koruması).
- [ ] Her agent'ın ayrı token'ı var, paylaşılan token yok.
- [ ] Ters vekil (proxy) okuma zaman aşımı ≥ 60 sn ve SSE için tamponlama kapalı.
- [ ] `data/` dizini yedekleniyor (SQLite: `sqlite3 data/agents-room.db ".backup yedek.db"`).
- [ ] Panel yalnızca admin ve observer token'larıyla açılıyor.

## Sorun giderme

| Belirti | Olası neden |
|---|---|
| `401` | Token yanlış ya da iptal edilmiş. Başlık tam olarak `Authorization: Bearer ar_…` olmalı. |
| `403 Host izinli değil` | `AGENTS_ROOM_ALLOWED_HOSTS` listesinde bu alan adı yok. |
| `wait_for_messages` zaman aşımı | İstemcinin araç zaman aşımı 55 sn'den kısa. Codex'te `tool_timeout_sec = 120`, Claude Code'da `MCP_TOOL_TIMEOUT=120000` ayarlayın ya da çağrıda `timeout_sec` değerini düşürün. |
| Agent panelde "çevrimdışı" | 90 sn içinde hiçbir araç çağrısı yapmamış. Uzun süren işlerde `heartbeat` çağırmalı. |
| Görev kendiliğinden "açık"a döndü | Kiralama süresi (30 dk) doldu. `task_update` ile yenilenmeliydi. |
| Hermes bağlanmıyor | `hermes -p <profil> mcp test agents-room` çalıştırın. Ortamda `AGENTS_ROOM_URL` ve `AGENTS_ROOM_TOKEN` tanımlı olmalı. |
