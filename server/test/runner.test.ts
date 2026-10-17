// scripts/run-agent.sh davranış testleri: sahte uyandırma sunucusu + sahte model CLI'ı (claude) ile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUNNER = resolve(import.meta.dirname, '../../scripts/run-agent.sh');
const skip = process.platform === 'win32' ? 'bash yok' : false;

let tmp: string;
let api: Server;
let base: string;
/** Sunucuya gelen istekler (yol + gövde). */
const hits: { path: string; body: any }[] = [];
/** Sıradaki uyandırma yanıtları; boşsa istek 1 sn bekletilip TIMEOUT döner. */
let wakes: string[] = [];

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ar-runner-'));
  api = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* boş */
      }
      hits.push({ path: req.url!, body });
      res.setHeader('Connection', 'close');
      if (req.url === '/api/agent/wake') {
        const next = wakes.shift();
        if (next) return res.end(next);
        return void setTimeout(() => res.end('TIMEOUT'), 1000);
      }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(() => {
  api.close();
  api.closeAllConnections();
  rmSync(tmp, { recursive: true, force: true });
});

/** Sahte `claude`: FAKE_SCRIPT içindeki bash gövdesini çalıştırır. */
function fakeBin(name: string, script: string): string {
  const bin = join(tmp, `bin-${name}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

function startRunner(repo: string, bin: string, env: Record<string, string> = {}): { child: ChildProcess; out: () => string; exited: Promise<number | null> } {
  let out = '';
  const child = spawn('bash', [RUNNER, '--client', 'claude', '--role', 'worker', '--room', 'r', '--repo', repo, '--sessions', '0'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: tmp,
      AGENTS_ROOM_URL: `${base}/mcp`,
      AGENTS_ROOM_TOKEN: 'ar_test',
      AGENTS_ROOM_LOGDIR: join(tmp, 'logs'),
      AGENTS_ROOM_PERMISSIONS: 'restricted',
      AGENTS_ROOM_WAKE_SEC: '1',
      ...env,
    },
  });
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code, sig) => r(code ?? (sig ? 128 : null))));
  return { child, out: () => out, exited };
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`zaman aşımı: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** origin (bare) + agent klonu + görev worktree'si. */
function makeRepo(name: string): { origin: string; repo: string; wt: string; branch: string } {
  const origin = join(tmp, `${name}.git`);
  const seed = join(tmp, `${name}-seed`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  git(tmp, 'init', '-q', '-b', 'main', seed);
  git(seed, 'config', 'user.name', 'seed');
  git(seed, 'config', 'user.email', 'seed@x');
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', origin, 'main');
  const repo = join(tmp, `${name}-w1`);
  git(tmp, 'clone', '-q', origin, repo);
  git(repo, 'config', 'user.name', 'w1');
  git(repo, 'config', 'user.email', 'w1@x');
  const branch = 'ar/r/t1-yarim';
  const wt = join(tmp, `${name}-w1-t1`);
  git(repo, 'worktree', 'add', '-q', wt, '-b', branch, 'origin/main');
  return { origin, repo, wt, branch };
}

test('SIGTERM alan runner kirli çalışma ağacını wip/<dal> dalına push eder, ağaca dokunmaz', { skip }, async () => {
  const { origin, repo, wt, branch } = makeRepo('wip');
  const mark = join(tmp, 'wip-started');
  // Oturum: worktree'de commit edilmemiş değişiklik bırakır ve çalışmaya devam eder.
  const bin = fakeBin('wip', `echo 'yarım iş' > "${wt}/yarim.txt"; echo değişti >> "${wt}/README.md"; touch "${mark}"; sleep 30`);
  wakes = ['WAKE\nWHY THIS SESSION STARTED: test'];
  const r = startRunner(repo, bin);
  await until(() => existsSync(mark), 15_000, 'oturum başlamadı');
  process.kill(-r.child.pid!, 'SIGTERM'); // team.ts/docker gibi süreç grubuna
  const code = await r.exited;
  assert.equal(code, 143, r.out());
  assert.match(r.out(), new RegExp(`wip/${branch}`));
  const ref = spawnSync('git', ['--git-dir', origin, 'rev-parse', '-q', '--verify', `refs/heads/wip/${branch}`], { encoding: 'utf8' });
  assert.equal(ref.status, 0, `wip dalı yok: ${r.out()}`);
  const files = git(tmp, '--git-dir', origin, 'ls-tree', '-r', '--name-only', `wip/${branch}`);
  assert.match(files, /yarim\.txt/);
  assert.equal(git(tmp, '--git-dir', origin, 'show', `wip/${branch}:yarim.txt`), 'yarım iş');
  // Ağaç ve dal olduğu gibi: değişiklikler hâlâ commit edilmemiş, dal ilerlemedi.
  assert.match(git(wt, 'status', '--porcelain'), /yarim\.txt/);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), git(wt, 'rev-parse', 'origin/main'));
  // Temiz ana klon için wip dalı açılmaz.
  assert.equal(spawnSync('git', ['--git-dir', origin, 'rev-parse', '-q', '--verify', 'refs/heads/wip/w1/main']).status, 1);
});

/** Runner'ı durdurur (süreç grubu) ve çıkışını bekler. */
async function stop(r: ReturnType<typeof startRunner>): Promise<void> {
  try {
    process.kill(-r.child.pid!, 'SIGTERM');
  } catch {
    /* zaten çıktı */
  }
  await r.exited;
}

const FAST_ENV = { AGENTS_ROOM_FAST_BACKOFF_SEC: '0', AGENTS_ROOM_SESSION_GAP_SEC: '0', AGENTS_ROOM_TRANSIENT_SEC: '1' };
const wakeN = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `WAKE\nWHY THIS SESSION STARTED: ${tag} ${i}`);
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length : 0);

