// Git vekili: token'ı yalnız vekil tutar; agent token'sız klonlar ve push eder, başka yollar kapalıdır.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedEmptyRepo } from '../../scripts/git-auth.ts';
import { startGitProxy, type GitProxy } from '../../scripts/git-proxy.ts';

const TOKEN = 'github_pat_proxy_456';
let root: string;
let gitServer: ChildProcess;
let base: string;
let proxy: GitProxy;
const proxies: GitProxy[] = [];
let api: Server;
const apiHits: { method: string; url: string; auth: string; body: string }[] = [];

// Agent gibi: makinedeki kimlik yardımcıları ve ortamdaki token yok.
// Vekil bu süreçte çalıştığı için git asenkron çağrılır (spawnSync olay döngüsünü kilitlerdi).
const agentGit = (cwd: string, ...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const p = spawn('git', ['-c', 'credential.helper=', ...args], { cwd, env: { PATH: process.env.PATH, HOME: root, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
  });

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'ar-gitproxy-'));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'proje.git')]);
  spawnSync('git', ['-C', join(root, 'proje.git'), 'config', 'http.receivepack', 'true']);
  gitServer = spawn(process.execPath, [join(import.meta.dirname, 'fixtures', 'git-http-server.ts'), root, TOKEN], { stdio: ['ignore', 'pipe', 'inherit'] });
  base = `http://127.0.0.1:${await new Promise<string>((res) => gitServer.stdout!.once('data', (d: Buffer) => res(d.toString().trim())))}`;
  assert.equal(seedEmptyRepo(`${base}/proje.git`, { kind: 'token', token: TOKEN }, 'oda').ok, true);
  // Sahte GitHub API: vekilin eklediği kimliği ve yolu kaydeder.
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      apiHits.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), body });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"html_url":"https://github.com/acme/proje/pull/1"}');
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
});

after(async () => {
  for (const p of proxies) await p.close();
  api.close();
  gitServer.kill();
  rmSync(root, { recursive: true, force: true });
});

test('vekil üzerinden token\'sız klon ve push; doğrudan erişim reddedilir', async () => {
  proxy = await startGitProxy({ repoUrl: `${base}/proje.git`, token: TOKEN });
  proxies.push(proxy);
  const dir = join(root, 'agent');
  // Doğrudan (token'sız) klon olmaz.
  assert.notEqual((await agentGit(root, 'clone', '-q', `${base}/proje.git`, join(root, 'dogrudan'))).status, 0);
  // Origin gerçek adres kalır, insteadOf ile vekile gider.
  const c = (await agentGit(root, '-c', `url.${proxy.gitUrl}.insteadOf=${base}/proje.git`, 'clone', '-q', `${base}/proje.git`, dir));
  assert.equal(c.status, 0, c.stderr);
  (await agentGit(dir, 'config', `url.${proxy.gitUrl}.insteadOf`, `${base}/proje.git`));
  assert.equal((await agentGit(dir, 'config', 'remote.origin.url')).stdout.trim(), `${base}/proje.git`);
  writeFileSync(join(dir, 'is.txt'), 'x\n');
  (await agentGit(dir, 'add', '.'));
  (await agentGit(dir, '-c', 'user.name=w1', '-c', 'user.email=w1@x', 'commit', '-qm', 'iş'));
  const p = (await agentGit(dir, 'push', '-q', 'origin', 'HEAD:refs/heads/ar/oda/t1-is'));
  assert.equal(p.status, 0, p.stderr);
  assert.equal(spawnSync('git', ['--git-dir', join(root, 'proje.git'), 'rev-parse', '--verify', '-q', 'ar/oda/t1-is']).status, 0);
  // Vekilde başka yol yok; token hiçbir çıktıda görünmez.
  const other = await fetch(`${proxy.gitUrl.replace(/\/git$/, '')}/x/info/refs`);
  assert.equal(other.status, 404);
  assert.doesNotMatch(c.stderr + p.stderr + (await other.text()), new RegExp(TOKEN));
});

test('GitHub reposunda yalnız bu reponun PR/issue API\'si açılır, token vekilde eklenir', async () => {
  proxy = await startGitProxy({ repoUrl: 'https://github.com/acme/proje.git', token: TOKEN, apiBase: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
  proxies.push(proxy);
  assert.ok(proxy.apiUrl);
  const r = await fetch(`${proxy.apiUrl}/pulls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '[#1] iş', head: 'ar/oda/t1-is', base: 'main' }) });
  assert.equal(r.status, 201);
  assert.match(((await r.json()) as any).html_url, /pull\/1/);
  const hit = apiHits.at(-1)!;
  assert.equal(hit.url, '/repos/acme/proje/pulls');
  assert.equal(hit.auth, `Bearer ${TOKEN}`);
  assert.match(hit.body, /ar\/oda\/t1-is/);
  // Başka uçlar (ör. repo ayarları, başka repo) kapalı.
  assert.equal((await fetch(`${proxy.apiUrl}/../../other/repo`)).status, 404);
  assert.equal((await fetch(`${proxy.apiUrl}/collaborators`)).status, 404);
  assert.equal((await fetch(`${proxy.apiUrl}/pulls`, { method: 'DELETE' })).status, 404);
});
