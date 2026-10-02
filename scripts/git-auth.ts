// Ortak repoya erişim: GitHub token'ı (HTTPS) ya da SSH anahtarı.
// Anahtar repo adresine, oda kaydına ya da team.json'a yazılmaz. Klon çalışırken git'in
// kimlik yardımcısı token'ı AGENTS_ROOM_GIT_TOKEN ortam değişkeninden okur.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type GitAuth = { kind: 'none' } | { kind: 'token'; token: string } | { kind: 'ssh'; sshKey: string };

export const TOKEN_ENV = 'AGENTS_ROOM_GIT_TOKEN';
// Tek tırnaklar yok: değer git config'e argüman olarak gider, kabuktan geçmez.
export const CRED_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${TOKEN_ENV}"; }; f`;

export const isHttps = (u: string) => /^https?:\/\//i.test(u);
export const isSsh = (u: string) => /^ssh:\/\//i.test(u) || /^[\w.-]+@[\w.-]+:/.test(u);

/**
 * Kullanıcının yazdığı repo adresini sadeleştirir:
 *   org/repo, github.com/org/repo  → https://github.com/org/repo.git
 *   https://<token>@github.com/... → adres + ayrı token (adreste kimlik bırakılmaz)
 */
export function normalizeRepo(input: string): { url: string; token?: string } {
  const s = input.trim();
  if (!s) return { url: '' };
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !existsSync(s)) return { url: `https://github.com/${s.replace(/\.git$/, '')}.git` };
  if (/^github\.com\//i.test(s)) return { url: `https://${s.replace(/\.git$/, '')}.git` };
  if (isHttps(s)) {
    const u = new URL(s);
    const secret = u.password || (/^(gh[pousr]_|github_pat_)/.test(u.username) ? u.username : '');
    u.username = '';
    u.password = '';
    let url = u.toString();
    if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(url) && !url.endsWith('.git')) url += '.git';
    return secret ? { url, token: decodeURIComponent(secret) } : { url };
  }
  return { url: s };
}

export function githubSlug(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export function expandHome(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()));
}

const sshCommand = (key: string) => `ssh -i '${key.replace(/'/g, `'\\''`)}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;

/** Git süreçlerine (ve agent'lara) verilecek ortam değişkenleri. */
export function gitEnv(auth: GitAuth, url = ''): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (auth.kind === 'token') {
    env[TOKEN_ENV] = auth.token;
    if (githubSlug(url)) env.GH_TOKEN = auth.token; // gh CLI (PR açmak için)
  }
  if (auth.kind === 'ssh') env.GIT_SSH_COMMAND = sshCommand(auth.sshKey);
  return env;
}

/** Tek seferlik git komutları için -c ayarları (makinedeki diğer kimlik yardımcılarını devre dışı bırakır). */
export function gitConfigArgs(auth: GitAuth): string[] {
  if (auth.kind === 'token') return ['-c', 'credential.helper=', '-c', `credential.helper=${CRED_HELPER}`];
  return [];
}

function git(args: string[], auth: GitAuth, url: string, cwd?: string) {
  return spawnSync('git', [...gitConfigArgs(auth), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...gitEnv(auth, url) },
    timeout: 60_000,
  });
}

/** Klonu kalıcı olarak yapılandırır: sonraki fetch/push (agent'ların yaptıkları dahil) aynı kimliği kullanır. */
export function configureWorkspace(dir: string, auth: GitAuth): void {
  const cfg = (...a: string[]) => spawnSync('git', ['-C', dir, 'config', '--local', ...a], { encoding: 'utf8' });
  if (auth.kind === 'token') {
    cfg('--unset-all', 'credential.helper');
    cfg('--add', 'credential.helper', '');
    cfg('--add', 'credential.helper', CRED_HELPER);
  }
  if (auth.kind === 'ssh') cfg('core.sshCommand', sshCommand(auth.sshKey));
}

export function cloneRepo(url: string, dir: string, auth: GitAuth): { ok: boolean; error?: string } {
  const r = git(['clone', '-q', url, dir], auth, url);
  if (r.status !== 0) return { ok: false, error: redact((r.stderr || r.error?.message || '').trim(), auth) };
  configureWorkspace(dir, auth);
  return { ok: true };
}

export function fetchRepo(dir: string, auth: GitAuth, url = ''): void {
  configureWorkspace(dir, auth);
  spawnSync('git', ['-C', dir, 'fetch', '-q', 'origin'], { env: { ...process.env, ...gitEnv(auth, url) }, timeout: 60_000 });
}

/**
 * Uzun sürebilen git komutu (büyük repo klonu): toplam süre sınırı yok. Yalnızca stallMs boyunca hiç
 * çıktı gelmezse (ağ takıldıysa) durdurulur. --progress satırları onProgress'e gider.
 */
export function gitLong(
  args: string[],
  opt: { auth: GitAuth; url?: string; cwd?: string; stallMs?: number; onProgress?: (line: string) => void },
): Promise<{ ok: boolean; error?: string }> {
  const stallMs = opt.stallMs ?? (Number(process.env.AGENTS_ROOM_GIT_STALL_SEC) || 300) * 1000; // boş/geçersiz → 300 sn
  return new Promise((done) => {
    const p = spawn('git', [...gitConfigArgs(opt.auth), ...args], {
      cwd: opt.cwd,
      env: { ...process.env, ...gitEnv(opt.auth, opt.url ?? '') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let tail = '';
    let stalled = false;
    let timer: NodeJS.Timeout;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        p.kill('SIGTERM');
      }, stallMs);
    };
    arm();
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk: string) => {
      arm();
      tail = (tail + chunk).slice(-4000);
      for (const line of chunk.split(/[\r\n]+/)) if (line.trim()) opt.onProgress?.(line.trim());
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, error: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return done({ ok: true });
      const last = tail.split(/[\r\n]+/).filter((l) => l.trim() && !/^(remote: )?(Counting|Compressing|Receiving|Resolving|Enumerating|Updating)/.test(l.trim()));
      const msg = stalled ? `${stallMs / 1000} sn boyunca ilerleme yok (ağ bağlantısı?)` : last.slice(-3).join(' ') || `git çıkış kodu ${code}`;
      done({ ok: false, error: redact(msg, opt.auth) });
    });
  });
}

