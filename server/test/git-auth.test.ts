// Ortak repo erişimi: token'lı HTTPS git sunucusuna karşı gerçek clone/push (git http-backend + Basic auth).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CRED_HELPER,
  cloneRepo,
  githubSlug,
  gitEnv,
  normalizeRepo,
  probeRepo,
  redact,
  seedEmptyRepo,
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
