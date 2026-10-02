#!/usr/bin/env node
// agents-room etkileşimli ekip kurulumu: soruları sorar, agent kimliklerini alır, çalışma klonlarını hazırlar
// ve agent'ları arka planda başlatır. Sunucu makinesinde de, ağdaki başka bir makinede de çalışır.
//
//   node scripts/team.ts                         # etkileşimli kurulum (sunucu: http://127.0.0.1:7700)
//   node scripts/team.ts --server http://192.168.1.20:7700
//   node scripts/team.ts status [oda]            # bu makinede başlatılmış ekipler
//   node scripts/team.ts stop <oda>              # o odanın bu makinedeki agent'larını durdurur
//
// Etkileşimsiz kullanım: --room x --orch 2 --orch-client claude,hermes --claude 2 --hermes 1 --codex 0 --gemini 1
//                        --repo <git-url> --topic "..." --goal "..." --secret <kayıt-sırrı> --yes
//                        --orch 0  → orkestratörsüz ekip (görevler panelden ya da başka makinedeki orkestratörden gelir)
//                        --repo org/proje --git-token <GitHub token> | --ssh-key ~/.ssh/deploy_key
//                        --foreground  → agent'lar bitene kadar ön planda kal (Docker konteyneri için)
//                        --check       → yalnızca denetle (sunucu, sır, repo erişimi, platformlar), hiçbir şey başlatma
// Ortam değişkenleri: AGENTS_ROOM_BASE (sunucu), AGENTS_ROOM_ENROLL_SECRET, AGENTS_ROOM_GIT_TOKEN (ya da GITHUB_TOKEN),
//                     AGENTS_ROOM_SSH_KEY, AGENTS_ROOM_WORKSPACES (çalışma alanı kökü)
//                        --names elif,mert,...  (kendi isimleriniz)  |  --prefix mac2 (isim yerine önekli adlar)
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, readdirSync, appendFileSync, symlinkSync, rmSync, createWriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type GitAuth, cloneFromCache, cloneRepo, expandHome, githubPushAccess, githubSlug, gitEnv, isHttps, isSsh, normalizeRepo, probeRepo, refreshWorkspace, seedEmptyRepo, syncCache } from './git-auth.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = process.env.AGENTS_ROOM_WORKSPACES ? resolve(process.env.AGENTS_ROOM_WORKSPACES) : join(ROOT, 'workspaces');
// Agent kimlikleri (MCP ve git token'ları) çalışma alanının dışında tutulur: agent'lar çalışma alanını okuyabilir.
const SECRETS = join(homedir(), '.config', 'agents-room', 'teams');
const DATA = join(ROOT, 'server', 'data');
type Client = 'claude' | 'hermes' | 'codex' | 'gemini';
const CLIENTS: Client[] = ['claude', 'hermes', 'codex', 'gemini'];
const KIND: Record<Client, string> = { claude: 'claude-code', hermes: 'hermes', codex: 'codex', gemini: 'gemini' };
const CLI: Record<Client, string> = { claude: 'claude', hermes: 'hermes', codex: 'codex', gemini: 'gemini' };
const LABEL: Record<Client, string> = { claude: 'Claude Code', hermes: 'Hermes Agent', codex: 'Codex CLI', gemini: 'Gemini CLI' };

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: 'string' },
    secret: { type: 'string' },
    room: { type: 'string' },
    topic: { type: 'string' },
    repo: { type: 'string' },
    goal: { type: 'string' },
    prefix: { type: 'string' },
    names: { type: 'string' },
    orch: { type: 'string' },
    'orch-client': { type: 'string' },
    claude: { type: 'string' },
    hermes: { type: 'string' },
    codex: { type: 'string' },
    gemini: { type: 'string' },
    sessions: { type: 'string' },
    'git-token': { type: 'string' },
    'ssh-key': { type: 'string' },
    foreground: { type: 'boolean', default: false },
    reopen: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
  },
});

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  err: (s: string) => `\x1b[31m${s}\x1b[0m`,
};
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

interface TeamFile {
  room: string;
  server: string;
  started_at: string;
  agents: { name: string; client: Client; role: string; pid: number; log: string; dir: string }[];
}

