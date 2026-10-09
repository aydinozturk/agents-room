// agents-room çekirdek iş mantığı. MCP araçları ve REST API bu sınıfı kullanır;
// taşıma katmanından bağımsızdır, böylece ileride XMPP/A2A köprüsü de aynı çekirdeğe bağlanabilir.
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { type Db, now, parseRow, tx } from './db.ts';

export type AgentKind = 'claude-code' | 'codex' | 'hermes' | 'gemini' | 'human' | 'other';
export type AgentRole = 'orchestrator' | 'worker' | 'observer' | 'admin';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'error' | 'offline';
export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'review' | 'done' | 'failed' | 'cancelled';

export interface Agent {
  id: number;
  name: string;
  kind: AgentKind;
  role: AgentRole;
  capabilities: string[];
  machine: string | null;
  revoked: number;
  status: AgentStatus;
  activity: string | null;
  current_task: number | null;
  last_seen: number | null;
  created_at: number;
}

export interface Message {
  id: number;
  room: string;
  sender: string;
  kind: 'chat' | 'system' | 'task' | 'dm';
  body: string;
  mentions: string[];
  recipient: string | null;
  thread_id: number | null;
  task_id: number | null;
  created_at: number;
}

export interface Artifact {
  type: 'branch' | 'pr' | 'commit' | 'file' | 'url' | 'note';
  ref: string;
  description?: string;
}

export interface Task {
  id: number;
  room: string;
  parent_id: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  capabilities: string[];
  depends_on: number[];
  created_by: string;
  assignee: string | null;
  lease_until: number | null;
  attempts: number;
  branch: string | null;
  progress: string | null;
  result: string | null;
  artifacts: Artifact[];
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface Reservation {
  id: number;
  agent: string;
  repo: string;
  pattern: string;
  exclusive: number;
  reason: string | null;
  task_id: number | null;
  expires_at: number;
  created_at: number;
}

export type ConsultKind = 'opinion' | 'vote' | 'election';

export interface Consult {
  id: number;
  room: string;
  asker: string;
  kind: ConsultKind;
  question: string;
  options: string[];
  invitees: string[];
  status: 'open' | 'closed';
  decision: string | null;
  task_id: number | null;
  deadline: number;
  nudged: number;
  created_at: number;
  closed_at: number | null;
}

export interface ConsultReply {
  consult_id: number;
  agent: string;
  body: string;
  choice: string | null;
  created_at: number;
}

export class RoomError extends Error {}

/** Mesajları agent'a gösterilecek tek satırlık biçime çevirir. */
export function fmtMessages(msgs: { id: number; room: string; sender: string; kind: string; body: string; recipient: string | null; task_id: number | null; created_at: number }[]): string {
  if (!msgs.length) return '(no new messages)';
  return msgs
    .map((m) => {
      const t = new Date(m.created_at).toISOString().slice(11, 19);
      const dm = m.recipient ? ` →@${m.recipient}` : '';
      const task = m.task_id ? ` [#${m.task_id}]` : '';
      return `[${m.id}] ${t} #${m.room} <${m.sender}${dm}>${task} ${m.body}`;
    })
    .join('\n');
}

/** Uyandırma sonucu: oturumsuz bekleyen agent'ın yeni bir model oturumu açması için sebep(ler). */
export interface WakeResult {
  closed: boolean;
  reasons: string[];
  /** Oturum talimatına eklenecek metin (İngilizce): neden uyandığı ve ilgili bağlam. */
  note: string;
}

const AGENT_JSON = ['capabilities'];
const MSG_JSON = ['mentions'];
const TASK_JSON = ['capabilities', 'depends_on', 'artifacts'];
const CONSULT_JSON = ['options', 'invitees'];
const ACTIVE_STATUSES: TaskStatus[] = ['claimed', 'in_progress'];
const FINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled'];

export const NOTES_MAX = 12_000; // oda notları kısa bir harita olmalı: her oturum bunu bağlamına alır
export const ONLINE_MS = 90_000; // bu süre içinde görülen agent "çevrimiçi"
export const DEFAULT_LEASE_MIN = 30;
export const CHAIR_GRACE_MS = 10 * 60_000; // başkan bu kadar sessiz kalırsa koltuk boşalır (uzun iş yapan orkestratörü düşürmemek için ONLINE_MS'ten uzun)
export const ELECTION_SEC = 120;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return 'ar_' + randomBytes(24).toString('base64url');
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,47}$/;

export function assertName(name: string, what = 'name'): void {
  if (!NAME_RE.test(name)) {
    throw new RoomError(`Invalid ${what} "${name}": use lowercase letters, digits, . _ - (2-48 chars)`);
  }
}

/** Basit glob → RegExp (**, *, ?). Dosya rezervasyon çakışmaları için yeterli. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function normPath(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** İki yol/glob deseni aynı dosyaları kapsayabilir mi? (tutucu yaklaşım) */
export function patternsOverlap(a: string, b: string): boolean {
  a = normPath(a);
  b = normPath(b);
  if (a === b) return true;
  if (b.startsWith(a + '/') || a.startsWith(b + '/')) return true; // dizin kapsama
  if (globToRegExp(a).test(b) || globToRegExp(b).test(a)) return true;
  // İki glob: joker öncesi sabit önekler birbirini kapsıyorsa çakışma say.
  const pa = a.split(/[*?]/)[0]!;
  const pb = b.split(/[*?]/)[0]!;
  const hasGlob = /[*?]/.test(a) && /[*?]/.test(b);
  return hasGlob && (pa.startsWith(pb) || pb.startsWith(pa));
}

export function extractMentions(body: string): string[] {
  const set = new Set<string>();
  for (const m of body.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._-]{1,47})/gi)) set.add(m[1]!.toLowerCase());
  return [...set];
}

export interface BusEvent {
  type: 'message' | 'task' | 'agent' | 'reservation' | 'event' | 'consult' | 'room';
  room?: string;
  data: unknown;
}

export class RoomService {
  readonly db: Db;
  readonly bus = new EventEmitter();

  constructor(db: Db) {
    this.db = db;
    this.bus.setMaxListeners(1000);
    this.ensureRoom('lobby', 'General lobby: every agent meets here', null, 'system');
  }

  private emit(ev: BusEvent): void {
    this.bus.emit('event', ev);
  }

  // ---------------------------------------------------------------- olay günlüğü
  log(type: string, agent: string | null, data: unknown = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
    const r = this.db
      .prepare('INSERT INTO events (ts, level, agent, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(now(), level, agent, type, JSON.stringify(data));
    this.emit({ type: 'event', data: { id: Number(r.lastInsertRowid), ts: now(), level, agent, type, data } });
  }

  recentEvents(opts: { level?: string; limit?: number } = {}): unknown[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const rows = opts.level
      ? this.db.prepare('SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?').all(opts.level, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => parseRow(r, ['data']));
  }

  // ---------------------------------------------------------------- agent'lar & kimlik
  createAgent(input: {
    name: string;
    kind?: AgentKind;
    role?: AgentRole;
    capabilities?: string[];
    machine?: string;
  }): { agent: Agent; token: string } {
    assertName(input.name, 'agent name');
    const token = newToken();
    const existing = this.db.prepare('SELECT id FROM agents WHERE name = ?').get(input.name);
    if (existing) {
      // Aynı isim için yeni token üret (rotasyon); eski token geçersizleşir.
      this.db
        .prepare(
          'UPDATE agents SET token_hash = ?, revoked = 0, kind = ?, role = ?, capabilities = ?, machine = COALESCE(?, machine) WHERE name = ?',
        )
        .run(
          hashToken(token),
          input.kind ?? 'other',
          input.role ?? 'worker',
          JSON.stringify(input.capabilities ?? []),
          input.machine ?? null,
          input.name,
        );
    } else {
      this.db
        .prepare(
          'INSERT INTO agents (name, kind, role, capabilities, machine, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.name,
          input.kind ?? 'other',
          input.role ?? 'worker',
          JSON.stringify(input.capabilities ?? []),
          input.machine ?? null,
          hashToken(token),
          now(),
        );
    }
    this.log('agent.token_issued', input.name, { kind: input.kind, role: input.role });
    return { agent: this.getAgent(input.name)!, token };
  }

  revokeAgent(name: string): void {
    this.db.prepare("UPDATE agents SET revoked = 1, token_hash = NULL, status = 'offline' WHERE name = ?").run(name);
    this.log('agent.revoked', name, {}, 'warn');
  }

  authenticate(token: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE token_hash = ? AND revoked = 0').get(hashToken(token));
    return row ? this.decorateAgent(parseRow<Agent>(row, AGENT_JSON)) : null;
  }

  getAgent(name: string): Agent | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    return row ? this.decorateAgent(parseRow<Agent>(row, AGENT_JSON)) : null;
  }

  private decorateAgent(a: Agent): Agent {
    // Token özeti hiçbir yanıtta dışarı çıkmamalı.
    delete (a as Partial<Agent> & { token_hash?: string }).token_hash;
    // Kalp atışı gelmeyen agent'ı çevrimdışı göster (kalıcı durum değişmez).
    if (!a.last_seen || now() - a.last_seen > ONLINE_MS) a.status = 'offline';
    return a;
  }

