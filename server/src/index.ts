// agents-room sunucusu giriş noktası.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.ts';
import { RoomService } from './room.ts';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

/** İlk çalıştırmada admin (insan) kimliği oluşturur ve token'ı dosyaya yazar. */
function bootstrapAdmin(svc: RoomService, dataDir: string): void {
  const hasAdmin = svc.db.prepare("SELECT 1 FROM agents WHERE role = 'admin' AND revoked = 0").get();
  if (hasAdmin) return; // token dosyası kaybolduysa: `npm run cli -- agent add admin --role admin --kind human`
  const { token } = svc.createAgent({ name: 'admin', kind: 'human', role: 'admin', capabilities: ['review', 'merge'] });
  writeFileSync(join(dataDir, 'admin.token'), token + '\n', { mode: 0o600 });
  console.log(`🔑 İlk admin token oluşturuldu → ${join(dataDir, 'admin.token')}`);
}

/** Kayıt sırrı: ortam değişkeni > data/enroll.secret > yeni üretilir. */
function enrollSecret(dataDir: string, fromEnv: string | undefined): string {
  if (fromEnv) return fromEnv;
  const file = join(dataDir, 'enroll.secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = randomBytes(16).toString('hex');
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

main();
function main() {
  const cfg = loadConfig();
  const dataDir = dirname(cfg.dbPath);
  mkdirSync(dataDir, { recursive: true });
  const svc = new RoomService(openDb(cfg.dbPath));
  bootstrapAdmin(svc, dataDir);
  const secret = cfg.enrollEnabled ? enrollSecret(dataDir, cfg.enrollSecret) : undefined;
  const app = createApp(svc, { ...cfg, enrollSecret: secret });
  const sweeper = setInterval(() => {
    try {
      svc.sweep();
    } catch (e) {
      console.error('sweep hatası', e);
    }
  }, 15_000);
  const server = app.listen(cfg.port, cfg.host, () => {
    const hosts = cfg.host === '0.0.0.0' ? ['127.0.0.1', ...lanAddresses()] : [cfg.host];
    const urls = cfg.publicUrl ? [cfg.publicUrl] : cfg.inDocker ? [] : hosts.map((h) => `http://${h}:${cfg.port}`);
    console.log(`\nagents-room çalışıyor`);
    for (const u of urls) console.log(`  panel: ${u}    MCP: ${u}/mcp`);
    if (!urls.length) console.log(`  panel: http://<bu-makinenin-adresi>:<yayınlanan-port>  (AGENTS_ROOM_PUBLIC_URL ile gösterilir)`);
    console.log(`  veritabanı:   ${cfg.dbPath}`);
    if (cfg.inDocker) {
      console.log('  panel girişi: docker exec <konteyner> agents-room token');
      if (secret) console.log('  kayıt sırrı:  docker exec <konteyner> agents-room secret');
    } else {
      console.log(`  panel girişi: ${join(dataDir, 'admin.token')}`);
      if (secret) console.log(`  kayıt sırrı:  ${join(dataDir, 'enroll.secret')}`);
    }
    const remote = cfg.publicUrl ?? (cfg.inDocker || cfg.host !== '0.0.0.0' ? undefined : lanAddresses()[0] && `http://${lanAddresses()[0]}:${cfg.port}`);
    if (secret && remote) console.log(`\n  Başka bir makineden ekip kurmak için (proje kopyasında):\n    node scripts/team.ts --server ${remote}`);
    if (cfg.host === '0.0.0.0') console.log('\n  ⚠️  Tüm ağ arayüzlerinde dinleniyor. İnternete açmayın; uzak erişim için Tailscale/TLS kullanın (docs/tr/dagitik-kurulum.md).');
    console.log('');
  });
  // Uzun-yoklama isteklerinin kesilmemesi için zaman aşımları max bekleme süresinden büyük olmalı.
  // Uyandırma ucu (/api/agent/wake) en çok 900 sn bekler.
  server.requestTimeout = (Math.max(cfg.maxWaitSec, 900) + 30) * 1000;
  const stop = () => {
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