// ------------------------------------------------------------------ status / stop
function teamFiles(room?: string): { file: string; team: TeamFile }[] {
  if (!existsSync(WORKSPACES)) return [];
  return readdirSync(WORKSPACES)
    .filter((r) => !room || r === room)
    .map((r) => join(WORKSPACES, r, 'team.json'))
    .filter(existsSync)
    .map((file) => ({ file, team: JSON.parse(readFileSync(file, 'utf8')) as TeamFile }));
}
const alive = (pid: number) => {
  if (!(pid > 0)) return false; // henüz başlatılmamış (kill(0) süreç grubunu sorardı)
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (positionals[0] === 'status') {
  const list = teamFiles(positionals[1]);
  if (!list.length) console.log('Bu makinede başlatılmış ekip yok.');
  for (const { team } of list) {
    console.log(c.b(`\n${team.room}`) + c.dim(`  (${team.server}, ${team.started_at})`));
    for (const a of team.agents) console.log(`  ${alive(a.pid) ? c.ok('● çalışıyor') : c.dim('○ durdu    ')}  ${a.name.padEnd(24)} ${a.client.padEnd(7)} ${a.role.padEnd(13)} ${c.dim(a.log)}`);
  }
  process.exit(0);
}

if (positionals[0] === 'stop') {
  const room = positionals[1];
  if (!room) {
    console.error('Kullanım: node scripts/team.ts stop <oda>');
    process.exit(2);
  }
  const list = teamFiles(room);
  if (!list.length) console.log(`"${room}" için bu makinede başlatılmış ekip yok.`);
  for (const { team } of list) {
    for (const a of team.agents) {
      if (!alive(a.pid)) continue;
      try {
        process.kill(-a.pid, 'SIGTERM'); // süreç grubu: run-agent.sh + agent CLI
      } catch {
        process.kill(a.pid, 'SIGTERM');
      }
      console.log(`  durduruldu: ${a.name}`);
    }
  }
  process.exit(0);
}

// ------------------------------------------------------------------ etkileşimli kurulum
// Satırlar kuyruğa alınır: hem terminalde hem borulanmış (pipe) girdide doğru çalışır.
const rl = createInterface({ input: process.stdin, terminal: false }); // terminal: false → TTY kendi yankısını yapar
const lines: string[] = [];
const waiters: ((l: string | null) => void)[] = [];
let inputClosed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()!(l) : lines.push(l)));
rl.on('close', () => {
  inputClosed = true;
  while (waiters.length) waiters.shift()!(null);
});
async function ask(q: string, def?: string): Promise<string> {
  if (opt.yes && def !== undefined) return def;
  process.stdout.write(`${q}${def !== undefined && def !== '' ? c.dim(` [${def}]`) : ''}: `);
  const line = lines.length ? lines.shift()! : inputClosed ? null : await new Promise<string | null>((r) => waiters.push(r));
  if (!process.stdin.isTTY) process.stdout.write((line ?? '') + '\n');
  if (line === null && def === undefined) fail('Girdi bitti');
  const a = (line ?? '').trim();
  return a || def || '';
}
/** Gizli girdi: terminalde yazılan karakterler gizlenir ve satır silinir. */
async function askSecret(q: string): Promise<string> {
  if (opt.yes) return '';
  const tty = process.stdin.isTTY;
  if (tty) process.stdout.write('\x1b[8m'); // gizli metin
  const v = await ask(q, '');
  if (tty) process.stdout.write(`\x1b[28m\x1b[1A\x1b[2K${q}: ${v ? '••••••••' : ''}\n`);
  return v;
}
async function askInt(q: string, def: number, min = 0, max = 10): Promise<number> {
  for (;;) {
    const v = Number(await ask(q, String(def)));
    if (Number.isInteger(v) && v >= min && v <= max) return v;
    console.log(c.warn(`  ${min}-${max} arasında bir sayı girin`));
  }
}
async function askYes(q: string, def = true): Promise<boolean> {
  const a = (await ask(`${q} (e/h)`, def ? 'e' : 'h')).toLowerCase();
  return a.startsWith('e') || a.startsWith('y');
}
function fail(msg: string): never {
  console.error(c.err(`\n✗ ${msg}`));
  rl.close();
  process.exit(1);
}

console.log(c.b('\nagents-room ekip kurulumu\n'));

const server = (opt.server ?? process.env.AGENTS_ROOM_BASE ?? (await ask('Sunucu adresi', 'http://127.0.0.1:7700'))).replace(/\/+$/, '').replace(/\/mcp$/, '');
try {
  const h = await fetch(server + '/healthz', { signal: AbortSignal.timeout(4000) });
  if (!h.ok) throw new Error(`HTTP ${h.status}`);
} catch (e) {
  fail(`Sunucuya ulaşılamadı (${server}): ${(e as Error).message}\n  Sunucu makinesinde "cd server && npm start" çalışıyor mu, aynı ağda mısınız?`);
}
console.log(c.ok(`✓ sunucu: ${server}`));