  listAgents(): Agent[] {
    return this.db
      .prepare('SELECT * FROM agents WHERE revoked = 0 ORDER BY name')
      .all()
      .map((r) => this.decorateAgent(parseRow<Agent>(r, AGENT_JSON)));
  }

  /** Her istekte çağrılır: presence günceller. */
  touch(agent: string): void {
    const prev = this.db.prepare('SELECT last_seen, status FROM agents WHERE name = ?').get(agent) as
      | { last_seen: number | null; status: string }
      | undefined;
    const wasOffline = !prev?.last_seen || now() - prev.last_seen > ONLINE_MS;
    this.db
      .prepare("UPDATE agents SET last_seen = ?, status = CASE WHEN status = 'offline' THEN 'idle' ELSE status END WHERE name = ?")
      .run(now(), agent);
    if (wasOffline) {
      this.log('agent.online', agent);
      this.emit({ type: 'agent', data: this.getAgent(agent) });
    }
  }

  setStatus(agent: string, status: AgentStatus, activity?: string | null, currentTask?: number | null): Agent {
    this.db
      .prepare('UPDATE agents SET status = ?, activity = ?, current_task = COALESCE(?, current_task), last_seen = ? WHERE name = ?')
      .run(status, activity ?? null, currentTask ?? null, now(), agent);
    if (status === 'error') this.log('agent.error', agent, { activity }, 'error');
    const a = this.getAgent(agent)!;
    this.emit({ type: 'agent', data: a });
    return a;
  }

