// Çalışan bir sunucuya karşı sahte agent'larla uçtan uca senaryo çalıştırır (duman testi + panel demosu).
//   AGENTS_ROOM_URL=http://127.0.0.1:7700 AGENTS_ROOM_ADMIN_TOKEN=$(cat data/admin.token) node scripts/simulate.ts [--slow]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.AGENTS_ROOM_URL ?? 'http://127.0.0.1:7700';
const ADMIN = process.env.AGENTS_ROOM_ADMIN_TOKEN;
const SLOW = process.argv.includes('--slow') ? 1500 : 50;
if (!ADMIN) throw new Error('AGENTS_ROOM_ADMIN_TOKEN gerekli');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admin(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function agent(name: string, kind: string, role: string, capabilities: string[]) {
  const { token } = await admin('/api/agents', { name, kind, role, capabilities, machine: `sim-${kind}` });
  const c = new Client({ name: `sim-${name}`, version: '0.1.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const r = (await c.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    if (process.env.DEBUG) console.log(`${name}.${tool} ${Date.now() - t0}ms`);
    const text = r.content[0]!.text;
    if (r.isError) throw new Error(`${name}.${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { name, call, close: () => c.close() };
}

const ROOM = 'sim-' + new Date().toISOString().slice(11, 19).replaceAll(':', '');
const REPO = 'github.com/demo/todo-cli';

const orch = await agent('sim-orchestrator', 'claude-code', 'orchestrator', ['planning', 'review']);
const w1 = await agent('sim-codex', 'codex', 'worker', ['typescript', 'testing']);
const w2 = await agent('sim-hermes', 'hermes', 'worker', ['research', 'docs']);
const w3 = await agent('sim-claude', 'claude-code', 'worker', ['typescript']);
const workers = [w1, w2, w3];

await orch.call('room_create', { name: ROOM, topic: 'Simülasyon: Todo CLI', repo: REPO });
for (const a of [orch, ...workers]) await a.call('room_join', { room: ROOM });
await orch.call('send_message', { room: ROOM, body: 'Herkese merhaba. Todo CLI için plan hazırlıyorum.' });
await sleep(SLOW);

const plan = await orch.call('plan_create', {
  room: ROOM,
  goal: 'Todo CLI (TypeScript) — ekle/listele/tamamla',
  subtasks: [
    { key: 'core', title: 'Depolama katmanı (JSON dosya)', capabilities: ['typescript'], description: 'src/store/** — kabul: birim testleri' },
    { key: 'cli', title: 'CLI komutları', depends_on: ['core'], capabilities: ['typescript'], description: 'src/cli/**' },
    { key: 'tests', title: 'Uçtan uca testler', depends_on: ['cli'], capabilities: ['testing'] },
    { key: 'docs', title: 'Benzer araç araştırması + README', capabilities: ['research'] },
  ],
});
const planId = Number(/Plan #(\d+)/.exec(String(plan))![1]);
console.log('plan oluşturuldu:', planId);

async function workLoop(w: Awaited<ReturnType<typeof agent>>) {
  let idle = 0;
  while (idle < 4) {
    const t = await w.call('task_next', { room: ROOM });
    if (!t || typeof t === 'string') {
      idle++;
      await w.call('wait_for_messages', { timeout_sec: 2 });
      continue;
    }
    idle = 0;
    const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24);
    const branch = `ar/${ROOM}/t${t.id}-${slug}`;
    await w.call('files_reserve', { repo: REPO, paths: [`src/t${t.id}/**`], task_id: t.id, reason: t.title });
    await w.call('task_update', { id: t.id, progress: 'başladım', branch });
    await sleep(SLOW * 2);
    await w.call('task_update', { id: t.id, progress: 'testler çalışıyor' });
    await sleep(SLOW);
    await w.call('task_complete', { id: t.id, result: `${t.title} tamamlandı (simülasyon)`, artifacts: [{ type: 'branch', ref: branch }] });
  }
  await w.call('heartbeat', { status: 'idle', activity: 'görev kalmadı' });
}

await Promise.all(workers.map(workLoop));
const tree = await orch.call('task_tree', { id: planId });
const ok = tree.children.every((c: any) => c.status === 'done');
await orch.call('task_complete', { id: planId, result: `Tüm alt görevler bitti: ${tree.children.map((c: any) => '#' + c.id).join(', ')}` });
await orch.call('send_message', { room: ROOM, body: `Plan #${planId} kapandı. ${ok ? 'Hepsi başarılı.' : 'Bazı görevler başarısız.'}` });
for (const a of [orch, ...workers]) await a.close();
console.log(ok ? `✅ simülasyon başarılı (oda: ${ROOM})` : '❌ simülasyon başarısız');
process.exit(ok ? 0 : 1);
