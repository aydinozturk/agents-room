import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Varsayılan veritabanı, sunucu nereden başlatılırsa başlatılsın server/data/ altındadır.
const DEFAULT_DB = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'agents-room.db');

export function loadConfig(env = process.env) {
  const dbPath = env.AGENTS_ROOM_DB ? resolve(env.AGENTS_ROOM_DB) : DEFAULT_DB;
  return {
    // Varsayılan: tüm arayüzler (aynı ağdaki diğer makineler bağlanabilsin). Yalnız yerel için AGENTS_ROOM_HOST=127.0.0.1
    host: env.AGENTS_ROOM_HOST ?? '0.0.0.0',
    port: Number(env.AGENTS_ROOM_PORT ?? 7700),
    dbPath,
    enrollSecret: env.AGENTS_ROOM_ENROLL_SECRET || undefined,
    enrollEnabled: env.AGENTS_ROOM_ENROLL !== 'off',
    maxWaitSec: Number(env.AGENTS_ROOM_MAX_WAIT ?? 55),
    defaultWaitSec: Number(env.AGENTS_ROOM_DEFAULT_WAIT ?? 40),
    // Başlangıç mesajında gösterilecek dış adres (ör. Docker'da konteyner IP'si yerine makinenin adresi).
    publicUrl: env.AGENTS_ROOM_PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    inDocker: env.AGENTS_ROOM_IN_DOCKER === '1',
    allowedHosts: env.AGENTS_ROOM_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