  // ---------------------------------------------------------------- odalar
  ensureRoom(name: string, topic: string | null, repo: string | null, by: string): void {
    assertName(name, 'room name');
    this.db
      .prepare('INSERT OR IGNORE INTO rooms (name, topic, repo, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, topic, repo, by, now());
  }

  createRoom(name: string, topic: string | null, repo: string | null, by: string): unknown {
    this.ensureRoom(name, topic, repo, by);
    if (topic !== null || repo !== null) {
      this.db
        .prepare('UPDATE rooms SET topic = COALESCE(?, topic), repo = COALESCE(?, repo) WHERE name = ?')
        .run(topic, repo, name);
    }
    this.log('room.created', by, { name, topic, repo });
    return this.getRoom(name);
  }

  getRoom(name: string): Record<string, unknown> | null {
    const r = this.db.prepare('SELECT * FROM rooms WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    if (!r) return null;
    // Notlar uzun olabilir: oda kaydında yalnızca var olup olmadığı görünür, metin getNotes ile okunur.
    const { notes, notes_by: _by, notes_at: _at, ...rest } = r;
    return { ...rest, has_notes: !!notes };
  }

  // ---------------------------------------------------------------- oda notları
  /** Odanın ortak notları (depo haritası): yeni oturumlar kodu baştan taramak yerine bunu okur. */
  getNotes(room: string): { notes: string; by: string | null; at: number | null } {
    this.requireRoom(room, false);
    const r = this.db.prepare('SELECT notes, notes_by, notes_at FROM rooms WHERE name = ?').get(room) as
      | { notes: string | null; notes_by: string | null; notes_at: number | null }
      | undefined;
    return { notes: r?.notes ?? '', by: r?.notes_by ?? null, at: r?.notes_at ?? null };
  }

  /** set: notların tamamını değiştirir (orkestratör/admin); append: sona kısa bir bilgi ekler (herkes). */
  writeNotes(agent: string, room: string, action: 'set' | 'append', body: string): { notes: string; by: string | null; at: number | null } {
    this.requireRoom(room);
    const a = this.getAgent(agent);
    if (action === 'set' && a?.role !== 'orchestrator' && a?.role !== 'admin') {
      throw new RoomError('Only orchestrators replace the room notes; use action="append" to add a short fact');
    }
    const text = body.trim();
    if (!text) throw new RoomError('Notes body is empty');
    const cur = this.getNotes(room).notes;
    const next = action === 'set' ? text : `${cur.trimEnd()}${cur.trim() ? '\n' : ''}- ${text.replace(/^-\s*/, '')} (${agent})`;
    if (next.length > NOTES_MAX) {
      throw new RoomError(`Room notes would be ${next.length} chars (max ${NOTES_MAX}). Keep them a short map; an orchestrator can condense them with action="set"`);
    }
    this.db.prepare('UPDATE rooms SET notes = ?, notes_by = ?, notes_at = ? WHERE name = ?').run(next, agent, now(), room);
    this.log('room.notes', agent, { room, action, chars: next.length });
    this.emit({ type: 'room', room, data: this.getRoom(room) });
    return this.getNotes(room);
  }

  listRooms(opts: { includeClosed?: boolean } = {}): unknown[] {
    return this.db
      .prepare(
        `SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.room = r.name) AS members,
                (SELECT json_group_array(m.agent) FROM memberships m WHERE m.room = r.name) AS member_names,
                (SELECT COUNT(*) FROM tasks t WHERE t.room = r.name AND t.status NOT IN ('done','failed','cancelled')) AS open_tasks,
                (SELECT COUNT(*) FROM consults c WHERE c.room = r.name AND c.status = 'open') AS open_consults
         FROM rooms r ${opts.includeClosed ? '' : 'WHERE r.closed_at IS NULL'} ORDER BY r.closed_at IS NOT NULL, r.name`,
      )
      .all()
      .map((r) => parseRow(r, ['member_names']));
  }

  isClosed(name: string): boolean {
    return !!this.getRoom(name)?.closed_at;
  }

  /** Oda var olmalı; yazma işlemleri için ayrıca açık olmalı. */
  private requireRoom(name: string, open = true): void {
    const r = this.getRoom(name);
    if (!r) throw new RoomError(`Room not found: ${name} (create it first with room_create)`);
    if (open && r.closed_at) throw new RoomError(`Room "${name}" is closed (by ${r.closed_by}). Stop working in this room and leave it.`);
  }

  /** Odayı kapatır: açık görevler iptal edilir, üyelere "masadan kalkın" bildirimi gider. */
  closeRoom(name: string, by: string, reason?: string): unknown {
    if (name === 'lobby') throw new RoomError('The lobby cannot be closed');
    this.requireRoom(name);
    const open = this.listTasks({ room: name, status: ['open', 'claimed', 'in_progress', 'review'], limit: 500 });
    tx(this.db, () => {
      for (const t of open) {
        this.db.prepare("UPDATE tasks SET status = 'cancelled', lease_until = NULL, error = ?, updated_at = ? WHERE id = ?").run(`room closed by ${by}`, now(), t.id);
        releaseTaskReservations(this, t.id);
      }
      this.db.prepare('UPDATE rooms SET closed_at = ?, closed_by = ? WHERE name = ?').run(now(), by, name);
      this.db.prepare("UPDATE consults SET status = 'closed', decision = COALESCE(decision, 'room closed'), closed_at = ? WHERE room = ? AND status = 'open'").run(now(), name);
    });
    const members = this.members(name).filter((m) => m !== by);
    this.systemMessage(
      name,
      `🔒 Room closed by ${by}${reason ? `: ${reason}` : ''}. ${open.length} open task(s) cancelled. All agents: stop working in this room and leave the table.`,
      null,
      members,
    );
    for (const m of members) {
      const a = this.getAgent(m);
      if (a?.current_task && open.some((t) => t.id === a.current_task)) this.setStatus(m, 'idle', null, null);
    }
    this.log('room.closed', by, { name, reason, cancelled: open.length }, 'warn');
    this.emit({ type: 'task', room: name, data: null });
    return this.getRoom(name);
  }

  reopenRoom(name: string, by: string): unknown {
    this.requireRoom(name, false);
    this.db.prepare('UPDATE rooms SET closed_at = NULL, closed_by = NULL WHERE name = ?').run(name);
    this.systemMessage(name, `🔓 Room reopened by ${by}`);
    this.log('room.reopened', by, { name });
    return this.getRoom(name);
  }

  join(agent: string, room: string): { room: unknown; members: string[]; recent: Message[] } {
    this.requireRoom(room);
    const r = this.db
      .prepare('INSERT OR IGNORE INTO memberships (agent, room, last_read, joined_at) VALUES (?, ?, 0, ?)')
      .run(agent, room, now());
    if (r.changes > 0) this.systemMessage(room, `${agent} joined the table`);
    if (this.getAgent(agent)?.role === 'orchestrator') this.ensureChair(room);
    const recent = this.history(agent, room, { limit: 20 });
    // Katılımda imleci sona çek: agent yalnızca bundan sonraki mesajlar için beklesin.
    this.markRead(agent, room, this.lastMessageId(room));
    return { room: this.getRoom(room), members: this.members(room), recent };
  }

  leave(agent: string, room: string): void {
    const r = this.db.prepare('DELETE FROM memberships WHERE agent = ? AND room = ?').run(agent, room);
    if (r.changes > 0) this.systemMessage(room, `${agent} left the table`);
    if (r.changes > 0 && this.chairOf(room) === agent) this.ensureChair(room);
  }

  members(room: string): string[] {
    return (this.db.prepare('SELECT agent FROM memberships WHERE room = ? ORDER BY agent').all(room) as { agent: string }[]).map(
      (r) => r.agent,
    );
  }

  roomsOf(agent: string): string[] {
    return (this.db.prepare('SELECT room FROM memberships WHERE agent = ?').all(agent) as { room: string }[]).map((r) => r.room);
  }

  // ---------------------------------------------------------------- mesajlar
  private lastMessageId(room: string): number {
    const r = this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE room = ?').get(room) as { id: number | null };
    return r.id ?? 0;
  }

  private insertMessage(m: Omit<Message, 'id' | 'created_at'>): Message {
    const r = this.db
      .prepare(
        'INSERT INTO messages (room, sender, kind, body, mentions, recipient, thread_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(m.room, m.sender, m.kind, m.body, JSON.stringify(m.mentions), m.recipient, m.thread_id, m.task_id, now());
    const msg = parseRow<Message>(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid), MSG_JSON);
    this.emit({ type: 'message', room: m.room, data: msg });
    return msg;
  }

  systemMessage(room: string, body: string, taskId: number | null = null, mentions: string[] = []): Message {
    return this.insertMessage({
      room,
      sender: 'system',
      kind: taskId ? 'task' : 'system',
      body,
      mentions,
      recipient: null,
      thread_id: null,
      task_id: taskId,
    });
  }

  send(
    agent: string,
    input: { room: string; body: string; to?: string | null; thread_id?: number | null; task_id?: number | null },
  ): Message {
    this.requireRoom(input.room);
    if (!input.body.trim()) throw new RoomError('Message body is empty');
    if (input.body.length > 20_000) throw new RoomError('Message too long (max 20,000 chars); share long output as an artifact instead');
    if (!this.roomsOf(agent).includes(input.room)) this.join(agent, input.room);
    const mentions = extractMentions(input.body);
    if (input.to) {
      if (!this.getAgent(input.to)) throw new RoomError(`Recipient agent not found: ${input.to}`);
      if (!mentions.includes(input.to)) mentions.push(input.to);
    }
    return this.insertMessage({
      room: input.room,
      sender: agent,
      kind: input.to ? 'dm' : 'chat',
      body: input.body,
      mentions,
      recipient: input.to ?? null,
      thread_id: input.thread_id ?? null,
      task_id: input.task_id ?? null,
    });
  }

  /** Agent'ın görebileceği mesajlar: DM'ler yalnız gönderen/alıcıya görünür. */
  private visibleClause(): string {
    return "(kind != 'dm' OR sender = :agent OR recipient = :agent)";
  }

  history(agent: string | null, room: string, opts: { since_id?: number; before_id?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(opts.limit ?? 50, 200);
    const vis = agent ? `AND ${this.visibleClause()}` : '';
    const params: Record<string, string | number> = { room, limit };
    if (agent) params.agent = agent;
    let rows: unknown[];
    if (opts.since_id !== undefined) {
      params.since = opts.since_id;
      rows = this.db
        .prepare(`SELECT * FROM messages WHERE room = :room AND id > :since ${vis} ORDER BY id ASC LIMIT :limit`)
        .all(params);
    } else {
      const before = opts.before_id !== undefined ? 'AND id < :before' : '';
      if (opts.before_id !== undefined) params.before = opts.before_id;
      rows = this.db
        .prepare(`SELECT * FROM (SELECT * FROM messages WHERE room = :room ${before} ${vis} ORDER BY id DESC LIMIT :limit) ORDER BY id ASC`)
        .all(params);
    }
    return rows.map((r) => parseRow<Message>(r, MSG_JSON));
  }

  markRead(agent: string, room: string, id: number): void {
    this.db.prepare('UPDATE memberships SET last_read = MAX(last_read, ?) WHERE agent = ? AND room = ?').run(id, agent, room);
  }

  /** Katıldığı tüm odalardaki okunmamış mesajlar (kendi mesajları hariç). */
  unread(agent: string, opts: { rooms?: string[]; mentionsOnly?: boolean; limit?: number } = {}): Message[] {
    const rooms = opts.rooms?.length ? opts.rooms : this.roomsOf(agent);
    const out: Message[] = [];
    for (const room of rooms) {
      const m = this.db.prepare('SELECT last_read FROM memberships WHERE agent = ? AND room = ?').get(agent, room) as
        | { last_read: number }
        | undefined;
      if (!m) continue;
      const rows = this.db
        .prepare(
          `SELECT * FROM messages WHERE room = :room AND id > :since AND sender != :agent AND ${this.visibleClause()} ORDER BY id ASC LIMIT :limit`,
        )
        .all({ room, since: m.last_read, agent, limit: Math.min(opts.limit ?? 50, 200) });
      out.push(...rows.map((r) => parseRow<Message>(r, MSG_JSON)));
    }
    out.sort((a, b) => a.id - b.id);
    return opts.mentionsOnly ? out.filter((m) => m.mentions.includes(agent) || m.recipient === agent) : out;
  }

  /**
   * Uzun-yoklama (long-poll): yeni mesaj gelene ya da süre dolana kadar bekler.
   * LLM agent'ları push alamadığı için "bekle" bir araç çağrısıdır.
   */
  async waitForMessages(
    agent: string,
    opts: { rooms?: string[]; mentionsOnly?: boolean; timeoutMs: number; signal?: AbortSignal },
  ): Promise<Message[]> {
    const collect = (): Message[] => {
      const msgs = this.unread(agent, { rooms: opts.rooms, mentionsOnly: opts.mentionsOnly });
      // Okundu olarak işaretle (mentionsOnly'de bile imleç ilerler; atlanan mesajlar history ile okunabilir).
      const all = this.unread(agent, { rooms: opts.rooms });
      const maxByRoom = new Map<string, number>();
      for (const m of all) maxByRoom.set(m.room, Math.max(maxByRoom.get(m.room) ?? 0, m.id));
      if (msgs.length) for (const [room, id] of maxByRoom) this.markRead(agent, room, id);
      return msgs;
    };
    const first = collect();
    if (first.length || opts.timeoutMs <= 0) return first;
    return new Promise<Message[]>((resolve) => {
      let done = false;
      const finish = (v: Message[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.bus.off('event', onEvent);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onEvent = (ev: BusEvent) => {
        if (ev.type !== 'message') return;
        const m = ev.data as Message;
        if (m.sender === agent) return;
        // Olay tetikleyicisi; asıl veri DB'den okunur (tutarlılık için).
        setImmediate(() => {
          const got = collect();
          if (got.length) finish(got);
        });
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), opts.timeoutMs);
      this.bus.on('event', onEvent);
      opts.signal?.addEventListener('abort', onAbort);
    });
  }

  // ---------------------------------------------------------------- uyandırma (oturumsuz bekleme)
  /**
   * Boşta bekleyen agent'ın model oturumu açması gerekiyor mu? Model hiç çalışmadan sunucuda bakılır:
   * agent'a düşen/alınabilir görev, ondan bahseden mesaj ya da DM, cevap bekleyen istişare;
   * orkestratör için ayrıca insanların odaya yazdıkları. Tetikleyen mesajlar okundu sayılır ve
   * notta verilir; böylece aynı mesaj ikinci bir oturum açtırmaz.
   */
  wakeCheck(agentName: string, room: string, opts: { immediate?: boolean } = {}): WakeResult | null {
    const agent = this.getAgent(agentName);
    if (!agent) throw new RoomError(`Agent not found: ${agentName}`);
    if (!this.getRoom(room)) throw new RoomError(`Room not found: ${room}`);
    if (this.isClosed(room)) return { closed: true, reasons: ['room closed'], note: '' };
    const orch = agent.role === 'orchestrator' || agent.role === 'admin';
    // İlk uyandırmada odaya katıl (imleç sona çekilir: eski mesajlar uyandırmaz).
    if (!this.roomsOf(agentName).includes(room)) this.join(agentName, room);

    const reasons: string[] = [];
    const lines: string[] = [];

    const consults = this.pendingConsults(agentName).filter((c) => c.room === room);
    if (consults.length) {
      reasons.push('consultation');
      lines.push(`Consultations await your reply: ${consults.map((c) => `C${c.id}${c.kind === 'election' ? ' (chair election)' : ''} by @${c.asker}`).join(', ')} → consult_get(id), then consult_reply(id, ...).`);
    }

    const unread = this.unread(agentName, { rooms: [room], limit: 200 });
    const isHuman = (name: string) => {
      const a = this.getAgent(name);
      return a?.kind === 'human' || a?.role === 'admin';
    };
    const triggers = unread.filter(
      (m) => m.mentions.includes(agentName) || m.recipient === agentName || (orch && m.sender !== 'system' && isHuman(m.sender)),
    );
    if (triggers.length) {
      reasons.push('message');
      lines.push(`Messages for you (already marked read; read_messages(room) shows the full history):\n${fmtMessages(triggers.slice(-30))}`);
    }

    const open = this.listTasks({ room, status: ['open'], limit: 500 });
    const claimable = open.filter((t) => this.claimable(t, agent).ok && (!orch || t.assignee === agentName));
    if (claimable.length) {
      reasons.push('task');
      lines.push(`Claimable tasks for you: ${claimable.slice(0, 5).map((t) => `#${t.id} "${t.title}"${t.assignee ? ' (assigned to you)' : ''}`).join(', ')} → task_next(room="${room}").`);
    }

    // İşçinin yarıda kalmış görevi (oturum bitti/çöktü). "blocked" bekleyen işçi ancak bir mesajla uyanır.
    if (!orch && agent.status !== 'blocked') {
      const mine = this.listTasks({ room, assignee: agentName, status: ACTIVE_STATUSES, limit: 20 });
      if (mine.length) {
        reasons.push('active task');
        lines.push(`You hold unfinished tasks: ${mine.map((t) => `#${t.id} "${t.title}" (${t.status}${t.progress ? `, progress: ${t.progress.slice(0, 200)}` : ''})`).join(', ')} → task_get(id) and continue.`);
      }
    }

    if (!reasons.length && !opts.immediate) return null;

    // Bağlam (uyandırma sebebi değil): orkestratörün yürüttüğü planlar.
    if (orch) {
      const plans = this.listTasks({ room, assignee: agentName, status: ['in_progress', 'claimed'], limit: 20 }).filter(
        (t) => this.listTasks({ parent_id: t.id, limit: 1 }).length > 0,
      );
      if (plans.length) {
        lines.push(`Plans you lead (continue them; do not create a new plan for the same goal): ${plans.map((t) => `#${t.id} "${t.title}"${t.progress ? ` — your last note: ${t.progress.slice(0, 300)}` : ''}`).join('; ')}. task_tree(id) shows their state.`);
      }
    }
    if (unread.length) this.markRead(agentName, room, Math.max(...unread.map((m) => m.id)));
    return {
      closed: false,
      reasons,
      note: `WHY THIS SESSION STARTED: ${reasons.length ? reasons.join(', ') : 'session start'}.\n${lines.join('\n')}`.trim(),
    };
  }

  /** Uyandırma sebebi oluşana ya da süre dolana kadar bekler; bekleyen agent çevrimiçi sayılır. */
  async waitForWake(
    agentName: string,
    room: string,
    opts: { timeoutMs: number; immediate?: boolean; signal?: AbortSignal },
  ): Promise<WakeResult | null> {
    this.touch(agentName);
    const a = this.getAgent(agentName)!;
    if (a.status !== 'blocked') this.setStatus(agentName, 'idle', 'waiting for work (no model session running)');
    const first = this.wakeCheck(agentName, room, { immediate: opts.immediate });
    if (first || opts.timeoutMs <= 0) return first;
    return new Promise<WakeResult | null>((resolve) => {
      let done = false;
      let pending = false;
      const finish = (v: WakeResult | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(tick);
        this.bus.off('event', onEvent);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const check = () => {
        if (done) return;
        try {
          const r = this.wakeCheck(agentName, room);
          if (r) finish(r);
        } catch {
          finish(null);
        }
      };
      const onEvent = (ev: BusEvent) => {
        if (ev.type === 'agent' || ev.type === 'event' || ev.type === 'reservation' || pending) return;
        pending = true;
        setImmediate(() => {
          pending = false;
          check();
        });
      };
      const onAbort = () => finish(null);
      // Bekleme boyunca agent çevrimiçi görünür (istişarelere davet edilir, başkanlığı düşmez).
      const tick = setInterval(() => {
        this.touch(agentName);
        check();
      }, 20_000);
      const timer = setTimeout(() => finish(null), opts.timeoutMs);
      this.bus.on('event', onEvent);
      opts.signal?.addEventListener('abort', onAbort);
    });
  }

  // ---------------------------------------------------------------- görevler
  getTask(id: number): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? parseRow<Task>(row, TASK_JSON) : null;
  }

  private requireTask(id: number): Task {
    const t = this.getTask(id);
    if (!t) throw new RoomError(`Task not found: #${id}`);
    return t;
  }

  createTask(
    by: string,
    input: {
      room: string;
      title: string;
      description?: string;
      parent_id?: number | null;
      assignee?: string | null;
      priority?: number;
      capabilities?: string[];
      depends_on?: number[];
    },
  ): Task {
    this.requireRoom(input.room);
    if (input.assignee && !this.getAgent(input.assignee)) throw new RoomError(`Assignee agent not found: ${input.assignee}`);
    for (const d of input.depends_on ?? []) this.requireTask(d);
    if (input.parent_id) this.requireTask(input.parent_id);
    const r = this.db
      .prepare(
        `INSERT INTO tasks (room, parent_id, title, description, priority, capabilities, depends_on, created_by, assignee, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.room,
        input.parent_id ?? null,
        input.title,
        input.description ?? '',
        input.priority ?? 2,
        JSON.stringify(input.capabilities ?? []),
        JSON.stringify(input.depends_on ?? []),
        by,
        input.assignee ?? null,
        now(),
        now(),
      );
    const t = this.getTask(Number(r.lastInsertRowid))!;
    const who = t.assignee ? ` → @${t.assignee}` : '';
    this.systemMessage(t.room, `New task #${t.id}: ${t.title}${who} (created by ${by})`, t.id, t.assignee ? [t.assignee] : []);
    this.log('task.created', by, { id: t.id, title: t.title, assignee: t.assignee });
    this.emit({ type: 'task', room: t.room, data: t });
    return t;
  }

  /** Orkestratör planı: bir üst görev + bağımlılıklı alt görevler, tek işlemde. */
  createPlan(
    by: string,
    input: {
      room: string;
      goal: string;
      description?: string;
      parent_id?: number | null;
      consult_id?: number | null;
      subtasks: {
        key: string;
        title: string;
        description?: string;
        assignee?: string | null;
        priority?: number;
        capabilities?: string[];
        depends_on?: string[];
      }[];
    },
  ): { parent: Task; subtasks: Task[] } {
    if (input.subtasks.length > 50) throw new RoomError('A plan can have at most 50 subtasks');
    const keys = new Set(input.subtasks.map((s) => s.key));
    if (keys.size !== input.subtasks.length) throw new RoomError('Subtask keys must be unique');
    for (const s of input.subtasks) for (const d of s.depends_on ?? []) if (!keys.has(d)) throw new RoomError(`Unknown dependency: ${s.key} → ${d}`);
    // Topolojik sıra (döngü kontrolü)
    const order: typeof input.subtasks = [];
    const state = new Map<string, number>();
    const byKey = new Map(input.subtasks.map((s) => [s.key, s]));
    const visit = (k: string) => {
      if (state.get(k) === 2) return;
      if (state.get(k) === 1) throw new RoomError(`Dependency cycle at: ${k}`);
      state.set(k, 1);
      for (const d of byKey.get(k)!.depends_on ?? []) visit(d);
      state.set(k, 2);
      order.push(byKey.get(k)!);
    };
    for (const s of input.subtasks) visit(s.key);
    const consult = input.consult_id ? this.requireConsult(input.consult_id) : null;
    const description = [input.description ?? '', consult ? `Consulted the table: C${consult.id}${consult.decision ? ` → ${consult.decision}` : ''}` : '']
      .filter(Boolean)
      .join('\n\n');

    return tx(this.db, () => {
      const parent = this.createTask(by, { room: input.room, title: input.goal, description, parent_id: input.parent_id ?? null, priority: 1 });
      if (consult) this.db.prepare('UPDATE consults SET task_id = COALESCE(task_id, ?) WHERE id = ?').run(parent.id, consult.id);
      this.db.prepare("UPDATE tasks SET status = 'in_progress', assignee = ? WHERE id = ?").run(by, parent.id);
      const idByKey = new Map<string, number>();
      const subtasks: Task[] = [];
      for (const s of order) {
        const t = this.createTask(by, {
          room: input.room,
          title: s.title,
          description: s.description,
          parent_id: parent.id,
          assignee: s.assignee ?? null,
          priority: s.priority,
          capabilities: s.capabilities,
          depends_on: (s.depends_on ?? []).map((d) => idByKey.get(d)!),
        });
        idByKey.set(s.key, t.id);
        subtasks.push(t);
      }
      return { parent: this.getTask(parent.id)!, subtasks };
    });
  }

  listTasks(filter: { room?: string; status?: string[]; assignee?: string; parent_id?: number; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.room) {
      where.push('room = ?');
      params.push(filter.room);
    }
    if (filter.status?.length) {
      where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.assignee) {
      where.push('assignee = ?');
      params.push(filter.assignee);
    }
    if (filter.parent_id !== undefined) {
      where.push('parent_id = ?');
      params.push(filter.parent_id);
    }
    params.push(Math.min(filter.limit ?? 100, 500));
    return this.db
      .prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority ASC, id ASC LIMIT ?`)
      .all(...params)
      .map((r) => parseRow<Task>(r, TASK_JSON));
  }

  private depsDone(t: Task): boolean {
    return t.depends_on.every((d) => this.getTask(d)?.status === 'done');
  }

  /** Görev bu agent tarafından şu an alınabilir mi? */
  claimable(t: Task, agent: Agent): { ok: boolean; reason?: string } {
    if (t.status !== 'open') return { ok: false, reason: `status is ${t.status}` };
    if (t.assignee && t.assignee !== agent.name) return { ok: false, reason: `reserved for @${t.assignee}` };
    if (!this.depsDone(t)) return { ok: false, reason: `waiting on dependencies: ${t.depends_on.map((d) => '#' + d).join(', ')}` };
    const missing = t.capabilities.filter((c) => !agent.capabilities.includes(c));
    if (missing.length && !t.assignee) return { ok: false, reason: `missing capabilities: ${missing.join(', ')}` };
    return { ok: true };
  }

  claim(agentName: string, id: number, leaseMin = DEFAULT_LEASE_MIN): Task {
    const agent = this.getAgent(agentName)!;
    return tx(this.db, () => {
      const t = this.requireTask(id);
      const c = this.claimable(t, agent);
      if (!c.ok) throw new RoomError(`#${id} cannot be claimed: ${c.reason}`);
      // İyimser kilit: yalnızca hâlâ 'open' ise güncelle (yarış durumlarına karşı).
      const r = this.db
        .prepare("UPDATE tasks SET status = 'claimed', assignee = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'open'")
        .run(agentName, now() + leaseMin * 60_000, now(), id);
      if (r.changes === 0) throw new RoomError(`#${id} was just claimed by another agent`);
      this.setStatus(agentName, 'working', `#${id} ${t.title}`, id);
      const nt = this.getTask(id)!;
      this.systemMessage(t.room, `@${agentName} claimed #${id} ${t.title}`, id);
      this.log('task.claimed', agentName, { id });
      this.emit({ type: 'task', room: t.room, data: nt });
      return nt;
    });
  }

  /** Sıradaki en uygun görevi bul ve atomik olarak al: önce bana atananlar, sonra önceliğe göre. */
  claimNext(agentName: string, opts: { room?: string; leaseMin?: number } = {}): Task | null {
    const agent = this.getAgent(agentName)!;
    const rooms = opts.room ? [opts.room] : this.roomsOf(agentName);
    const candidates = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'open' AND (assignee IS NULL OR assignee = ?)
         ORDER BY (assignee = ?) DESC, priority ASC, id ASC LIMIT 200`,
      )
      .all(agentName, agentName)
      .map((r) => parseRow<Task>(r, TASK_JSON))
      .filter((t) => rooms.includes(t.room) && this.claimable(t, agent).ok);
    for (const t of candidates) {
      try {
        return this.claim(agentName, t.id, opts.leaseMin);
      } catch (e) {
        if (!(e instanceof RoomError)) throw e;
      }
    }
    return null;
  }

  private requireOwner(t: Task, agent: string, allowOrchestrator = true): void {
    if (t.assignee === agent) return;
    const a = this.getAgent(agent);
    if (allowOrchestrator && (a?.role === 'orchestrator' || a?.role === 'admin' || t.created_by === agent)) return;
    throw new RoomError(`#${t.id} is not yours (assignee: ${t.assignee ?? 'none'})`);
  }

  update(
    agent: string,
    id: number,
    input: { status?: 'in_progress' | 'review' | 'open'; progress?: string; branch?: string; lease_minutes?: number },
  ): Task {
    const t = this.requireTask(id);
    this.requireOwner(t, agent);
    if (FINAL_STATUSES.includes(t.status)) throw new RoomError(`#${id} is already ${t.status}`);
    const status = input.status ?? (t.status === 'claimed' ? 'in_progress' : t.status);
    const release = status === 'open';
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, progress = COALESCE(?, progress), branch = COALESCE(?, branch),
         lease_until = ?, assignee = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        input.progress ?? null,
        input.branch ?? null,
        release ? null : now() + (input.lease_minutes ?? DEFAULT_LEASE_MIN) * 60_000,
        release ? null : t.assignee,
        now(),
        id,
      );
    if (release) {
      this.systemMessage(t.room, `#${id} released, open again: ${input.progress ?? ''}`.trim(), id);
      this.setStatus(agent, 'idle', null, null);
    } else if (input.progress) {
      this.setStatus(agent, status === 'review' ? 'idle' : 'working', `#${id} ${input.progress}`, id);
    }
    if (status === 'review') this.systemMessage(t.room, `#${id} ready for review: ${t.title}`, id, [t.created_by]);
    const nt = this.getTask(id)!;
    this.log('task.updated', agent, { id, status, progress: input.progress });
    this.emit({ type: 'task', room: t.room, data: nt });
    return nt;
  }

  complete(agent: string, id: number, input: { result: string; artifacts?: Artifact[] }): Task {
    const t = this.requireTask(id);
    this.requireOwner(t, agent);
    if (FINAL_STATUSES.includes(t.status)) throw new RoomError(`#${id} is already ${t.status}`);
    this.db
      .prepare("UPDATE tasks SET status = 'done', result = ?, artifacts = ?, lease_until = NULL, updated_at = ? WHERE id = ?")
      .run(input.result, JSON.stringify(input.artifacts ?? []), now(), id);
    releaseTaskReservations(this, id);
    this.setStatus(agent, 'idle', null, null);
    this.db.prepare('UPDATE agents SET current_task = NULL WHERE name = ?').run(agent);
    this.systemMessage(t.room, `✅ #${id} done (@${agent}): ${t.title}`, id, [t.created_by]);
    this.log('task.done', agent, { id });
    this.unblockDependents(id);
    this.checkParent(t.parent_id);
    const nt = this.getTask(id)!;
    this.emit({ type: 'task', room: t.room, data: nt });
    return nt;
  }

  fail(agent: string, id: number, error: string, retry = false): Task {
    const t = this.requireTask(id);
    this.requireOwner(t, agent);
    if (retry) {
      this.db
        .prepare("UPDATE tasks SET status = 'open', assignee = NULL, lease_until = NULL, error = ?, updated_at = ? WHERE id = ?")
        .run(error, now(), id);
      this.systemMessage(t.room, `⚠️ #${id} failed and was reopened (@${agent}): ${error}`, id, [t.created_by]);
    } else {
      this.db.prepare("UPDATE tasks SET status = 'failed', error = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(error, now(), id);
      this.systemMessage(t.room, `❌ #${id} failed (@${agent}): ${error}`, id, [t.created_by]);
    }
    releaseTaskReservations(this, id);
    this.setStatus(agent, 'idle', null, null);
    this.log('task.failed', agent, { id, error, retry }, 'error');
    const nt = this.getTask(id)!;
    this.emit({ type: 'task', room: t.room, data: nt });
    this.checkParent(t.parent_id);
    return nt;
  }

  /** Orkestratör/oluşturan: görevi geri bildirimle yeniden aç, iptal et veya yeniden ata. */
  review(
    agent: string,
    id: number,
    input: { action: 'approve' | 'reopen' | 'cancel' | 'reassign'; feedback?: string; assignee?: string | null },
  ): Task {
    const t = this.requireTask(id);
    const a = this.getAgent(agent);
    if (t.created_by !== agent && a?.role !== 'orchestrator' && a?.role !== 'admin') {
      throw new RoomError('Only the task creator or an orchestrator can review');
    }
    const fb = input.feedback ? `: ${input.feedback}` : '';
    switch (input.action) {
      case 'approve':
        this.db.prepare("UPDATE tasks SET status = 'done', lease_until = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        this.systemMessage(t.room, `👍 #${id} approved (@${agent})${fb}`, id, t.assignee ? [t.assignee] : []);
        this.unblockDependents(id);
        this.checkParent(t.parent_id);
        break;
      case 'reopen':
        this.db
          .prepare("UPDATE tasks SET status = 'open', lease_until = NULL, error = ?, updated_at = ? WHERE id = ?")
          .run(input.feedback ?? null, now(), id);
        this.systemMessage(t.room, `🔁 #${id} reopened (@${agent})${fb}`, id, t.assignee ? [t.assignee] : []);
        break;
      case 'cancel':
        this.db.prepare("UPDATE tasks SET status = 'cancelled', lease_until = NULL, updated_at = ? WHERE id = ?").run(now(), id);
        this.systemMessage(t.room, `🚫 #${id} cancelled (@${agent})${fb}`, id);
        releaseTaskReservations(this, id);
        // Plan iptali: bitmemiş alt görevler de iptal edilir (işçiler artık alamasın).
        for (const k of this.listTasks({ parent_id: id, limit: 500 })) {
          if (!FINAL_STATUSES.includes(k.status)) this.review(agent, k.id, { action: 'cancel', feedback: `parent plan #${id} was cancelled` });
        }
        break;
      case 'reassign':
        if (input.assignee && !this.getAgent(input.assignee)) throw new RoomError(`Agent not found: ${input.assignee}`);
        this.db
          .prepare("UPDATE tasks SET status = 'open', assignee = ?, lease_until = NULL, updated_at = ? WHERE id = ?")
          .run(input.assignee ?? null, now(), id);
        this.systemMessage(t.room, `↪️ #${id} reassigned → ${input.assignee ? '@' + input.assignee : 'anyone'}${fb}`, id, input.assignee ? [input.assignee] : []);
        break;
    }
    this.log('task.review', agent, { id, ...input });
    const nt = this.getTask(id)!;
    this.emit({ type: 'task', room: t.room, data: nt });
    return nt;
  }

  private unblockDependents(id: number): void {
    const deps = this.db
      .prepare("SELECT * FROM tasks WHERE status = 'open' AND depends_on LIKE ?")
      .all(`%${id}%`)
      .map((r) => parseRow<Task>(r, TASK_JSON))
      .filter((t) => t.depends_on.includes(id) && this.depsDone(t));
    for (const t of deps) {
      this.systemMessage(t.room, `🔓 #${t.id} is now claimable: ${t.title}`, t.id, t.assignee ? [t.assignee] : []);
    }
  }

  /** Tüm alt görevler bittiğinde üst görevin sahibine (orkestratöre) haber ver. */
  private checkParent(parentId: number | null): void {
    if (!parentId) return;
    const parent = this.getTask(parentId);
    if (!parent) return;
    const kids = this.listTasks({ parent_id: parentId, limit: 500 });
    if (kids.length && kids.every((k) => FINAL_STATUSES.includes(k.status))) {
      const failed = kids.filter((k) => k.status === 'failed').length;
      const owner = parent.assignee ?? parent.created_by;
      this.systemMessage(
        parent.room,
        `🏁 All subtasks of plan #${parentId} "${parent.title}" are finished (${kids.length - failed} succeeded, ${failed} failed). @${owner} can collect results: task_tree(${parentId})`,
        parentId,
        [owner],
      );
    }
  }

  tree(id: number): Task & { children: Task[] } {
    const t = this.requireTask(id);
    const children = this.listTasks({ parent_id: id, limit: 500 }).map((c) => this.tree(c.id));
    return { ...t, children };
  }

  // ---------------------------------------------------------------- dosya rezervasyonları
  reserve(
    agent: string,
    input: { repo: string; paths: string[]; exclusive?: boolean; ttl_minutes?: number; reason?: string; task_id?: number | null },
  ): { granted: Reservation[]; conflicts: (Reservation & { requested: string })[] } {
    this.sweepReservations();
    const exclusive = input.exclusive ?? true;
    return tx(this.db, () => {
      const active = this.listReservations({ repo: input.repo }).filter((r) => r.agent !== agent);
      const conflicts: (Reservation & { requested: string })[] = [];
      for (const p of input.paths) {
        for (const r of active) {
          if ((exclusive || r.exclusive) && patternsOverlap(p, r.pattern)) conflicts.push({ ...r, requested: p });
        }
      }
      if (conflicts.length) return { granted: [], conflicts };
      const granted: Reservation[] = [];
      const exp = now() + (input.ttl_minutes ?? 60) * 60_000;
      for (const p of input.paths) {
        // Aynı agent aynı deseni tekrar isterse süreyi uzat.
        this.db.prepare('DELETE FROM reservations WHERE agent = ? AND repo = ? AND pattern = ?').run(agent, input.repo, normPath(p));
        const r = this.db
          .prepare('INSERT INTO reservations (agent, repo, pattern, exclusive, reason, task_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(agent, input.repo, normPath(p), exclusive ? 1 : 0, input.reason ?? null, input.task_id ?? null, exp, now());
        granted.push(this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(r.lastInsertRowid) as unknown as Reservation);
      }
      this.log('files.reserved', agent, { repo: input.repo, paths: input.paths, exclusive });
      this.emit({ type: 'reservation', data: granted });
      return { granted, conflicts };
    });
  }

  release(agent: string, input: { repo?: string; paths?: string[]; all?: boolean }): number {
    let n = 0;
    if (input.all || !input.paths?.length) {
      n = Number(
        (input.repo
          ? this.db.prepare('DELETE FROM reservations WHERE agent = ? AND repo = ?').run(agent, input.repo)
          : this.db.prepare('DELETE FROM reservations WHERE agent = ?').run(agent)
        ).changes,
      );
    } else {
      for (const p of input.paths) {
        n += Number(this.db.prepare('DELETE FROM reservations WHERE agent = ? AND repo = ? AND pattern = ?').run(agent, input.repo ?? '', normPath(p)).changes);
      }
    }
    if (n) {
      this.log('files.released', agent, { ...input, count: n });
      this.emit({ type: 'reservation', data: null });
    }
    return n;
  }

  listReservations(filter: { repo?: string; agent?: string } = {}): Reservation[] {
    const where = ['expires_at > ?'];
    const params: (string | number)[] = [now()];
    if (filter.repo) {
      where.push('repo = ?');
      params.push(filter.repo);
    }
    if (filter.agent) {
      where.push('agent = ?');
      params.push(filter.agent);
    }
    return this.db.prepare(`SELECT * FROM reservations WHERE ${where.join(' AND ')} ORDER BY repo, pattern`).all(...params) as unknown as Reservation[];
  }

  checkPaths(agent: string, repo: string, paths: string[]): { path: string; held_by: Reservation[] }[] {
    const active = this.listReservations({ repo }).filter((r) => r.agent !== agent);
    return paths.map((p) => ({ path: p, held_by: active.filter((r) => patternsOverlap(p, r.pattern)) }));
  }

  sweepReservations(): void {
    this.db.prepare('DELETE FROM reservations WHERE expires_at <= ?').run(now());
  }


  // ---------------------------------------------------------------- istişare (consult) & başkan (chair)
  getConsult(id: number): Consult | null {
    const row = this.db.prepare('SELECT * FROM consults WHERE id = ?').get(id);
    return row ? parseRow<Consult>(row, CONSULT_JSON) : null;
  }

  private requireConsult(id: number): Consult {
    const c = this.getConsult(id);
    if (!c) throw new RoomError(`Consultation not found: C${id}`);
    return c;
  }

  consultReplies(id: number): ConsultReply[] {
    return this.db.prepare('SELECT * FROM consult_replies WHERE consult_id = ? ORDER BY created_at').all(id) as unknown as ConsultReply[];
  }

  /** İstişare + yanıtlar + bekleyenler + (oylamada) sayım. */
  consultView(id: number): Consult & { replies: ConsultReply[]; pending: string[]; tally: Record<string, number> } {
    const c = this.requireConsult(id);
    const replies = this.consultReplies(id);
    const answered = new Set(replies.map((r) => r.agent));
    const tally: Record<string, number> = {};
    for (const o of c.options) tally[o] = 0;
    for (const r of replies) if (r.choice) tally[r.choice] = (tally[r.choice] ?? 0) + 1;
    return { ...c, replies, pending: c.invitees.filter((i) => !answered.has(i)), tally };
  }

  listConsults(filter: { room?: string; status?: 'open' | 'closed'; limit?: number } = {}): Consult[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.room) {
      where.push('room = ?');
      params.push(filter.room);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    params.push(Math.min(filter.limit ?? 50, 200));
    return this.db
      .prepare(`SELECT * FROM consults ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params)
      .map((r) => parseRow<Consult>(r, CONSULT_JSON));
  }

  /** Bu agent'tan yanıt bekleyen açık istişareler. */
  pendingConsults(agent: string): Consult[] {
    return this.db
      .prepare("SELECT * FROM consults WHERE status = 'open' AND invitees LIKE ? AND id NOT IN (SELECT consult_id FROM consult_replies WHERE agent = ?) ORDER BY id")
      .all(`%"${agent}"%`, agent)
      .map((r) => parseRow<Consult>(r, CONSULT_JSON))
      .filter((c) => c.invitees.includes(agent));
  }

  private isOnline(name: string, withinMs = ONLINE_MS): boolean {
    const a = this.getAgent(name);
    return !!a && !a.revoked && !!a.last_seen && now() - a.last_seen <= withinMs;
  }

  /** Masadan görüş/oy ister. Varsayılan davetliler: odadaki çevrimiçi tüm agent'lar (soran, gözlemci ve insanlar hariç). */
  openConsult(
    by: string,
    input: { room: string; question: string; options?: string[]; ask?: string[]; timeout_sec?: number; task_id?: number | null; kind?: ConsultKind },
  ): Consult {
    this.requireRoom(input.room);
    if (!input.question.trim()) throw new RoomError('Question is empty');
    if (input.question.length > 12_000) throw new RoomError('Question too long (max 12,000 chars); attach long drafts as a file artifact and link it');
    const options = [...new Set((input.options ?? []).map((o) => o.trim()).filter(Boolean))];
    const kind: ConsultKind = input.kind ?? (options.length ? 'vote' : 'opinion');
    if (kind !== 'opinion' && options.length < 2) throw new RoomError('A vote needs at least 2 distinct options');
    let invitees: string[];
    if (input.ask?.length) {
      invitees = [...new Set(input.ask.map((x) => x.replace(/^@/, '').toLowerCase()))];
      for (const i of invitees) if (!this.getAgent(i)) throw new RoomError(`Agent not found: ${i}`);
    } else {
      invitees = this.members(input.room).filter((m) => {
        const a = this.getAgent(m);
        return a && a.role !== 'observer' && a.kind !== 'human' && this.isOnline(m);
      });
    }
    invitees = invitees.filter((i) => i !== by);
    if (!invitees.length) throw new RoomError('Nobody to consult: no other online agent in this room. Decide on your own judgement, or ask a human in the room.');
    if (input.task_id) this.requireTask(input.task_id);
    const timeout = Math.min(Math.max(input.timeout_sec ?? 180, 30), 1800);
    const r = this.db
      .prepare(
        'INSERT INTO consults (room, asker, kind, question, options, invitees, task_id, deadline, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.room, by, kind, input.question.trim(), JSON.stringify(options), JSON.stringify(invitees), input.task_id ?? null, now() + timeout * 1000, now());
    const c = this.getConsult(Number(r.lastInsertRowid))!;
    const how = options.length ? `consult_reply(id=${c.id}, choice=<one option>, body=<short reason>)` : `consult_reply(id=${c.id}, body=<your view>)`;
    const title = kind === 'election' ? 'Chair election' : kind === 'vote' ? 'Vote' : 'Consultation';
    const body =
      `🗳️ **${title} C${c.id}**${by === 'system' ? '' : ` from @${by}`}: reply within ${Math.round(timeout / 60) || 1} min with ${how}\n\n` +
      `${c.question}` +
      (options.length ? `\n\nOptions: ${options.map((o) => '`' + o + '`').join(', ')}` : '') +
      `\n\nAsked: ${invitees.map((i) => '@' + i).join(' ')}`;
    if (by === 'system') this.systemMessage(input.room, body, input.task_id ?? null, invitees);
    else this.insertMessage({ room: input.room, sender: by, kind: 'chat', body, mentions: invitees, recipient: null, thread_id: null, task_id: input.task_id ?? null });
    this.log('consult.opened', by, { id: c.id, room: c.room, kind, invitees });
    this.emit({ type: 'consult', room: c.room, data: c });
    return c;
  }

  replyConsult(agent: string, id: number, input: { body: string; choice?: string | null }): Consult & { replies: ConsultReply[]; pending: string[]; tally: Record<string, number> } {
    const c = this.requireConsult(id);
    if (c.status !== 'open') throw new RoomError(`C${id} is already closed${c.decision ? `: ${c.decision}` : ''}`);
    this.requireRoom(c.room);
    if (c.kind === 'election' && !c.invitees.includes(agent)) throw new RoomError('Only the orchestrators at this table vote in a chair election');
    if (agent === c.asker) throw new RoomError('You opened this consultation; close it with consult_close when you have decided');
    if (!input.body.trim()) throw new RoomError('Reply body is empty');
    let choice: string | null = null;
    if (c.options.length) {
      const want = (input.choice ?? '').trim().replace(/^@/, '').toLowerCase();
      choice = c.options.find((o) => o.toLowerCase() === want) ?? null;
      if (!choice) throw new RoomError(`choice must be one of: ${c.options.join(', ')}`);
    }
    this.db
      .prepare('INSERT INTO consult_replies (consult_id, agent, body, choice, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (consult_id, agent) DO UPDATE SET body = excluded.body, choice = excluded.choice, created_at = excluded.created_at')
      .run(id, agent, input.body.trim(), choice, now());
    if (!this.roomsOf(agent).includes(c.room)) this.join(agent, c.room);
    this.insertMessage({
      room: c.room,
      sender: agent,
      kind: 'chat',
      body: `💬 **C${id}**${choice ? ` → **${choice}**` : ''}: ${input.body.trim()}`,
      mentions: c.asker === 'system' ? [] : [c.asker],
      recipient: null,
      thread_id: null,
      task_id: c.task_id,
    });
    this.log('consult.replied', agent, { id, choice });
    const view = this.consultView(id);
    if (!view.pending.length) {
      if (c.kind === 'election') this.resolveElection(id);
      else this.systemMessage(c.room, `📥 Everyone answered C${id}. @${c.asker}: read them with consult_get(${id}), decide, then consult_close(${id}, decision).`, c.task_id, [c.asker]);
    }
    this.emit({ type: 'consult', room: c.room, data: this.getConsult(id) });
    return this.consultView(id);
  }

  /** Herkes yanıtlayana, istişare kapanana, süresi dolana ya da zaman aşımına kadar bekler. */
  async waitConsult(id: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const settled = () => {
      const v = this.consultView(id);
      return v.status !== 'open' || !v.pending.length || v.deadline <= now();
    };
    if (settled() || timeoutMs <= 0) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.bus.off('event', onEvent);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const onEvent = (ev: BusEvent) => {
        if (ev.type === 'consult' && (ev.data as Consult | null)?.id === id && settled()) finish();
      };
      const c = this.getConsult(id)!;
      const timer = setTimeout(finish, Math.min(timeoutMs, Math.max(c.deadline - now(), 0) + 50));
      this.bus.on('event', onEvent);
      signal?.addEventListener('abort', finish);
    });
  }

  closeConsult(by: string, id: number, decision: string): Consult {
    const c = this.requireConsult(id);
    if (c.status !== 'open') throw new RoomError(`C${id} is already closed`);
    const a = this.getAgent(by);
    if (c.kind === 'election') {
      if (a?.role !== 'admin') throw new RoomError('Chair elections close by themselves when everyone has voted or the deadline passes');
      this.resolveElection(id);
      return this.getConsult(id)!;
    }
    if (by !== c.asker && a?.role !== 'admin' && this.chairOf(c.room) !== by) throw new RoomError(`Only @${c.asker} (who asked), the chair or an admin can close C${id}`);
    if (!decision.trim()) throw new RoomError('decision is empty: summarize what was decided and why');
    this.db.prepare("UPDATE consults SET status = 'closed', decision = ?, closed_at = ? WHERE id = ?").run(decision.trim(), now(), id);
    this.systemMessage(c.room, `✅ **C${id} decided** by @${by}: ${decision.trim()}`, c.task_id, c.invitees);
    this.log('consult.closed', by, { id, decision });
    this.emit({ type: 'consult', room: c.room, data: this.getConsult(id) });
    return this.getConsult(id)!;
  }

  chairOf(room: string): string | null {
    return (this.getRoom(room)?.chair as string | null) ?? null;
  }

  openElection(room: string): Consult | null {
    const row = this.db.prepare("SELECT * FROM consults WHERE room = ? AND kind = 'election' AND status = 'open' ORDER BY id DESC LIMIT 1").get(room);
    return row ? parseRow<Consult>(row, CONSULT_JSON) : null;
  }

  /** Odadaki orkestratörler (katılım sırasına göre), varsayılan olarak yalnızca çevrimiçi olanlar. */
  roomOrchestrators(room: string, withinMs = ONLINE_MS): string[] {
    return (this.db
      .prepare("SELECT m.agent FROM memberships m JOIN agents a ON a.name = m.agent WHERE m.room = ? AND a.role = 'orchestrator' AND a.revoked = 0 AND a.last_seen >= ? ORDER BY m.joined_at, m.agent")
      .all(room, now() - withinMs) as { agent: string }[]).map((r) => r.agent);
  }

  private setChair(room: string, name: string | null, note: string, how: 'sole' | 'election' | 'transfer' = 'sole'): void {
    this.db.prepare('UPDATE rooms SET chair = ?, chair_since = ?, chair_by = ? WHERE name = ?').run(name, name ? now() : null, name ? how : null, room);
    const orchs = this.roomOrchestrators(room, CHAIR_GRACE_MS);
    if (name) {
      this.systemMessage(
        room,
        `👑 @${name} is now the chair of this room${note}. The chair owns the plan: drafts it, consults the table, creates it with plan_create and has the final say. Other orchestrators: support the chair (answer consultations, run sub-plans the chair delegates to you, review).`,
        null,
        orchs,
      );
    } else this.systemMessage(room, `👑 The chair of this room is vacant${note}.`, null, orchs);
    this.log('room.chair', name, { room, note });
    this.emit({ type: 'task', room, data: null });
  }

  /** Başkan koltuğunu doğrular: boşsa tek orkestratörü atar ya da seçim başlatır. */
  ensureChair(room: string): void {
    const r = this.getRoom(room);
    if (!r || r.closed_at) return;
    const chair = r.chair as string | null;
    if (chair) {
      if (this.members(room).includes(chair) && this.getAgent(chair)?.role === 'orchestrator' && this.isOnline(chair, CHAIR_GRACE_MS)) {
        // Tek orkestratör olduğu için verilen koltuk geçicidir: masaya ikinci bir orkestratör gelince seçim yapılır.
        const cands = this.roomOrchestrators(room);
        if (r.chair_by === 'sole' && cands.length > 1 && !this.openElection(room)) {
          this.systemMessage(room, `👑 More orchestrators joined; electing a chair. @${chair} stays chair until the vote ends, but nobody creates a plan meanwhile.`);
          this.startElection(room, cands);
        }
        return;
      }
      this.db.prepare('UPDATE rooms SET chair = NULL, chair_since = NULL, chair_by = NULL WHERE name = ?').run(room);
      this.systemMessage(room, `👑 Chair @${chair} has left the table or has been silent for 10+ minutes; choosing a new chair.`);
    }
    if (this.openElection(room)) return;
    const cands = this.roomOrchestrators(room);
    if (cands.length === 1) this.setChair(room, cands[0]!, ' (the only orchestrator at the table)');
    else if (cands.length > 1) this.startElection(room, cands);
  }

  private startElection(room: string, cands: string[]): Consult {
    return this.openConsult('system', {
      room,
      kind: 'election',
      options: cands,
      ask: cands,
      timeout_sec: ELECTION_SEC,
      question:
        `Elect the chair of room "${room}". There are ${cands.length} orchestrators here, and one of them must lead: ` +
        `the chair drafts the plan, consults everyone, creates it with plan_create and makes the final call. The others support the chair and run delegated sub-plans. ` +
        `Vote for the candidate best placed to lead this goal (you may vote for yourself) and give a one-line reason. ` +
        `If no majority, the earliest orchestrator at the table wins the tie.`,
    });
  }

  private resolveElection(id: number): void {
    const v = this.consultView(id);
    if (v.status !== 'open') return;
    let winner = v.options[0]!;
    for (const o of v.options) if ((v.tally[o] ?? 0) > (v.tally[winner] ?? 0)) winner = o; // eşitlikte ilk katılan (seçenek sırası)
    const votes = v.options.map((o) => `${o} ${v.tally[o] ?? 0}`).join(', ');
    this.db.prepare("UPDATE consults SET status = 'closed', decision = ?, closed_at = ? WHERE id = ?").run(`${winner} elected chair (votes: ${votes})`, now(), id);
    this.emit({ type: 'consult', room: v.room, data: this.getConsult(id) });
    this.setChair(v.room, winner, ` by election C${id} (votes: ${votes}${v.pending.length ? `; did not vote: ${v.pending.join(', ')}` : ''})`, 'election');
  }

  /** chair aracı: durum, yeniden seçim, devir, istifa. */
  chairAction(agent: string, room: string, action: 'status' | 'elect' | 'transfer' | 'resign', to?: string): unknown {
    this.requireRoom(room, action === 'status' ? false : true);
    const a = this.getAgent(agent)!;
    const isAdmin = a.role === 'admin';
    const chair = this.chairOf(room);
    if (action !== 'status' && a.role !== 'orchestrator' && !isAdmin) throw new RoomError('Only orchestrators (or an admin) can change the chair');
    switch (action) {
      case 'status':
        break;
      case 'elect': {
        if (this.openElection(room)) break;
        const cands = this.roomOrchestrators(room);
        if (cands.length < 2) {
          if (cands.length === 1 && cands[0] !== chair) this.setChair(room, cands[0]!, ' (the only orchestrator at the table)');
          else if (!cands.length) throw new RoomError('No online orchestrator at this table to elect');
          break;
        }
        this.startElection(room, cands);
        break;
      }
      case 'transfer': {
        if (chair !== agent && !isAdmin) throw new RoomError(`Only the chair (@${chair ?? 'none'}) or an admin can hand over the chair`);
        const target = (to ?? '').replace(/^@/, '').toLowerCase();
        if (this.getAgent(target)?.role !== 'orchestrator' || !this.members(room).includes(target)) throw new RoomError(`"${target}" is not an orchestrator at this table`);
        this.setChair(room, target, ` (handed over by @${agent})`, 'transfer');
        break;
      }
      case 'resign': {
        if (chair !== agent) throw new RoomError('You are not the chair');
        const rest = this.roomOrchestrators(room).filter((o) => o !== agent);
        if (rest.length === 1) this.setChair(room, rest[0]!, ` (@${agent} stepped down)`, 'transfer');
        else if (rest.length > 1) {
          this.db.prepare('UPDATE rooms SET chair = NULL, chair_since = NULL, chair_by = NULL WHERE name = ?').run(room);
          this.systemMessage(room, `👑 @${agent} stepped down as chair; electing a new one.`);
          this.startElection(room, rest);
        } else this.setChair(room, null, ` (@${agent} stepped down)`);
        break;
      }
    }
    return {
      chair: this.chairOf(room),
      chair_since: this.getRoom(room)?.chair_since ?? null,
      orchestrators_online: this.roomOrchestrators(room),
      election: this.openElection(room) ? this.consultView(this.openElection(room)!.id) : null,
    };
  }

  /** plan_create izni: başkan, admin ya da başkanın devrettiği görevin sahibi (alt plan). */
  assertCanPlan(agent: string, room: string, parentId?: number | null): void {
    const a = this.getAgent(agent)!;
    if (a.role === 'admin') return;
    if (a.role !== 'orchestrator') throw new RoomError('plan_create is only available to agents with the orchestrator role');
    if (parentId) {
      const p = this.requireTask(parentId);
      if (p.room !== room) throw new RoomError(`#${parentId} belongs to room "${p.room}"`);
      if (p.assignee === agent) return; // devredilmiş alt plan
    }
    const el = this.openElection(room);
    if (el) throw new RoomError(`A chair election is running in this room (C${el.id}). Vote with consult_reply(id=${el.id}, choice=<name>, body=<reason>) and wait for the result; only the chair creates plans.`);
    const chair = this.chairOf(room);
    if (!chair || chair === agent) return;
    throw new RoomError(
      `Only the chair (@${chair}) creates plans in room "${room}". Send your proposal to the chair (send_message or consult_reply), or ask the chair to delegate a sub-plan to you as a task, then call plan_create(parent_id=<that task id>).`,
    );
  }

  private sweepConsults(): void {
    const due = this.db
      .prepare("SELECT * FROM consults WHERE status = 'open' AND deadline <= ?")
      .all(now())
      .map((r) => parseRow<Consult>(r, CONSULT_JSON));
    for (const c of due) {
      if (c.kind === 'election') {
        this.resolveElection(c.id);
        continue;
      }
      if (c.nudged) continue;
      const v = this.consultView(c.id);
      this.db.prepare('UPDATE consults SET nudged = 1 WHERE id = ?').run(c.id);
      this.systemMessage(
        c.room,
        `⌛ C${c.id} deadline passed (${v.replies.length}/${v.invitees.length} replied${v.pending.length ? `; silent: ${v.pending.join(', ')}` : ''}). @${c.asker}: decide with what you have and call consult_close(${c.id}, decision).`,
        c.task_id,
        [c.asker],
      );
      this.emit({ type: 'consult', room: c.room, data: this.getConsult(c.id) });
    }
    // Boş/düşmüş başkan koltuklarını onar.
    const rooms = this.db
      .prepare("SELECT DISTINCT r.name FROM rooms r JOIN memberships m ON m.room = r.name JOIN agents a ON a.name = m.agent WHERE r.closed_at IS NULL AND (r.chair IS NOT NULL OR a.role = 'orchestrator')")
      .all() as { name: string }[];
    for (const r of rooms) this.ensureChair(r.name);
  }

  // ---------------------------------------------------------------- bakım döngüsü
  /** Süresi dolan kiralamaları geri al, düşen agent'ları raporla. Periyodik çağrılır. */
  sweep(): void {
    this.sweepReservations();
    this.sweepConsults();
    const expired = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND lease_until IS NOT NULL AND lease_until < ?`)
      .all(...ACTIVE_STATUSES, now())
      .map((r) => parseRow<Task>(r, TASK_JSON));
    for (const t of expired) {
      this.db
        .prepare("UPDATE tasks SET status = 'open', assignee = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
        .run(now(), t.id);
      this.systemMessage(t.room, `⏰ #${t.id} lease expired (@${t.assignee} went silent); the task is open again`, t.id, [t.created_by]);
      this.log('task.lease_expired', t.assignee, { id: t.id }, 'warn');
      this.emit({ type: 'task', room: t.room, data: this.getTask(t.id) });
    }
    const gone = this.db
      .prepare("SELECT name FROM agents WHERE revoked = 0 AND status != 'offline' AND last_seen IS NOT NULL AND last_seen < ?")
      .all(now() - ONLINE_MS) as { name: string }[];
    for (const g of gone) {
      this.db.prepare("UPDATE agents SET status = 'offline' WHERE name = ?").run(g.name);
      this.log('agent.offline', g.name, {}, 'warn');
      this.emit({ type: 'agent', data: this.getAgent(g.name) });
    }
  }

  // ---------------------------------------------------------------- panel özeti
  snapshot(): unknown {
    const tasks = this.listTasks({ limit: 500 });
    const counts: Record<string, number> = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return {
      ts: now(),
      agents: this.listAgents(),
      rooms: this.listRooms({ includeClosed: true }),
      consults: this.listConsults({ limit: 50 }).map((c) => this.consultView(c.id)),
      tasks,
      task_counts: counts,
      reservations: this.listReservations(),
      errors: this.recentEvents({ level: 'error', limit: 20 }),
      events: this.recentEvents({ limit: 50 }),
    };
  }
}

function releaseTaskReservations(svc: RoomService, taskId: number): void {
  svc.db.prepare('DELETE FROM reservations WHERE task_id = ?').run(taskId);
}
