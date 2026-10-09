// Ortak repo erişimi: token'lı HTTPS git sunucusuna karşı gerçek clone/push (git http-backend + Basic auth).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRED_HELPER,
  cloneFromCache,
  cloneRepo,
  gitLong,
  githubSlug,
  gitEnv,
  normalizeRepo,
  probeRepo,
  redact,
  seedEmptyRepo,
  syncCache,
  workspaceReady,
  type GitAuth,
} from '../../scripts/git-auth.ts';

const TOKEN = 'github_pat_test_123';
let root: string;
let server: ChildProcess;
let base: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ar-gitauth-'));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'proje.git')]);
  spawnSync('git', ['-C', join(root, 'proje.git'), 'config', 'http.receivepack', 'true']);
  // Sunucu ayrı süreçte: testler spawnSync kullandığı için aynı süreçte olay döngüsü bloke olurdu.
  server = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'git-http-server.ts'), root, TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((res) => server.stdout!.once('data', (d: Buffer) => res(d.toString().trim())));
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server.kill();
  rmSync(root, { recursive: true, force: true });
});

test('repo adresi sadeleştirilir; adresteki token ayrılır', () => {
  assert.deepEqual(normalizeRepo('acme/todo'), { url: 'https://github.com/acme/todo.git' });
  assert.deepEqual(normalizeRepo('github.com/acme/todo'), { url: 'https://github.com/acme/todo.git' });
  assert.deepEqual(normalizeRepo('https://x-access-token:ghp_abc@github.com/acme/todo.git'), { url: 'https://github.com/acme/todo.git', token: 'ghp_abc' });
  assert.deepEqual(normalizeRepo('https://ghp_abc@github.com/acme/todo'), { url: 'https://github.com/acme/todo.git', token: 'ghp_abc' });
  assert.deepEqual(normalizeRepo('git@github.com:acme/todo.git'), { url: 'git@github.com:acme/todo.git' });
  assert.deepEqual(githubSlug('git@github.com:acme/todo.git'), { owner: 'acme', repo: 'todo' });
  assert.equal(redact(`fatal: https://${TOKEN}@x`, { kind: 'token', token: TOKEN }), 'fatal: https://***@x');
  assert.equal(gitEnv({ kind: 'token', token: 't' }, 'https://github.com/a/b.git').GH_TOKEN, 't');
  assert.equal(gitEnv({ kind: 'token', token: 't' }, 'https://gitlab.com/a/b.git').GH_TOKEN, undefined);
  assert.match(gitEnv({ kind: 'ssh', sshKey: '/k/id' }).GIT_SSH_COMMAND!, /-i '\/k\/id' -o IdentitiesOnly=yes/);
});

test('token ile: erişim kontrolü, boş repoya ilk commit, klon ve agent gibi push', () => {
  const url = `${base}/proje.git`;
  const auth: GitAuth = { kind: 'token', token: TOKEN };

  const denied = probeRepo(url, { kind: 'token', token: 'yanlis' });
  assert.equal(denied.ok, false);
  assert.doesNotMatch(denied.error!, /yanlis/);

  const p = probeRepo(url, auth);
  assert.equal(p.ok, true, p.error);
  assert.equal(p.empty, true);
  assert.equal(seedEmptyRepo(url, auth, 'oda').ok, true);
  const p2 = probeRepo(url, auth);
  assert.equal(p2.empty, false);
  assert.equal(p2.defaultBranch, 'main');

  const dir = join(root, 'klon');
  const c = cloneRepo(url, dir, auth);
  assert.equal(c.ok, true, c.error);
  // Token klonun ayarlarına ya da uzak adrese yazılmaz.
  const cfg = readFileSync(join(dir, '.git', 'config'), 'utf8');
  assert.doesNotMatch(cfg, new RegExp(TOKEN));
  const helpers = spawnSync('git', ['-C', dir, 'config', '--local', '--get-all', 'credential.helper'], { encoding: 'utf8' }).stdout.split('\n');
  assert.deepEqual(helpers.slice(0, 2), ['', CRED_HELPER]);

  // Agent sonradan yalnızca ortam değişkeniyle push edebilir (makinedeki diğer kimlik yardımcıları devre dışı).
  writeFileSync(join(dir, 'a.txt'), 'merhaba\n');
  const g = (args: string[], env: Record<string, string>) =>
    spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  g(['add', '-A'], {});
  g(['commit', '-qm', 'test'], {});
  const noToken = g(['push', '-q', 'origin', 'HEAD:refs/heads/ar/oda/t1-test'], { GIT_TERMINAL_PROMPT: '0', AGENTS_ROOM_GIT_TOKEN: '' });
  assert.notEqual(noToken.status, 0);
  const push = g(['push', '-q', 'origin', 'HEAD:refs/heads/ar/oda/t1-test'], gitEnv(auth, url));
  assert.equal(push.status, 0, push.stderr);
  const refs = spawnSync('git', ['-C', join(root, 'proje.git'), 'branch', '--list'], { encoding: 'utf8' }).stdout;
  assert.match(refs, /ar\/oda\/t1-test/);
});

