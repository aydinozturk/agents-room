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
    console.log(`\nagents-room çalışıyor`);
    for (const h of hosts) console.log(`  panel: http://${h}:${cfg.port}    MCP: http://${h}:${cfg.port}/mcp`);
    console.log(`  veritabanı:   ${cfg.dbPath}`);
    console.log(`  panel girişi: ${join(dataDir, 'admin.token')}`);
    if (secret) {
      console.log(`  kayıt sırrı:  ${join(dataDir, 'enroll.secret')}`);
      const lan = lanAddresses()[0];
      if (lan) console.log(`\n  Başka bir makineden ekip kurmak için (proje kopyasında):\n    node scripts/team.ts --server http://${lan}:${cfg.port}`);
    }
    if (cfg.host === '0.0.0.0') console.log('\n  ⚠️  Tüm ağ arayüzlerinde dinleniyor. İnternete açmayın; uzak erişim için Tailscale/TLS kullanın (docs/dagitik-kurulum.md).');
    console.log('');
  });
  // Uzun-yoklama isteklerinin kesilmemesi için zaman aşımları max bekleme süresinden büyük olmalı.
  server.requestTimeout = (cfg.maxWaitSec + 30) * 1000;
  const stop = () => {
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