// Kimlik: yerel sunucuda admin token'ı otomatik; uzakta kayıt sırrı sorulur.
const isLocal = /\/\/(127\.0\.0\.1|localhost)(:|$)/.test(server);
let auth: { secret?: string; adminToken?: string } = {};
if (opt.secret ?? process.env.AGENTS_ROOM_ENROLL_SECRET) auth.secret = opt.secret ?? process.env.AGENTS_ROOM_ENROLL_SECRET;
else if (isLocal && existsSync(join(DATA, 'admin.token'))) auth.adminToken = readFileSync(join(DATA, 'admin.token'), 'utf8').trim();
else {
  console.log(c.dim('  Kayıt sırrı sunucu makinesindeki server/data/enroll.secret dosyasındadır.'));
  auth.secret = await ask('Kayıt sırrı');
}
async function enrollApi(path: string, body: Record<string, unknown>) {
  const r = await fetch(server + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth.adminToken ? { Authorization: `Bearer ${auth.adminToken}` } : {}) },
    body: JSON.stringify({ ...body, ...(auth.secret ? { secret: auth.secret } : {}) }),
  });
  const j = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}
let info: { rooms: { name: string; topic: string | null; repo: string | null; members: number; open_tasks: number; closed?: boolean }[]; agents: { name: string; role: string; status: string; machine: string | null }[] };
try {
  info = await enrollApi('/api/enroll/info', {});
} catch (e) {
  fail(`Kimlik doğrulanamadı: ${(e as Error).message}`);
}

// Oda
console.log(c.b('\nOdalar'));
for (const r of info.rooms.filter((x) => !x.closed)) console.log(`  ${r.name.padEnd(22)} ${c.dim(`${r.members} üye, ${r.open_tasks} açık görev`)}  ${r.topic ?? ''}`);
const closedRooms = info.rooms.filter((x) => x.closed);
if (closedRooms.length) console.log(c.dim(`  kapalı: ${closedRooms.map((r) => r.name).join(', ')}`));
const room = slug(opt.room ?? (await ask('\nOda adı (var olanı seçin ya da yeni bir ad yazın)', info.rooms.find((r) => r.name !== 'lobby' && !r.closed)?.name ?? 'lobby')));
if (!room || room.length < 2) fail('Geçersiz oda adı');
const existing = info.rooms.find((r) => r.name === room);
let reopen = false;
if (existing?.closed) {
  reopen = opt.yes ? opt.reopen : await askYes(`"${room}" odası kapalı. Yeniden açılsın mı?`);
  if (!reopen) {
    console.log(c.warn(`\n"${room}" odası kapalı; ekip kurulmadı.${opt.yes ? ' Yeniden açmak için --reopen verin.' : ''}`));
    rl.close();
    process.exit(0); // Docker'da yeniden başlatma döngüsüne girmesin
  }
}
let topic = existing?.topic ?? null;
let repo = existing?.repo ?? null;
if (existing) console.log(c.ok(`✓ var olan oda: ${room}`) + (repo ? c.dim(`  repo: ${repo}`) : ''));
else {
  console.log(c.ok(`✓ yeni oda oluşturulacak: ${room}`));
  topic = opt.topic ?? (await ask('Odanın konusu', `${room} ekibi`));
}
if (!repo) {
  console.log(c.dim('  Ortak repo: başka makineler de katılacaksa hepsinin erişebildiği bir git adresi verin (ör. GitHub: org/proje).\n  Boş bırakırsanız bu makinede yerel bir repo açılır (yalnızca bu makinedeki agent\'lar kullanabilir).'));
  repo = opt.repo ?? (await ask('Ortak git reposu adresi', ''));
}
const norm = normalizeRepo(repo ?? '');
repo = norm.url || null;
if (repo && !isHttps(repo) && !isSsh(repo) && !existsSync(repo)) {
  fail(`Bu odanın reposu yerel bir yol ve bu makinede yok: ${repo}\n  Farklı makineler için odanın reposu GitHub gibi ortak bir adres olmalı (yeni bir oda açıp --repo org/proje verin).`);
}