test('büyük repo: makine başına tek önbellek, agent kopyaları oradan; origin ortak repo', async () => {
  const url = `${base}/proje.git`;
  const auth: GitAuth = { kind: 'token', token: TOKEN };
  const cache = join(root, 'ws', '.repo-cache.git');
  const lines: string[] = [];
  const s1 = await syncCache(url, cache, auth, (l) => lines.push(l));
  assert.equal(s1.ok, true, s1.error);
  assert.doesNotMatch(readFileSync(join(cache, 'config'), 'utf8'), new RegExp(TOKEN));

  const dir = join(root, 'ws', 'ela');
  const c = await cloneFromCache(url, cache, dir, auth);
  assert.equal(c.ok, true, c.error);
  const git = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(git(['remote', 'get-url', 'origin']).stdout.trim(), url);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main');
  assert.match(git(['branch', '-r']).stdout, /origin\/ar\/oda\/t1-test/);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'b']);
  const push = git(['push', '-q', 'origin', 'HEAD:refs/heads/ar/oda/t2-b'], gitEnv(auth, url));
  assert.equal(push.status, 0, push.stderr);

  // Önbellek güncellenince yeni dal gelir; yanlış anahtarla güncelleme başarısız olur ve token sızmaz.
  const s2 = await syncCache(url, cache, auth);
  assert.equal(s2.ok, true, s2.error);
  assert.match(spawnSync('git', ['-C', cache, 'branch'], { encoding: 'utf8' }).stdout, /ar\/oda\/t2-b/);
  const bad = await syncCache(url, join(root, 'ws', 'yok.git'), { kind: 'token', token: 'yanlis-anahtar' });
  assert.equal(bad.ok, false);
  assert.doesNotMatch(bad.error!, /yanlis-anahtar/);
});

test('klon klasör adı değiştirmeden açılır; yarım kalan kopya baştan açılır, tamamı korunur', async () => {
  const url = `${base}/proje.git`;
  const auth: GitAuth = { kind: 'token', token: TOKEN };
  const ws = join(root, 'ws2');
  const cache = join(ws, '.repo-cache.git');
  mkdirSync(ws, { recursive: true });
  assert.equal((await syncCache(url, cache, auth)).ok, true);
  assert.equal(existsSync(join(ws, '..repo-cache.git.cloning')), false);

  // Konteyner klon sırasında durdurulmuş gibi: yarım klasör + işaret.
  const dir = join(ws, 'mira');
  mkdirSync(join(dir, 'yarim'), { recursive: true });
  writeFileSync(join(ws, '.mira.cloning'), '');
  assert.equal(workspaceReady(dir), false);
  const c = await cloneFromCache(url, cache, dir, auth);
  assert.equal(c.ok, true, c.error);
  assert.equal(workspaceReady(dir), true);
  assert.equal(existsSync(join(dir, 'yarim')), false);
  assert.equal(spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim(), url);

  // Tamamlanmış kopyanın (agent'ın işi) üzerine yazılmaz.
  writeFileSync(join(dir, 'is.txt'), 'x\n');
  const again = await cloneFromCache(url, cache, dir, auth);
  assert.equal(again.ok, false);
  assert.equal(readFileSync(join(dir, 'is.txt'), 'utf8'), 'x\n');

  // Başarısız klon yarım klasör ya da işaret bırakmaz.
  const bad = await cloneFromCache(url, join(ws, 'yok.git'), join(ws, 'ela'), auth);
  assert.equal(bad.ok, false);
  assert.equal(existsSync(join(ws, 'ela')), false);
  assert.equal(existsSync(join(ws, '.ela.cloning')), false);
});

test('takılan git bağlantısı toplam süreyle değil, ilerleme olmamasıyla kesilir', async () => {
  const hang = createServer(() => {}); // bağlantıyı kabul eder, hiç yanıt vermez
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
  const port = (hang.address() as { port: number }).port;
  const t0 = Date.now();
  const r = await gitLong(['ls-remote', `http://127.0.0.1:${port}/x.git`], { auth: { kind: 'none' }, stallMs: 1500 });
  hang.close();
  assert.equal(r.ok, false);
  assert.match(r.error!, /ilerleme yok/);
  assert.ok(Date.now() - t0 < 10_000);
});
