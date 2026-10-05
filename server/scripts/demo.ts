// Panel demosu ve README ekran görüntüleri için örnek bir masa kurar ve agent'ları çevrimiçi tutar (Ctrl+C ile çıkış).
//   AGENTS_ROOM_URL=http://127.0.0.1:7700 AGENTS_ROOM_ADMIN_TOKEN=$(cat data/admin.token) node scripts/demo.ts
// Gerçek LLM çalışmaz: mesajlar, danışma, oylama, plan ve görev durumları sabit bir senaryodan gelir.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.AGENTS_ROOM_URL ?? 'http://127.0.0.1:7700';
const ADMIN = process.env.AGENTS_ROOM_ADMIN_TOKEN;
if (!ADMIN) throw new Error('AGENTS_ROOM_ADMIN_TOKEN gerekli');
const ROOM = process.env.DEMO_ROOM ?? 'todo-app';
const REPO = 'github.com/acme/todo-app';
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, body: unknown) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function agent(name: string, kind: string, role: string, capabilities: string[], machine: string) {
  const { token } = await api('/api/agents', { name, kind, role, capabilities, machine });
  const c = new Client({ name: `demo-${name}`, version: '0.1.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<any> => {
    const r = (await c.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0]!.text;
    if (r.isError) throw new Error(`${name}.${tool}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { name, call };
}

const say = (a: { call: (t: string, x: Record<string, unknown>) => Promise<any> }, body: string, extra: Record<string, unknown> = {}) =>
  a.call('send_message', { room: ROOM, body, ...extra });
const idOf = (r: any) => (typeof r === 'object' ? r.id : Number(String(r).match(/#?(\d+)/)?.[1]));

const defne = await agent('defne', 'claude-code', 'orchestrator', ['planning', 'review', 'research'], 'mac-studio');
const can = await agent('can', 'claude-code', 'worker', ['typescript', 'sql', 'testing'], 'mac-studio');
const beren = await agent('beren', 'codex', 'worker', ['typescript', 'api', 'testing'], 'notebook-2');
const ilgaz = await agent('ilgaz', 'gemini', 'worker', ['search', 'sql', 'research'], 'notebook-2');
const elif = await agent('elif', 'hermes', 'worker', ['react', 'css', 'docs'], 'linux-box');
const team = [defne, can, beren, ilgaz, elif];

await defne.call('room_create', { name: ROOM, topic: 'Todo uygulamasına etiketler ve arama', repo: REPO });
for (const a of team) await a.call('room_join', { room: ROOM });
await defne.call('heartbeat', { status: 'working', activity: 'planı yönetiyor' });

await api(`/api/rooms/${ROOM}/messages`, {
  body: 'Hedef: görevlere **etiket** eklenebilsin ve görevler başlık + etiketle **aranabilsin**. Testler geçsin, her iş için ayrı PR açılsın.',
});
await pause();
await say(defne, 'Merhaba! Masada 4 işçi var: @can @beren @ilgaz @elif. Taslak planı yazmadan önce sizlere danışıyorum.');

const draft = await defne.call('consult_open', {
  room: ROOM,
  question:
    'Taslak plan: (1) db: tags + task_tags tabloları ve migration — can; (2) api: /tags uçları ve görev filtreleri — beren; (3) search: başlık + etiket araması — ilgaz; (4) ui: etiket seçici ve arama kutusu — elif; (5) testler ve dokümantasyon. Eksik ya da riskli bir şey var mı, işleri böyle bölmek mantıklı mı?',
  timeout_sec: 600,
});
const draftId = idOf(draft);
await pause();
await can.call('consult_reply', { id: draftId, body: 'Mantıklı. Migration geri alınabilir olsun; db işi bitmeden api başlamasın.' });
await beren.call('consult_reply', { id: draftId, body: 'api için db şemasını bekliyorum. Filtre parametresi `?tag=` olsun, çoklu etiket virgülle.' });
await ilgaz.call('consult_reply', { id: draftId, body: 'Aramayı SQLite FTS5 ile yapabilirim; arama yöntemini masada oylayalım.' });
await elif.call('consult_reply', { id: draftId, body: 'ui, api uçlarına bağlı. Etiket renkleri için tasarım tokenlarını kullanacağım.' });
await defne.call('consult_close', { id: draftId, decision: 'Plan onaylandı: db → api → ui sırası; arama ayrı yürür, yöntemi oylamayla seçilecek.' });

const plan = await defne.call('plan_create', {
  room: ROOM,
  goal: 'Etiketler ve arama',
  consult_id: draftId,
  subtasks: [
    { key: 'db', title: 'tags ve task_tags tabloları, migration', assignee: 'can', priority: 2 },
    { key: 'api', title: '/tags uçları ve ?tag= filtresi', assignee: 'beren', priority: 2, depends_on: ['db'] },
    { key: 'search', title: 'Başlık ve etiket araması', assignee: 'ilgaz', priority: 1 },
    { key: 'ui', title: 'Etiket seçici ve arama kutusu', assignee: 'elif', priority: 1, depends_on: ['api'] },
    { key: 'docs', title: 'Testler ve README güncellemesi', priority: 0, depends_on: ['api', 'search', 'ui'] },
  ],
});
const planId = Number(/Plan #(\d+)/.exec(String(plan))![1]);
const tasks: any[] = await defne.call('task_list', { room: ROOM });
const prefix: Record<string, string> = { db: 'tags ve', api: '/tags', search: 'Başlık', ui: 'Etiket seçici', docs: 'Testler' };
const sub = (key: string) => tasks.find((t) => t.title.startsWith(prefix[key]!)).id as number;
await say(defne, `Plan #${planId} yayında. Sıra: db → api → ui; arama paralel yürüyor.`);

// db: bitti
await can.call('task_claim', { id: sub('db') });
await can.call('files_reserve', { repo: REPO, paths: ['src/db/**', 'migrations/**'], task_id: sub('db'), reason: 'etiket şeması' });
await can.call('task_update', { id: sub('db'), status: 'in_progress', branch: 'ar/todo-app/t' + sub('db') + '-tags-schema', progress: 'migration yazıldı' });
await can.call('task_complete', {
  id: sub('db'),
  result: '`tags` ve `task_tags` tabloları eklendi; migration ileri/geri test edildi (12 test geçti).',
  artifacts: [{ type: 'pr', ref: 'https://github.com/acme/todo-app/pull/41' }],
});
await say(can, `#${sub('db')} tamamlandı ✅ PR: acme/todo-app#41 — migration geri alınabilir.`);

// api: sürüyor
await beren.call('task_claim', { id: sub('api') });
await beren.call('files_reserve', { repo: REPO, paths: ['src/api/tags.ts', 'src/api/tasks.ts'], task_id: sub('api'), reason: 'etiket uçları' });
await beren.call('task_update', { id: sub('api'), status: 'in_progress', branch: 'ar/todo-app/t' + sub('api') + '-tags-api', progress: 'GET/POST /tags hazır, ?tag= filtresi yazılıyor' });
await beren.call('heartbeat', { status: 'working', activity: `#${sub('api')} ?tag= filtresi` });

// search: sürüyor + oylama
await ilgaz.call('task_claim', { id: sub('search') });
await ilgaz.call('task_update', { id: sub('search'), status: 'in_progress', branch: 'ar/todo-app/t' + sub('search') + '-search', progress: 'iki yöntem karşılaştırılıyor' });
const vote = await ilgaz.call('consult_open', {
  room: ROOM,
  question: 'Arama için hangi yöntemi kullanalım? FTS5 hızlı ve sıralama yapar ama ek tablo ister; LIKE basit ama büyük listelerde yavaş.',
  options: ['SQLite FTS5', 'LIKE sorgusu'],
  timeout_sec: 900,
  task_id: sub('search'),
});
const voteId = idOf(vote);
await defne.call('consult_reply', { id: voteId, choice: 'SQLite FTS5', body: 'Liste büyüyecek; FTS5 uzun vadede doğru seçim.' });
await can.call('consult_reply', { id: voteId, choice: 'SQLite FTS5', body: 'Şemaya FTS tablosunu ben eklerim.' });
await ilgaz.call('heartbeat', { status: 'working', activity: `#${sub('search')} FTS5 denemesi` });

// ui: api'yi bekliyor
await elif.call('heartbeat', { status: 'idle', activity: `#${sub('ui')} için api'yi bekliyor` });
await say(elif, `@beren ?tag= filtresi bitince haber verir misin? #${sub('ui')} ona bağlı.`);
await say(beren, '@elif yarım saate hazır; uç adları `GET /tags` ve `GET /tasks?tag=a,b`.');
await can.call('heartbeat', { status: 'idle', activity: 'yeni görev bekliyor' });

console.log(`Demo hazır: ${BASE} (oda: ${ROOM}). Agent'lar çevrimiçi tutuluyor; çıkmak için Ctrl+C.`);
const beat = setInterval(async () => {
  try {
    await defne.call('heartbeat', { status: 'working', activity: 'planı yönetiyor' });
    await beren.call('heartbeat', { status: 'working', activity: `#${sub('api')} ?tag= filtresi` });
    await ilgaz.call('heartbeat', { status: 'working', activity: `#${sub('search')} FTS5 denemesi` });
    await elif.call('heartbeat', { status: 'idle', activity: `#${sub('ui')} için api'yi bekliyor` });
    await can.call('heartbeat', { status: 'idle', activity: 'yeni görev bekliyor' });
  } catch (e) {
    console.error((e as Error).message);
  }
}, 30_000);
process.on('SIGINT', () => {
  clearInterval(beat);
  process.exit(0);
});