// Repo erişim anahtarı: yalnızca bu makinede, agent'ların git kimlik yardımcısında kullanılır.
let gitAuth: GitAuth = { kind: 'none' };
let baseBranch = 'main';
let repoEmpty = false;
let pushNote = '';
if (repo && (isHttps(repo) || isSsh(repo))) {
  if (isHttps(repo)) {
    const fromEnv = opt['git-token'] ?? norm.token ?? process.env.AGENTS_ROOM_GIT_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!fromEnv) console.log(c.dim('  Repo erişim anahtarı: yalnızca bu repoya "Contents: Read and write" (PR için "Pull requests: Read and write")\n  izni olan, süreli bir GitHub fine-grained token önerilir. Boş bırakılırsa bu makinedeki git kimliği kullanılır.'));
    const t = fromEnv ?? (await askSecret('Repo erişim anahtarı (GitHub token)'));
    if (t) gitAuth = { kind: 'token', token: t.trim() };
  } else {
    const k = opt['ssh-key'] ?? process.env.AGENTS_ROOM_SSH_KEY ?? (await ask('SSH anahtar dosyası (repoya yazma izni olan deploy key; boş = ~/.ssh varsayılanı)', ''));
    if (k) {
      const key = expandHome(k);
      if (!existsSync(key)) fail(`SSH anahtar dosyası bulunamadı: ${key}`);
      gitAuth = { kind: 'ssh', sshKey: key };
    }
  }
  process.stdout.write(c.dim('  repo erişimi kontrol ediliyor… '));
  const probe = probeRepo(repo, gitAuth);
  if (!probe.ok) {
    console.log('');
    fail(`Repoya erişilemedi (${repo}):\n  ${probe.error}\n  Anahtarın bu repoya erişimi var mı, adres doğru mu?`);
  }
  repoEmpty = !!probe.empty;
  baseBranch = probe.defaultBranch ?? 'main';
  if (gitAuth.kind === 'token' && githubSlug(repo)) {
    const acc = await githubPushAccess(repo, gitAuth.token);
    if (acc.push === false) {
      console.log('');
      fail(`Bu anahtarın repoya yazma izni yok${acc.error ? ` (${acc.error})` : ''}.\n  Token'a bu repo için "Contents: Read and write" izni verin.`);
    }
    pushNote = acc.push ? 'yazma izni ✓' : 'yazma izni doğrulanamadı';
  }
  console.log(c.ok(`✓ erişim tamam`) + c.dim(`  dal: ${repoEmpty ? '(boş repo)' : baseBranch}${pushNote ? ', ' + pushNote : ''}`));
}

// Ekip: platformlar
console.log(c.b('\nPlatformlar'));
const installed = Object.fromEntries(CLIENTS.map((k) => [k, has(CLI[k])])) as Record<Client, boolean>;
for (const k of CLIENTS) console.log(`  ${k.padEnd(8)} ${LABEL[k].padEnd(14)} ${installed[k] ? c.ok('✓ kurulu') : c.dim('– bu makinede yok')}`);
const firstInstalled = CLIENTS.find((k) => installed[k]) ?? 'claude';
const avail = (k: Client) => (installed[k] ? '' : c.warn(' (kurulu değil)'));
async function askClient(q: string, def: Client): Promise<Client> {
  for (;;) {
    const v = (await ask(q, def)).toLowerCase() as Client;
    if (CLIENTS.includes(v)) return v;
    console.log(c.warn(`  şunlardan biri: ${CLIENTS.join(', ')}`));
  }
}

// Orkestratörler
console.log(c.b('\nOrkestratörler'));
const roomOrchs = info.agents.filter((a) => a.role === 'orchestrator' && a.status !== 'offline');
if (existing && roomOrchs.length) console.log(c.dim(`  Sunucuda çevrimiçi orkestratör(ler): ${roomOrchs.map((a) => a.name).join(', ')}`));
console.log(c.dim('  0 = orkestratör yok: hedefi panelden ya da başka bir makinedeki orkestratörden verirsiniz.\n  2+ = orkestratörler masada oylayıp bir başkan seçer; planı başkan yapar, diğerleri alt planları yürütür.'));
const orchCount = opt.orch !== undefined ? Number(opt.orch) : await askInt('Orkestratör sayısı', existing && roomOrchs.length ? 0 : 1, 0, 5);
if (!Number.isInteger(orchCount) || orchCount < 0 || orchCount > 5) fail('Orkestratör sayısı 0-5 olmalı');
const orchClients: Client[] = [];
const fromFlag = opt['orch-client']?.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) as Client[] | undefined;
for (let i = 0; i < orchCount; i++) {
  if (fromFlag?.length) orchClients.push(fromFlag[Math.min(i, fromFlag.length - 1)]!);
  else orchClients.push(await askClient(`  ${i + 1}. orkestratörün platformu (${CLIENTS.join(' / ')})`, orchClients[i - 1] ?? firstInstalled));
}
for (const k of orchClients) if (!CLIENTS.includes(k)) fail(`Bilinmeyen platform: ${k} (${CLIENTS.join(', ')})`);