/**
 * Makine başına tek bir yerel önbellek (bare repo): büyük repo GitHub'dan bir kez indirilir, her agent'ın
 * çalışma kopyası buradan saniyeler içinde açılır. Önbellek varsa yalnızca güncellenir.
 */
export async function syncCache(url: string, cache: string, auth: GitAuth, onProgress?: (line: string) => void): Promise<{ ok: boolean; error?: string }> {
  if (existsSync(join(cache, 'HEAD'))) {
    return gitLong(['-C', cache, 'fetch', '--prune', '--progress', url, '+refs/heads/*:refs/heads/*'], { auth, url, onProgress });
  }
  const tmp = `${cache}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  const r = await gitLong(['clone', '--bare', '--progress', url, tmp], { auth, url, onProgress });
  if (!r.ok) {
    rmSync(tmp, { recursive: true, force: true });
    return r;
  }
  renameSync(tmp, cache);
  return { ok: true };
}

/**
 * Agent'ın çalışma kopyası: önbellekten açılır (nesneler sabit bağlantıyla paylaşılır, indirme yok), origin ortak
 * repoya çevrilir, kimlik ayarlanır. Büyük repolarda dosyaların çıkarılması dakikalar sürebilir: ilerleme onProgress'e gider.
 */
export async function cloneFromCache(
  url: string,
  cache: string,
  dir: string,
  auth: GitAuth,
  onProgress?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const tmp = join(dirname(dir), `.${dir.split('/').pop()}.tmp-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const failed = (r: { ok: boolean; error?: string }) => {
    rmSync(tmp, { recursive: true, force: true });
    return r;
  };
  const c = await gitLong(['clone', '--progress', cache, tmp], { auth: { kind: 'none' }, onProgress });
  if (!c.ok) return failed(c);
  const r = spawnSync('git', ['-C', tmp, 'remote', 'set-url', 'origin', url], { encoding: 'utf8' });
  if (r.status !== 0) return failed({ ok: false, error: redact((r.stderr || r.error?.message || '').trim(), auth) });
  configureWorkspace(tmp, auth);
  // origin/* başvuruları ortak repodan gelir (nesneler önbellekte olduğu için hızlıdır).
  const f = await gitLong(['-C', tmp, 'fetch', '--progress', 'origin'], { auth, url, onProgress });
  if (!f.ok) return failed(f);
  renameSync(tmp, dir);
  return { ok: true };
}

/** Var olan çalışma kopyasını günceller (kimlik ayarı + fetch); süre sınırı yerine takılma sınırı. */
export async function refreshWorkspace(dir: string, auth: GitAuth, url = ''): Promise<{ ok: boolean; error?: string }> {
  configureWorkspace(dir, auth);
  return gitLong(['-C', dir, 'fetch', '--progress', 'origin'], { auth, url });
}

/** Repo erişilebilir mi, boş mu, varsayılan dalı ne? */
export function probeRepo(url: string, auth: GitAuth): { ok: boolean; empty?: boolean; defaultBranch?: string; error?: string } {
  const r = git(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], auth, url);
  if (r.status !== 0) return { ok: false, error: redact((r.stderr || r.error?.message || 'git ls-remote failed').trim(), auth) };
  const out = r.stdout.trim();
  const head = out.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  return { ok: true, empty: !/refs\/heads\//.test(out.replace(/^ref:.*$/m, '')), defaultBranch: head };
}

/** GitHub token'ının repoya yazma izni var mı? (null = belirlenemedi) */
export async function githubPushAccess(url: string, token: string): Promise<{ push: boolean | null; error?: string }> {
  const slug = githubSlug(url);
  if (!slug) return { push: null };
  try {
    const r = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agents-room' },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401) return { push: false, error: 'token geçersiz ya da süresi dolmuş' };
    if (r.status === 404) return { push: false, error: 'repo bulunamadı ya da token bu repoyu göremiyor' };
    if (!r.ok) return { push: null, error: `GitHub API HTTP ${r.status}` };
    const j = (await r.json()) as { permissions?: { push?: boolean } };
    return { push: j.permissions?.push ?? null };
  } catch (e) {
    return { push: null, error: (e as Error).message };
  }
}

/** Boş repoya README ile ilk commit'i atar (agent'lar origin/<dal> üzerinden dal açabilsin). */
export function seedEmptyRepo(url: string, auth: GitAuth, room: string, branch = 'main'): { ok: boolean; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agents-room-seed-'));
  try {
    const run = (args: string[]) => git(args, auth, url, dir);
    run(['init', '-q', '-b', branch]);
    writeFileSync(join(dir, 'README.md'), `# ${room}\n\nagents-room ortak çalışma reposu.\n`);
    run(['add', '-A']);
    run(['-c', 'user.name=agents-room', '-c', 'user.email=agents-room@local', 'commit', '-qm', 'chore: initial commit']);
    const p = run(['push', '-q', url, `${branch}:${branch}`]);
    return p.status === 0 ? { ok: true } : { ok: false, error: redact(p.stderr.trim(), auth) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Hata metinlerinde token görünmesin. */
export function redact(text: string, auth: GitAuth): string {
  return auth.kind === 'token' && auth.token ? text.split(auth.token).join('***') : text;
}
