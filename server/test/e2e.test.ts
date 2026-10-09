// Uçtan uca test: gerçek HTTP sunucusu + gerçek MCP istemcileri (orkestratör + 2 işçi).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../src/db.ts';
import { RoomService, patternsOverlap } from '../src/room.ts';
import { createApp } from '../src/app.ts';

let server: Server;
let base: string;
let svc: RoomService;
const tokens: Record<string, string> = {};
const clients: Record<string, Client> = {};

async function connect(name: string): Promise<Client> {
  const c = new Client({ name: `test-${name}`, version: '0.0.0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens[name]}` } } }),
  );
  return c;
}

async function call(name: string, tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; json: any; isError: boolean }> {
  const r = (await clients[name]!.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]!.text;
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* metin yanıt */
  }
  return { text, json, isError: !!r.isError };
}

before(async () => {
  svc = new RoomService(openDb(':memory:'));
  tokens.orch = svc.createAgent({ name: 'orch', kind: 'claude-code', role: 'orchestrator' }).token;
  tokens.w1 = svc.createAgent({ name: 'w1', kind: 'codex', role: 'worker', capabilities: ['typescript'] }).token;
  tokens.w2 = svc.createAgent({ name: 'w2', kind: 'hermes', role: 'worker', capabilities: ['research'] }).token;
  tokens.admin = svc.createAgent({ name: 'admin', kind: 'human', role: 'admin' }).token;
  const app = createApp(svc, { maxWaitSec: 10, defaultWaitSec: 2, enrollSecret: 'test-secret' });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const n of ['orch', 'w1', 'w2']) clients[n] = await connect(n);
});

after(async () => {
  for (const c of Object.values(clients)) await c.close();
  server.close();
});

test('glob çakışma tespiti', () => {
  assert.ok(patternsOverlap('src/**', 'src/a.ts'));
  assert.ok(patternsOverlap('src/api', 'src/api/x.ts'));
  assert.ok(patternsOverlap('src/*.ts', 'src/index.ts'));
  assert.ok(patternsOverlap('src/**/*.ts', 'src/api/**'));
  assert.ok(!patternsOverlap('src/api/**', 'docs/**'));
  assert.ok(!patternsOverlap('src/*.ts', 'src/api/x.ts'));
});