// İşçiler
console.log(c.b('\nİşçiler'));
const workers = {} as Record<Client, number>;
for (const k of CLIENTS) {
  const flag = opt[k];
  workers[k] = flag !== undefined ? Number(flag) : await askInt(`  ${LABEL[k]} işçi sayısı${avail(k)}`, k === firstInstalled && installed[k] ? 2 : 0);
}
for (const k of CLIENTS) if ((workers[k] || orchClients.includes(k)) && !installed[k]) fail(`"${CLI[k]}" bu makinede kurulu değil (${LABEL[k]}). Kurun ya da başka platform seçin.`);
if (!orchCount && !Object.values(workers).some(Boolean)) fail('En az bir agent seçmelisiniz');
if (!orchCount) console.log(c.dim('  Orkestratörsüz ekip: işçiler görev panosunu dinler; görevleri panelden, task_create ile ya da başka makinedeki orkestratör verir.'));
if (opt.check) {
  // Yalnızca denetim (Docker kurulum sihirbazı kullanır): sunucu, kayıt sırrı, oda, repo erişimi ve platformlar.
  console.log(c.ok('\n✓ Kontroller tamam') + c.dim(' (kayıt yapılmadı, agent başlatılmadı)'));
  rl.close();
  process.exit(0);
}

// Adlar: varsayılan olarak rastgele insan isimleri (çakışmasız); istenirse makine önekli adlar.
const NAME_POOL = [
  'elif', 'mert', 'deniz', 'zeynep', 'can', 'ece', 'emre', 'selin', 'kaan', 'defne', 'arda', 'nehir', 'baran', 'ada', 'efe',
  'lara', 'yusuf', 'irem', 'ozan', 'ceren', 'tuna', 'melis', 'kerem', 'asli', 'bora', 'sude', 'alp', 'pelin', 'onur', 'derya',
  'umut', 'ela', 'cem', 'naz', 'baris', 'yagmur', 'koray', 'duru', 'sarp', 'ilgaz', 'mira', 'tolga', 'beren', 'aras', 'gizem',
];
const taken = new Set(info.agents.map((a) => a.name));
const goal = orchCount ? (opt.goal ?? (await ask('Orkestratöre ilk hedef (boş = panelden yazacağım)', ''))) : '';
const sessions = Number(opt.sessions ?? 20);
const roles: { client: Client; role: 'orchestrator' | 'worker' }[] = [];
for (const k of orchClients) roles.push({ client: k, role: 'orchestrator' });
for (const k of CLIENTS) for (let i = 1; i <= workers[k]; i++) roles.push({ client: k, role: 'worker' });

let names: string[];
const reused = new Set<string>();
if (opt.prefix) {
  const prefix = slug(opt.prefix);
  const n: Record<string, number> = {};
  names = roles.map((r) => {
    const key = r.role === 'orchestrator' ? 'orch' : r.client;
    const i = (n[key] = (n[key] ?? 0) + 1);
    return r.role === 'orchestrator' ? `${prefix}-orch${orchCount > 1 ? '-' + i : ''}` : `${prefix}-${r.client}-${i}`;
  });
} else if (opt.names) {
  names = opt.names.split(',').map((x) => slug(x)).filter(Boolean);
  if (names.length !== roles.length) fail(`--names ile ${roles.length} isim vermelisiniz (verilen: ${names.length})`);
} else {
  // Bu makinede aynı oda için daha önce kurulmuş ekibin (artık çalışmayan) adları yeniden kullanılır:
  // Docker konteyneri yeniden başladığında agent'lar aynı kimlikle masaya döner.
  const prevTeam = existsSync(join(WORKSPACES, room, 'team.json')) ? (JSON.parse(readFileSync(join(WORKSPACES, room, 'team.json'), 'utf8')) as TeamFile) : null;
  const reusable = (prevTeam?.agents ?? []).filter((a) => !alive(a.pid));
  const picked = roles.map((r) => {
    const i = reusable.findIndex((a) => a.client === r.client && a.role === r.role);
    return i >= 0 ? reusable.splice(i, 1)[0]!.name : null;
  });
  for (const n of picked) if (n) reused.add(n);
  const free = NAME_POOL.filter((n) => !taken.has(n) && !picked.includes(n)).sort(() => Math.random() - 0.5);
  let k = 0;
  names = picked.map((n, i) => n ?? free[k++] ?? `agent-${i + 2}`);
}
const plan = roles.map((r, i) => ({ name: names[i]!, ...r }));
const clash = plan.filter((p) => taken.has(p.name) && !reused.has(p.name) && info.agents.find((a) => a.name === p.name)!.status !== 'offline');
if (clash.length) fail(`Şu adlar şu an çevrimiçi başka agent'larda kullanılıyor: ${clash.map((p) => p.name).join(', ')}. --names ile başka isimler verin.`);
if (new Set(names).size !== names.length) fail('Agent adları benzersiz olmalı');