test('0 kodla hemen biten oturumlar runner\'ı durdurmaz', { skip }, async () => {
  const { repo } = makeRepo('ok');
  const runs = join(tmp, 'ok-runs');
  const bin = fakeBin('ok', `echo run >> "${runs}"; echo '{"type":"result","result":"Nothing to do"}'; exit 0`);
  wakes = wakeN(6, 'ok');
  const r = startRunner(repo, bin, FAST_ENV);
  await until(() => lines(runs) >= 6, 20_000, `6 oturum açılmadı: ${r.out()}`);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.child.exitCode, null, r.out());
  await stop(r);
});

test('art arda 5 giriş (auth) hatası runner\'ı nedeniyle birlikte durdurur', { skip }, async () => {
  const { repo } = makeRepo('auth');
  const bin = fakeBin('auth', `echo '{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1`);
  wakes = wakeN(6, 'auth');
  const r = startRunner(repo, bin, FAST_ENV);
  const code = await Promise.race([r.exited, new Promise((res) => setTimeout(() => res('timeout'), 30_000))]);
  assert.equal(code, 3, r.out());
  assert.match(r.out(), /agent durduruldu/);
  assert.match(r.out(), /Not logged in/);
});

test('OAuth yenileme hatası (geçici) sayaca girmez; oturum yeniden denenir', { skip }, async () => {
  const { repo } = makeRepo('oauth');
  const runs = join(tmp, 'oauth-runs');
  // İlk deneme geçici hatayla biter, ikincisi başarılı.
  const bin = fakeBin(
    'oauth',
    `echo run >> "${runs}"; if [ "$(wc -l < "${runs}")" -le 1 ]; then echo 'Error: Failed to refresh OAuth token'; exit 1; fi; echo '{"type":"result","result":"ok"}'`,
  );
  wakes = wakeN(1, 'oauth');
  const r = startRunner(repo, bin, FAST_ENV);
  await until(() => lines(runs) >= 2, 15_000, `yeniden denenmedi: ${r.out()}`);
  assert.match(r.out(), /geçici hata/);
  assert.doesNotMatch(r.out(), /art arda/);
  assert.equal(r.child.exitCode, null);
  await stop(r);
});

test('kota: runner sunucuya unavailable bildirir, çıkmaz, bekledikten sonra yeniden uyandırma ister', { skip }, async () => {
  const { repo } = makeRepo('quota');
  const bin = fakeBin('quota', `echo '{"type":"result","is_error":true,"result":"Spend limit reached for this organization"}'; exit 1`);
  hits.length = 0;
  wakes = wakeN(1, 'quota');
  const r = startRunner(repo, bin, { ...FAST_ENV, AGENTS_ROOM_QUOTA_SEC: '1' });
  await until(() => hits.some((h) => h.path === '/api/agent/status'), 15_000, `bildirim yok: ${r.out()}`);
  const st = hits.find((h) => h.path === '/api/agent/status')!.body;
  assert.equal(st.state, 'unavailable');
  assert.match(st.reason, /quota: Spend limit reached/);
  assert.ok(st.until > Date.now() - 5000 && st.until < Date.now() + 10_000, String(st.until));
  // Bekleme bitince yeniden uyandırma ister (çıkmaz).
  const n = hits.filter((h) => h.path === '/api/agent/wake').length;
  await until(() => hits.filter((h) => h.path === '/api/agent/wake').length > n, 10_000, 'yeniden beklemeye dönmedi');
  assert.equal(r.child.exitCode, null);
  assert.match(r.out(), /kotası\/limiti doldu/);
  await stop(r);
});