test('token olmadan MCP reddedilir', async () => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('araç listesi ve kimlik', async () => {
  const tools = await clients.w1!.listTools();
  const names = tools.tools.map((t) => t.name);
  for (const n of ['whoami', 'room_join', 'send_message', 'wait_for_messages', 'plan_create', 'task_next', 'task_complete', 'files_reserve']) {
    assert.ok(names.includes(n), `${n} eksik`);
  }
  const me = await call('w1', 'whoami');
  assert.equal(me.json.agent.name, 'w1');
  assert.equal(me.json.agent.role, 'worker');
});

test('oda, mesajlaşma ve uzun-yoklama uyanması', async () => {
  const room = await call('orch', 'room_create', { name: 'pilot', topic: 'Pilot', repo: 'github.com/acme/todo' });
  assert.equal(room.isError, false);
  for (const n of ['orch', 'w1', 'w2']) await call(n, 'room_join', { room: 'pilot' });

  // önce katılım bildirimlerini tüket
  await call('w1', 'wait_for_messages', { timeout_sec: 0 });
  // w1 beklerken orch mesaj atar → w1 hemen uyanmalı
  const t0 = Date.now();
  const waiting = call('w1', 'wait_for_messages', { timeout_sec: 8, rooms: ['pilot'] });
  await new Promise((r) => setTimeout(r, 300));
  await call('orch', 'send_message', { room: 'pilot', body: 'Merhaba @w1, hazır mısın?' });
  const got = await waiting;
  assert.ok(Date.now() - t0 < 5000, 'long-poll erken uyanmadı');
  assert.match(got.text, /Merhaba @w1/);

  // DM yalnızca alıcıya görünür
  await call('orch', 'send_message', { room: 'pilot', body: 'gizli not', to: 'w2' });
  const w1hist = await call('w1', 'read_messages', { room: 'pilot' });
  assert.doesNotMatch(w1hist.text, /gizli not/);
  const w2hist = await call('w2', 'read_messages', { room: 'pilot' });
  assert.match(w2hist.text, /gizli not/);

  // mentions_only filtresi
  const w2m = await call('w2', 'wait_for_messages', { timeout_sec: 0, mentions_only: true });
  assert.match(w2m.text, /gizli not/);
  assert.doesNotMatch(w2m.text, /Merhaba @w1/);
});

test('token özeti hiçbir yanıtta sızmaz', async () => {
  const agents = await call('w1', 'list_agents');
  assert.doesNotMatch(agents.text, /token_hash/);
  const me = await call('w1', 'whoami');
  assert.doesNotMatch(me.text, /token_hash/);
  const r = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  assert.doesNotMatch(await r.text(), /token_hash/);
});

test('JSON metni olarak gelen diziler kabul edilir; alt görevsiz plan + task_create(parent_id)', async () => {
  const plan = await call('orch', 'plan_create', {
    room: 'pilot',
    goal: 'metin dizili plan',
    subtasks: JSON.stringify([
      { key: 'a', title: 'A işi' },
      { key: 'b', title: 'B işi', depends_on: ['a'] },
    ]),
  });
  assert.equal(plan.isError, false, plan.text);
  const pid = Number(/Plan #(\d+)/.exec(plan.text)![1]);
  const kids = svc.listTasks({ parent_id: pid });
  assert.equal(kids.length, 2);
  assert.deepEqual(kids.find((k) => k.title === 'B işi')!.depends_on, [kids.find((k) => k.title === 'A işi')!.id]);

  const empty = await call('orch', 'plan_create', { room: 'pilot', goal: 'boş plan' });
  const eid = Number(/Plan #(\d+)/.exec(empty.text)![1]);
  const t = await call('orch', 'task_create', { room: 'pilot', title: 'sonradan eklenen', parent_id: eid, capabilities: 'typescript', depends_on: '[]' });
  assert.equal(t.isError, false, t.text);
  assert.deepEqual(t.json.capabilities, ['typescript']);
  for (const id of [pid, eid]) svc.review('orch', id, { action: 'cancel' });
  // plan iptali alt görevlere yayılır
  for (const k of [...kids, t.json]) assert.equal(svc.getTask(k.id)!.status, 'cancelled');
});

test('işçi plan_create kullanamaz', async () => {
  const r = await call('w1', 'plan_create', { room: 'pilot', goal: 'x', subtasks: [{ key: 'a', title: 'aaa' }] });
  assert.equal(r.isError, true);
});

test('plan → dağıtım → bağımlılık → tamamlama → üst görev bildirimi', async () => {
  const plan = await call('orch', 'plan_create', {
    room: 'pilot',
    goal: 'Todo CLI uygulaması',
    subtasks: [
      { key: 'core', title: 'Veri modeli ve depolama', capabilities: ['typescript'] },
      { key: 'cli', title: 'CLI komutları', depends_on: ['core'], assignee: 'w1' },
      { key: 'docs', title: 'Benzer araçları araştır ve README yaz', capabilities: ['research'] },
    ],
  });
  assert.equal(plan.isError, false, plan.text);
  const parentId = svc.listTasks({ room: 'pilot' }).find((t) => t.title === 'Todo CLI uygulaması')!.id;
  const kids = svc.listTasks({ parent_id: parentId });
  assert.equal(kids.length, 3);
  const core = kids.find((k) => k.title.startsWith('Veri'))!;
  const cli = kids.find((k) => k.title.startsWith('CLI'))!;

  // w2 (research) core'u alamaz (yetenek yok), docs'u alır
  const n2 = await call('w2', 'task_next', { room: 'pilot' });
  assert.match(n2.json.title, /araştır/);

  // w1: kendisine atanmış cli bağımlılık yüzünden alınamaz → core'u alır
  const n1 = await call('w1', 'task_next', { room: 'pilot' });
  assert.equal(n1.json.id, core.id);
  const direct = await call('w1', 'task_claim', { id: cli.id });
  assert.equal(direct.isError, true);
  assert.match(direct.text, /dependencies/);

  // yarış: w2 core'u almaya çalışır
  const steal = await call('w2', 'task_claim', { id: core.id });
  assert.equal(steal.isError, true);

  // dosya rezervasyonu çakışması
  const r1 = await call('w1', 'files_reserve', { repo: 'github.com/acme/todo', paths: ['src/store/**'], task_id: core.id });
  assert.equal(r1.json.granted.length, 1);
  const r2 = await call('w2', 'files_reserve', { repo: 'github.com/acme/todo', paths: ['src/store/db.ts'] });
  assert.match(r2.text, /CONFLICT/);

  await call('w1', 'task_update', { id: core.id, progress: 'şema yazıldı', branch: 'ar/pilot/t2-core' });
  const done = await call('w1', 'task_complete', {
    id: core.id,
    result: 'Depolama katmanı eklendi, testler geçti',
    artifacts: [{ type: 'branch', ref: 'ar/pilot/t2-core' }],
  });
  assert.equal(done.json.status, 'done');
  // görev bitince rezervasyon serbest
  assert.equal(svc.listReservations({ repo: 'github.com/acme/todo' }).length, 0);

  // artık cli alınabilir
  const n1b = await call('w1', 'task_next', { room: 'pilot' });
  assert.equal(n1b.json.id, cli.id);
  await call('w1', 'task_complete', { id: cli.id, result: 'CLI tamam' });
  await call('w2', 'task_complete', { id: n2.json.id, result: 'README yazıldı' });

  // orkestratör "tüm alt görevler bitti" bildirimini almalı
  const note = await call('orch', 'wait_for_messages', { timeout_sec: 1, mentions_only: true });
  assert.match(note.text, /All subtasks .* are finished/);

  const tree = await call('orch', 'task_tree', { id: parentId });
  assert.equal(tree.json.children.length, 3);
  assert.ok(tree.json.children.every((c: any) => c.status === 'done'));

  await call('orch', 'task_complete', { id: parentId, result: 'Pilot tamamlandı' });
});

test('kiralama süresi dolunca görev geri açılır', async () => {
  const t = await call('orch', 'task_create', { room: 'pilot', title: 'Uzun iş' });
  const c = await call('w2', 'task_claim', { id: t.json.id, lease_minutes: 5 });
  assert.equal(c.json.status, 'claimed');
  svc.db.prepare('UPDATE tasks SET lease_until = ? WHERE id = ?').run(Date.now() - 1000, t.json.id);
  svc.sweep();
  const after = svc.getTask(t.json.id)!;
  assert.equal(after.status, 'open');
  assert.equal(after.assignee, null);
});

test('panel API: yetki ve durum', async () => {
  const unauth = await fetch(base + '/api/state');
  assert.equal(unauth.status, 401);
  const w = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${tokens.w1}` } });
  assert.equal(w.status, 403);
  const a = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const s = (await a.json()) as any;
  assert.ok(s.agents.length >= 4);
  assert.ok(s.tasks.length >= 4);
  // insan panelden mesaj yazar
  const m = await fetch(base + '/api/rooms/pilot/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'İnsan gözetmen burada' }),
  });
  assert.equal(m.status, 200);
});

test('boşta kalan bağlantıdan sonra çağrı gecikmez (keep-alive regresyonu)', async () => {
  await call('w1', 'whoami');
  await new Promise((r) => setTimeout(r, 800));
  const t0 = Date.now();
  await call('w1', 'whoami');
  assert.ok(Date.now() - t0 < 1000, `ikinci çağrı ${Date.now() - t0}ms sürdü`);
});

test('mesaj geçmişi before_id ile sayfalanır', async () => {
  svc.createRoom('sayfa', null, null, 'admin');
  for (let i = 1; i <= 12; i++) svc.send('orch', { room: 'sayfa', body: `mesaj ${i}` });
  const H = { Authorization: `Bearer ${tokens.admin}` };
  const last = (await (await fetch(base + '/api/rooms/sayfa/messages?limit=5', { headers: H })).json()) as any[];
  assert.deepEqual(last.map((m) => m.body), ['mesaj 8', 'mesaj 9', 'mesaj 10', 'mesaj 11', 'mesaj 12']);
  const older = (await (await fetch(base + `/api/rooms/sayfa/messages?limit=5&before_id=${last[0].id}`, { headers: H })).json()) as any[];
  assert.deepEqual(older.map((m) => m.body), ['mesaj 3', 'mesaj 4', 'mesaj 5', 'mesaj 6', 'mesaj 7']);
  const mcp = await call('w1', 'read_messages', { room: 'sayfa', before_id: older[0].id, limit: 10 });
  assert.match(mcp.text, /mesaj 1\b/);
  assert.doesNotMatch(mcp.text, /mesaj 3\b/);
});

test('oda kapatma: görevler iptal, yazma reddedilir, agent durmaya yönlendirilir, yeniden açılır', async () => {
  svc.createRoom('kapanacak', 'geçici', null, 'admin');
  await call('w2', 'room_join', { room: 'kapanacak' });
  await call('w2', 'wait_for_messages', { timeout_sec: 0 });
  const t = await call('orch', 'task_create', { room: 'kapanacak', title: 'yarım iş' });
  await call('w2', 'task_claim', { id: t.json.id });
  const H = { Authorization: `Bearer ${tokens.admin}`, 'content-type': 'application/json' };

  const lobby = await fetch(base + '/api/rooms/lobby/close', { method: 'POST', headers: H, body: '{}' });
  assert.equal(lobby.status, 400);
  const byWorker = await fetch(base + '/api/rooms/kapanacak/close', { method: 'POST', headers: { ...H, Authorization: `Bearer ${tokens.w1}` }, body: '{}' });
  assert.equal(byWorker.status, 403);
  const r = await fetch(base + '/api/rooms/kapanacak/close', { method: 'POST', headers: H, body: JSON.stringify({ reason: 'iş bitti' }) });
  assert.equal(r.status, 200);

  assert.equal(svc.getTask(t.json.id)!.status, 'cancelled');
  const send = await call('w2', 'send_message', { room: 'kapanacak', body: 'merhaba?' });
  assert.equal(send.isError, true);
  assert.match(send.text, /closed/);
  // önce kapanış bildirimi, sonra açık "dur" talimatı
  const w1 = await call('w2', 'wait_for_messages', { timeout_sec: 1, rooms: ['kapanacak'] });
  assert.match(w1.text, /Room closed by admin: iş bitti/);
  const w2 = await call('w2', 'wait_for_messages', { timeout_sec: 1, rooms: ['kapanacak'] });
  assert.match(w2.text, /All of your rooms are closed/);
  // MCP oda listesinde görünmez, panelde görünür
  const list = await call('w2', 'room_list');
  assert.doesNotMatch(list.text, /kapanacak/);
  const st = (await (await fetch(base + '/api/state', { headers: H })).json()) as any;
  assert.ok(st.rooms.find((x: any) => x.name === 'kapanacak').closed_at);

  const re = await fetch(base + '/api/rooms/kapanacak/reopen', { method: 'POST', headers: H, body: '{}' });
  assert.equal(re.status, 200);
  assert.equal((await call('w2', 'send_message', { room: 'kapanacak', body: 'tekrar açık' })).isError, false);
});

test('kayıt (enroll): sır kontrolü, oda oluşturma, bilgi ucu', async () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await post('/api/enroll', { secret: 'yanlis', name: 'x1' })).status, 403);
  assert.equal((await post('/api/enroll', { secret: 'test-secret', name: 'hack', role: 'admin' })).status, 403);
  assert.equal((await post('/api/enroll', { secret: 'test-secret', name: 'admin' })).status, 403);

  const r = await post('/api/enroll', { secret: 'test-secret', name: 'remote-claude-1', kind: 'claude-code', role: 'worker', room: 'uzak-oda', topic: 'Uzak ekip', repo: 'https://github.com/acme/x.git' });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.match(j.token, /^ar_/);
  assert.equal(j.room.name, 'uzak-oda');
  assert.equal(j.room.repo, 'https://github.com/acme/x.git');
  assert.ok(svc.authenticate(j.token));

  // admin token'ı da sır yerine geçer
  const a = await post('/api/enroll', { name: 'remote-orch', role: 'orchestrator', room: 'uzak-oda' }, { Authorization: `Bearer ${tokens.admin}` });
  assert.equal(a.status, 200);

  const info = (await (await post('/api/enroll/info', { secret: 'test-secret' })).json()) as any;
  assert.ok(info.rooms.some((x: any) => x.name === 'uzak-oda'));
  assert.ok(info.agents.some((x: any) => x.name === 'remote-orch'));
  assert.doesNotMatch(JSON.stringify(info), /token/);
});

test('istişare: davet, gelen kutusu notu, oylama doğrulaması, bekleme, karar ve plana bağlama', async () => {
  svc.createRoom('istisare', 'fikir alışverişi', null, 'admin');
  for (const n of ['orch', 'w1', 'w2']) await call(n, 'room_join', { room: 'istisare' });
  const open = await call('orch', 'consult_open', {
    room: 'istisare',
    question: 'Taslak plan: core + cli + docs. Depolama için ne kullanalım?',
    options: ['json', 'sqlite'],
    timeout_sec: 60,
  });
  assert.equal(open.isError, false, open.text);
  const id = Number(open.text.match(/Opened C(\d+)/)![1]);
  assert.deepEqual([...svc.getConsult(id)!.invitees].sort(), ['w1', 'w2']);

  // Çalışan işçi başka bir araç çağrısında bekleyen istişareyi görür (ayrı içerik parçası).
  const r = (await clients.w1!.callTool({ name: 'task_list', arguments: { room: 'istisare' } })) as { content: { text: string }[] };
  assert.equal(r.content.length, 2);
  assert.match(r.content[1]!.text, new RegExp(`C${id}`));
  const who = await call('w1', 'whoami');
  assert.equal(who.json.awaiting_my_reply[0].id, id);

  const bad = await call('w1', 'consult_reply', { id, body: 'mongo', choice: 'mongo' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /json, sqlite/);
  const self = await call('orch', 'consult_reply', { id, body: 'x', choice: 'json' });
  assert.equal(self.isError, true);

  const waiting = call('orch', 'consult_get', { id, wait_sec: 5 });
  await call('w1', 'consult_reply', { id, body: 'Tek dosya yeter', choice: 'JSON' });
  await call('w2', 'consult_reply', { id, body: 'Eşzamanlılık için', choice: 'sqlite' });
  await call('w2', 'consult_reply', { id, body: 'Fikrimi değiştirdim, json yeter', choice: 'json' });
  const got = await waiting;
  assert.match(got.text, /Replies \(2\/2\)/);
  assert.equal(svc.consultView(id).pending.length, 0);
  assert.equal(svc.consultView(id).tally.json, 2);
  assert.match((await call('orch', 'consult_get', { id })).text, /w2 → json: Fikrimi/);
  assert.ok(svc.history(null, 'istisare', { limit: 10 }).some((m) => m.body.startsWith(`📥 Everyone answered C${id}`)));

  const notMine = await call('w1', 'consult_close', { id, decision: 'json' });
  assert.equal(notMine.isError, true);
  const closed = await call('orch', 'consult_close', { id, decision: 'JSON dosyası; iki işçi de onayladı' });
  assert.equal(closed.isError, false, closed.text);
  assert.equal((await call('w1', 'consult_reply', { id, body: 'geç', choice: 'json' })).isError, true);
  assert.equal(svc.pendingConsults('w1').length, 0);

  const plan = await call('orch', 'plan_create', { room: 'istisare', goal: 'İstişareli plan', consult_id: id, subtasks: [{ key: 'a', title: 'aaa' }] });
  assert.equal(plan.isError, false, plan.text);
  assert.doesNotMatch(plan.text, /no consult_id/);
  const parent = svc.listTasks({ room: 'istisare' }).find((t) => t.title === 'İstişareli plan')!;
  assert.match(parent.description, new RegExp(`C${id} → JSON`));
  assert.equal(svc.getConsult(id)!.task_id, parent.id);
  const noConsult = await call('orch', 'plan_create', { room: 'istisare', goal: 'Danışmasız plan' });
  assert.match(noConsult.text, /no consult_id/);
  for (const t of svc.listTasks({ room: 'istisare' })) svc.review('admin', t.id, { action: 'cancel' });
});

test('başkan: tek orkestratör geçici başkan, ikinci gelince seçim, yetki, alt plan devri, devir ve istifa', async () => {
  for (const n of ['o1', 'o2']) {
    tokens[n] = svc.createAgent({ name: n, kind: 'claude-code', role: 'orchestrator' }).token;
    clients[n] = await connect(n);
  }
  svc.createRoom('baskan', 'liderlik', null, 'admin');
  await call('w1', 'room_join', { room: 'baskan' });
  const j1 = await call('o1', 'room_join', { room: 'baskan' });
  assert.match(j1.text, /Chair: @o1 \(that is you\)/);
  assert.equal(svc.getRoom('baskan')!.chair_by, 'sole');

  await call('o2', 'room_join', { room: 'baskan' });
  const el = svc.openElection('baskan')!;
  assert.ok(el, 'ikinci orkestratör gelince seçim açılmalı');
  assert.deepEqual(el.options, ['o1', 'o2']);
  const during = await call('o1', 'plan_create', { room: 'baskan', goal: 'erken plan' });
  assert.equal(during.isError, true);
  assert.match(during.text, /election is running/);
  assert.equal((await call('w1', 'consult_reply', { id: el.id, body: 'ben de', choice: 'o1' })).isError, true);

  await call('o1', 'consult_reply', { id: el.id, body: 'o2 bu alanı daha iyi biliyor', choice: 'o2' });
  await call('o2', 'consult_reply', { id: el.id, body: 'kabul', choice: 'o2' });
  assert.equal(svc.chairOf('baskan'), 'o2');
  assert.equal(svc.getRoom('baskan')!.chair_by, 'election');
  assert.match(svc.getConsult(el.id)!.decision!, /o2 elected chair \(votes: o1 0, o2 2\)/);

  const denied = await call('o1', 'plan_create', { room: 'baskan', goal: 'izinsiz plan' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /Only the chair \(@o2\)/);
  const delegated = await call('o2', 'task_create', { room: 'baskan', title: 'Arayüz alt planı', assignee: 'o1' });
  const sub = await call('o1', 'plan_create', { room: 'baskan', goal: 'Arayüz', parent_id: delegated.json.id, subtasks: [{ key: 'ui', title: 'ekran' }] });
  assert.equal(sub.isError, false, sub.text);
  assert.equal(svc.listTasks({ room: 'baskan' }).find((t) => t.title === 'Arayüz')!.parent_id, delegated.json.id);

  assert.equal((await call('o1', 'chair', { room: 'baskan', action: 'transfer', to: 'o1' })).isError, true);
  await call('o2', 'chair', { room: 'baskan', action: 'transfer', to: 'o1' });
  assert.equal(svc.chairOf('baskan'), 'o1');
  const st = await call('w1', 'chair', { room: 'baskan' });
  assert.match(st.text, /Chair of #baskan: @o1/);
  assert.equal((await call('w1', 'chair', { room: 'baskan', action: 'elect' })).isError, true);
  const rs = await call('o1', 'chair', { room: 'baskan', action: 'resign' });
  assert.match(rs.text, /Chair of #baskan: @o2/);

  // Başkan masadan kalkarsa koltuk diğer orkestratöre geçer.
  await call('o2', 'room_leave', { room: 'baskan' });
  assert.equal(svc.chairOf('baskan'), 'o1');
  for (const t of svc.listTasks({ room: 'baskan' })) if (!['done', 'cancelled'].includes(t.status)) svc.review('admin', t.id, { action: 'cancel' });
});

test('başkan seçimi süresi dolunca: oy yoksa masaya ilk gelen kazanır; istişare süresi dolunca soran uyarılır', async () => {
  svc.createRoom('secim', null, null, 'admin');
  await call('o2', 'room_join', { room: 'secim' });
  await call('o1', 'room_join', { room: 'secim' });
  const el = svc.openElection('secim')!;
  assert.deepEqual(el.options, ['o2', 'o1']);
  svc.db.prepare('UPDATE consults SET deadline = ? WHERE id = ?').run(Date.now() - 1, el.id);
  svc.sweep();
  assert.equal(svc.chairOf('secim'), 'o2');

  await call('w1', 'room_join', { room: 'secim' });
  const c = await call('o2', 'consult_open', { room: 'secim', question: 'Bu yaklaşım hakkında ne düşünüyorsunuz?', ask: ['w1'] });
  const cid = Number(c.text.match(/Opened C(\d+)/)![1]);
  svc.db.prepare('UPDATE consults SET deadline = ? WHERE id = ?').run(Date.now() - 1, cid);
  svc.sweep();
  svc.sweep();
  const nudges = svc.history(null, 'secim', { limit: 20 }).filter((m) => m.body.startsWith(`⌛ C${cid} deadline passed`));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0]!.body, /silent: w1/);
});

test('oda notları: orkestratör yazar, işçi kısa bilgi ekler, room_join gösterir, boyut sınırı', async () => {
  svc.createRoom('notlar', null, null, 'admin');
  const set = await call('orch', 'room_notes', { room: 'notlar', action: 'set', body: '# Harita\n- src/api: HTTP katmanı\n- test: npm test' });
  assert.equal(set.isError, false, set.text);
  const denied = await call('w1', 'room_notes', { room: 'notlar', action: 'set', body: 'her şeyi sil' });
  assert.equal(denied.isError, true);
  const app = await call('w1', 'room_notes', { room: 'notlar', action: 'append', body: 'e2e testleri için önce npm run build' });
  assert.equal(app.isError, false, app.text);
  const got = await call('w2', 'room_notes', { room: 'notlar' });
  assert.match(got.text, /src\/api: HTTP katmanı/);
  assert.match(got.text, /- e2e testleri için önce npm run build \(w1\)$/);
  const join = await call('w2', 'room_join', { room: 'notlar' });
  assert.match(join.text, /room notes[\s\S]*src\/api: HTTP katmanı/);
  assert.equal(svc.getRoom('notlar')!.has_notes, true);
  assert.equal('notes' in svc.getRoom('notlar')!, false);
  const big = await call('orch', 'room_notes', { room: 'notlar', action: 'set', body: 'x'.repeat(13_000) });
  assert.equal(big.isError, true);
  assert.match(big.text, /max 12000/);
});

test('uyandırma: model oturumu olmadan bekler; görev, bahsetme, insan mesajı ve kapanış uyandırır', async () => {
  tokens.uw = svc.createAgent({ name: 'uw', kind: 'claude-code', role: 'worker', capabilities: ['typescript'] }).token;
  tokens.uo = svc.createAgent({ name: 'uo', kind: 'claude-code', role: 'orchestrator' }).token;
  svc.createRoom('uyku', null, null, 'admin');
  const wake = (name: string, body: Record<string, unknown>) =>
    fetch(base + '/api/agent/wake', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens[name]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'uyku', ...body }),
    }).then(async (r) => ({ status: r.status, text: await r.text() }));

  assert.equal((await fetch(base + '/api/agent/wake', { method: 'POST' })).status, 401);
  assert.equal((await wake('admin', { timeout_sec: 0 })).status, 403);

  // İlk çağrı odaya katılır; yapılacak bir şey yoksa model oturumu açılmaz.
  assert.equal((await wake('uw', { timeout_sec: 0 })).text, 'TIMEOUT\n');
  assert.ok(svc.roomsOf('uw').includes('uyku'));
  assert.match(svc.getAgent('uw')!.activity ?? '', /no model session/);

  // Bekleyen işçi, alınabilir bir görev açılınca uyanır.
  const pending = wake('uw', { timeout_sec: 5 });
  await new Promise((r) => setTimeout(r, 100));
  const t = svc.createTask('admin', { room: 'uyku', title: 'API ucu', capabilities: ['typescript'] });
  const w1 = await pending;
  assert.match(w1.text, /^WAKE\n/);
  assert.match(w1.text, new RegExp(`Claimable tasks for you: #${t.id} "API ucu"`));

  // Alınmış ama bitmemiş görev (oturum kapandı/çöktü) uyandırır; "blocked" işçi ise yalnızca mesajla uyanır.
  svc.claim('uw', t.id);
  assert.match((await wake('uw', { timeout_sec: 0 })).text, new RegExp(`unfinished tasks: #${t.id}`));
  svc.setStatus('uw', 'blocked', 'soru sordu');
  assert.equal((await wake('uw', { timeout_sec: 0 })).text, 'TIMEOUT\n');
  svc.send('uo', { room: 'uyku', body: '@uw arayüz src/api/index.ts içinde' });
  const w2 = await wake('uw', { timeout_sec: 0 });
  assert.match(w2.text, /Messages for you[\s\S]*<uo> @uw arayüz src\/api\/index.ts içinde/);
  // Tetikleyen mesaj okundu sayıldı: ikinci bir oturum açtırmaz.
  assert.equal((await wake('uw', { timeout_sec: 0 })).text, 'TIMEOUT\n');

  // İnsan odaya yazınca (bahsetmeden) orkestratör uyanır, işçi uyanmaz.
  svc.complete('uw', t.id, { result: 'tamam' });
  svc.setStatus('uw', 'idle');
  await wake('uo', { timeout_sec: 0 });
  svc.send('admin', { room: 'uyku', body: 'Hedef: giriş sayfası' });
  assert.equal((await wake('uw', { timeout_sec: 0 })).text, 'TIMEOUT\n');
  assert.match((await wake('uo', { timeout_sec: 0 })).text, /<admin> Hedef: giriş sayfası/);

  // immediate: sebep olmasa da oturum açılır (hedefle başlayan orkestratör); oda kapanınca CLOSED.
  assert.match((await wake('uo', { timeout_sec: 0, immediate: true })).text, /^WAKE\nWHY THIS SESSION STARTED: session start/);
  svc.closeRoom('uyku', 'admin');
  assert.equal((await wake('uw', { timeout_sec: 0 })).text, 'CLOSED\n');
});