console.log(c.b('\nÖzet'));
console.log(`  oda:   ${room}${existing ? '' : ' (yeni)'}  ${topic ? c.dim(topic) : ''}`);
console.log(`  repo:  ${repo || c.warn('bu makinede yerel repo')}`);
if (repo && (isHttps(repo) || isSsh(repo))) console.log(`  erişim: ${gitAuth.kind === 'token' ? `token${pushNote ? ` (${pushNote})` : ''}` : gitAuth.kind === 'ssh' ? `SSH anahtarı ${gitAuth.sshKey}` : 'bu makinedeki git kimliği'}${repoEmpty ? c.warn('  · repo boş, ilk commit atılacak') : ''}`);
for (const p of plan) console.log(`  ${p.role === 'orchestrator' ? '★' : '•'} ${p.name.padEnd(14)} ${LABEL[p.client].padEnd(14)} ${p.role === 'orchestrator' ? 'orkestratör' : 'işçi'}`);
if (orchCount > 1) console.log(c.dim(`  ${orchCount} orkestratör masada başkan seçecek.`));
if (!orchCount) console.log(c.dim('  orkestratör yok'));
console.log(c.dim(reused.size ? `  (${[...reused].join(', ')} önceki kurulumdan; diğerleri rastgele. Kendi isimleriniz için --names elif,mert,…)` : '  (İsimler rastgele seçildi; kendi isimleriniz için --names elif,mert,…)'));
if (goal) console.log(`  hedef: ${goal}`);
if (!(await askYes('\nBaşlatılsın mı?'))) fail('İptal edildi');

if (repo && repoEmpty) {
  const seeded = seedEmptyRepo(repo, gitAuth, room, baseBranch);
  if (!seeded.ok) fail(`Boş repoya ilk commit atılamadı: ${seeded.error}`);
  console.log(c.ok(`✓ boş repoya ilk commit atıldı (${baseBranch})`));
}

// Hermes profili (gerekirse)
const usesHermes = plan.some((p) => p.client === 'hermes');
if (usesHermes) {
  const profiles = spawnSync('hermes', ['profile', 'list'], { encoding: 'utf8' }).stdout ?? '';
  if (!profiles.includes('agentsroom')) {
    if (!(await askYes('Hermes için ayrı "agentsroom" profili oluşturulsun mu? (varsayılan profiliniz değişmez)'))) fail('Hermes işçileri için agentsroom profili gerekli');
    const r = spawnSync('hermes', ['profile', 'create', 'agentsroom', '--clone', '--no-alias', '--description', 'agents-room worker'], { stdio: 'inherit' });
    if (r.status !== 0) fail('Hermes profili oluşturulamadı');
  }
  const pdir = join(homedir(), '.hermes', 'profiles', 'agentsroom');
  const cfgFile = join(pdir, 'config.yaml');
  if (existsSync(cfgFile) && !readFileSync(cfgFile, 'utf8').includes('agents-room:')) {
    appendFileSync(cfgFile, '\n# agents-room (scripts/team.ts)\nmcp_servers:\n  agents-room:\n    url: "${AGENTS_ROOM_URL}"\n    headers:\n      Authorization: "Bearer ${AGENTS_ROOM_TOKEN}"\n    timeout: 120\n');
  }
  mkdirSync(join(pdir, 'skills'), { recursive: true });
  if (!existsSync(join(pdir, 'skills', 'agents-room'))) symlinkSync(join(ROOT, 'skills', 'agents-room'), join(pdir, 'skills', 'agents-room'));
  console.log(c.ok('✓ Hermes agentsroom profili hazır'));
}

// Gemini ve Codex skill'i ~/.agents/skills altından okur.
if (plan.some((p) => p.client === 'gemini' || p.client === 'codex')) {
  const dir = join(homedir(), '.agents', 'skills');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, 'agents-room'))) symlinkSync(join(ROOT, 'skills', 'agents-room'), join(dir, 'agents-room'));
}

// Çalışma alanı ve repo
const WS = join(WORKSPACES, room);
mkdirSync(join(WS, 'logs'), { recursive: true });
if (!repo) {
  const bare = join(WS, 'origin.git');
  if (!existsSync(bare)) {
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    const seed = join(WS, '.seed');
    mkdirSync(seed, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: seed });
    writeFileSync(join(seed, 'README.md'), `# ${room}\n\nagents-room ortak çalışma reposu.\n`);
    spawnSync('git', ['add', '-A'], { cwd: seed });
    spawnSync('git', ['-c', 'user.name=agents-room', '-c', 'user.email=agents-room@local', 'commit', '-qm', 'chore: başlangıç'], { cwd: seed });
    spawnSync('git', ['push', '-q', bare, 'main'], { cwd: seed });
    spawnSync('rm', ['-rf', seed]);
  }
  repo = bare;
}

// Ön plan modu: çıktı log dosyasına yazılır; oturum başlangıç/bitiş satırları ekrana da düşer.
const running: Promise<void>[] = [];
const children: { name: string; pid: number }[] = [];
function followChild(name: string, child: ReturnType<typeof spawn>, log: string): void {
  const out = createWriteStream(log, { flags: 'a' });
  children.push({ name, pid: child.pid! });
  for (const [stream, isErr] of [[child.stdout!, false], [child.stderr!, true]] as const) {
    let buf = '';
    stream.on('data', (d: Buffer) => {
      out.write(d);
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      // run-agent.sh'in kendi satırları (▶ oturum, ■ durdu) ve tüm hata çıktısı; CLI'ların ayrıntılı çıktısı yalnızca logda.
      for (const l of lines) if ((isErr || /^(▶|■)/.test(l)) && l.trim()) console.log(`${c.dim(`[${name}]`)} ${l.slice(0, 400)}`);
    });
  }
  running.push(new Promise((res) => child.on('exit', (code, signal) => {
    console.log(`${c.dim(`[${name}]`)} ${code === 0 ? 'durdu' : signal ? `durduruldu (${signal})` : c.warn(`hata ile çıktı (kod ${code}); ayrıntı: ${log}`)}`);
    out.end();
    res();
  })));
}
if (opt.foreground) {
  const stopAll = (sig: NodeJS.Signals) => {
    console.log(c.warn(`\n${sig}: agent'lar durduruluyor…`));
    for (const ch of children) {
      try { process.kill(-ch.pid, 'SIGTERM'); } catch { /* zaten durmuş */ }
    }
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('SIGINT', () => stopAll('SIGINT'));
}

// Kayıt + klon + başlatma
const team: TeamFile = { room, server, started_at: new Date().toISOString(), agents: [] };
const prevFile = join(WS, 'team.json');
if (existsSync(prevFile)) {
  const prev = JSON.parse(readFileSync(prevFile, 'utf8')) as TeamFile;
  team.agents = prev.agents.filter((a) => alive(a.pid) && !plan.some((p) => p.name === a.name));
}
// İsimler klon/kayıt öncesinde yazılır: bir adım başarısız olup konteyner yeniden başlarsa aynı isimler kullanılır.
mkdirSync(WS, { recursive: true });
writeFileSync(prevFile, JSON.stringify({ ...team, agents: [...team.agents, ...plan.map((p) => ({ name: p.name, client: p.client, role: p.role, pid: 0, log: '', dir: join(WS, p.name) }))] }, null, 2));

// Uzak repo makine başına bir kez indirilir (yerel önbellek); agent kopyaları oradan açılır.
const remoteRepo = isHttps(repo) || isSsh(repo);
const CACHE = join(WS, '.repo-cache.git');
if (remoteRepo) {
  const fresh = !existsSync(join(CACHE, 'HEAD'));
  console.log('');
  process.stdout.write(fresh ? `  repo indiriliyor (bu makinede bir kez; büyük repolarda birkaç dakika sürebilir)…\n` : `  repo önbelleği güncelleniyor…\n`);
  let lastShown = 0;
  let lastLine = '';
  const t0 = Date.now();
  const r = await syncCache(repo, CACHE, gitAuth, (line) => {
    lastLine = line;
    if (Date.now() - lastShown > 10_000) {
      lastShown = Date.now();
      console.log(c.dim(`    ${line.slice(0, 120)}`));
    }
  });
  if (!r.ok) fail(`Repo indirilemedi (${repo}): ${r.error}\n  Bu makinenin repoya erişimi (anahtar/ağ) olmalı. Takılma süresi: AGENTS_ROOM_GIT_STALL_SEC (varsayılan 300).`);
  console.log(c.ok(`  ✓ repo hazır`) + c.dim(` (${Math.round((Date.now() - t0) / 1000)} sn${lastLine && fresh ? ', ' + lastLine.slice(0, 80) : ''})`));
}
console.log('');
for (const p of plan) {
  let enr: { token: string };
  try {
    enr = await enrollApi('/api/enroll', {
      name: p.name,
      kind: KIND[p.client],
      role: p.role,
      capabilities: p.role === 'orchestrator' ? ['planning', 'review', 'research'] : ['typescript', 'python', 'testing', 'research', 'docs'],
      machine: hostname(),
      room,
      topic,
      repo,
      reopen,
    });
  } catch (e) {
    fail(`${p.name} kaydedilemedi: ${(e as Error).message}`);
  }
  const dir = join(WS, p.name);
  if (!existsSync(dir)) {
    const r = remoteRepo ? await cloneFromCache(repo, CACHE, dir, gitAuth) : cloneRepo(repo, dir, gitAuth);
    if (!r.ok) fail(`Repo klonlanamadı (${repo}): ${r.error}\n  Bu makinenin repoya erişimi (anahtar/ağ) olmalı.`);
  } else {
    const r = await refreshWorkspace(dir, gitAuth, repo);
    if (!r.ok) console.log(c.warn(`  ⚠️  ${p.name}: repo güncellenemedi (${r.error}); mevcut kopyayla devam ediliyor.`));
  }
  spawnSync('git', ['-C', dir, 'config', 'user.name', p.name]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', `${p.name}@agents-room.local`]);
  const agentEnv: Record<string, string> = {
    AGENTS_ROOM_URL: server + '/mcp',
    AGENTS_ROOM_TOKEN: enr.token,
    AGENTS_ROOM_BASE_BRANCH: baseBranch,
    ...gitEnv(gitAuth, repo),
  };
  // Elle yeniden başlatmak için: source ~/.config/agents-room/teams/<oda>/<ad>.env
  mkdirSync(join(SECRETS, room), { recursive: true, mode: 0o700 });
  writeFileSync(join(SECRETS, room, `${p.name}.env`), Object.entries(agentEnv).map(([k, v]) => `export ${k}=${shq(v)}\n`).join(''), { mode: 0o600 });
  if (existsSync(join(WS, `${p.name}.env`))) rmSync(join(WS, `${p.name}.env`)); // eski sürümün çalışma alanına yazdığı kimlik dosyası

  const log = join(WS, 'logs', `${p.name}.log`);
  const fd = opt.foreground ? -1 : openSync(log, 'a');
  const args = [join(ROOT, 'scripts', 'run-agent.sh'), '--client', p.client, '--role', p.role, '--room', room, '--repo', dir, '--sessions', String(p.role === 'orchestrator' ? 5 : sessions)];
  if (p.role === 'orchestrator') {
    args.push(
      '--goal',
      goal
        ? `${goal}\n(The human admin may add more instructions in the room. Talk to humans in Turkish.${orchCount > 1 ? ` There are ${orchCount} orchestrators at this table: elect a chair first; only the chair plans the whole goal.` : ''})`
        : 'No goal has been given yet. Post a short hello to the room in Turkish, list the workers that are online, and keep looping on wait_for_messages until a human posts a goal. Then (if you are the chair; vote first if a chair election runs) draft a plan, consult the table with consult_open, decide, dispatch with plan_create, monitor, review, merge into main and report back in Turkish. If another orchestrator is chair, support it and run the sub-plans it assigns you. Do not stop just because the room is quiet; keep waiting for at least 60 minutes.',
    );
  }
  const child = spawn('bash', args, {
    cwd: ROOT,
    detached: true,
    stdio: opt.foreground ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd],
    env: {
      ...process.env,
      ...agentEnv,
      AGENTS_ROOM_LOGDIR: join(WS, 'logs'),
      ...(p.client === 'hermes' ? { HERMES_PROFILE: 'agentsroom' } : {}),
    },
  });
  if (opt.foreground) followChild(p.name, child, log);
  else child.unref();
  team.agents.push({ name: p.name, client: p.client, role: p.role, pid: child.pid!, log, dir });
  console.log(c.ok(`✓ ${p.name}`) + c.dim(`  pid ${child.pid}  log ${log}`));
  await new Promise((r) => setTimeout(r, p.role === 'orchestrator' ? 3000 : 1500));
}
writeFileSync(prevFile, JSON.stringify(team, null, 2));
rl.close();

if (opt.foreground) {
  console.log(c.b(`\nEkip ayakta (ön plan). Panel: ${server}  oda: ${room}`));
  console.log(c.dim('  Agent\'lar bitince ya da oda kapanınca çıkılır. Durdurmak için Ctrl+C / docker stop.'));
  await Promise.all(running);
  console.log(c.b('\nTüm agent\'lar durdu.'));
  process.exit(0);
}

console.log(c.b('\nEkip ayakta.'));
console.log(`  panel:   ${server}  (oda: ${room})`);
console.log(`  durum:   node scripts/team.ts status ${room}`);
console.log(`  durdur:  node scripts/team.ts stop ${room}`);
process.exit(0);
