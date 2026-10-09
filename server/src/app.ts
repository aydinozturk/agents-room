// HTTP katmanı: /mcp (MCP Streamable HTTP, durumsuz), /api (izleme paneli + insan katılımcı), / (panel).
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { type Agent, type AgentKind, type AgentRole, type BusEvent, RoomError, type RoomService } from './room.ts';
import { buildMcpServer } from './tools.ts';

export interface AppOptions {
  enrollSecret?: string;
  maxWaitSec: number;
  defaultWaitSec: number;
  allowedHosts?: string[];
}

declare module 'express-serve-static-core' {
  interface Request {
    agent?: Agent;
  }
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const cookie = req.headers.cookie?.split(';').map((c) => c.trim()).find((c) => c.startsWith('ar_token='));
  if (cookie) return decodeURIComponent(cookie.slice('ar_token='.length));
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function createApp(svc: RoomService, opts: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  // Node 26'da boşta kalmış keep-alive soketi yeniden kullanılınca istek, sunucunun bağlantı-kontrol
  // turuna (varsayılan 30 sn) kadar bekliyor. Araç çağrıları seyrek olduğundan bağlantıyı her yanıtta
  // kapatmak ucuz ve deterministik bir çözüm. SSE akışı bundan muaf.
  app.use((req, res, next) => {
    if (req.path !== '/api/stream') res.setHeader('Connection', 'close');
    next();
  });

  // DNS rebinding koruması (tarayıcıdan localhost'a saldırılara karşı)
  if (opts.allowedHosts?.length) {
    app.use((req, res, next) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!opts.allowedHosts!.includes(host)) return res.status(403).json({ error: `Host izinli değil: ${host}` });
      next();
    });
  }

  const auth = (roles?: AgentRole[]) => (req: Request, res: Response, next: NextFunction) => {
    const token = readToken(req);
    const agent = token ? svc.authenticate(token) : null;
    if (!agent) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="agents-room"');
      return res.status(401).json({ error: 'Geçersiz ya da eksik token (Authorization: Bearer <token>)' });
    }
    if (roles && !roles.includes(agent.role)) return res.status(403).json({ error: `Bu işlem için rol gerekli: ${roles.join('|')}` });
    req.agent = agent;
    next();
  };

  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // ------------------------------------------------------------------ MCP
  // Durumsuz mod: her POST kendi sunucu+taşıma örneğini alır. Kimlik token'dan gelir,
  // oturum durumu tutulmaz → yeniden başlatmaya, yük dengeleyiciye ve MCP'nin durumsuz yönüne uygun.
  app.post('/mcp', auth(), async (req, res) => {
    const server = buildMcpServer(svc, req.agent!, opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      svc.log('mcp.error', req.agent!.name, { error: String(e) }, 'error');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Sunucu hatası' }, id: null });
    }
  });
  const noStream = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Durumsuz sunucu: yalnızca POST' }, id: null });
  app.get('/mcp', noStream);
  app.delete('/mcp', noStream);

  // ------------------------------------------------------------------ Uyandırma (oturumsuz bekleme)
  // Çalıştırıcı (scripts/run-agent.sh) boştaki agent için model oturumu açmadan burada bekler; oturum ancak
  // agent'a iş, mesaj ya da istişare düşünce açılır. Yanıt düz metin (bash'te ayrıştırması kolay):
  //   WAKE\n<oturum talimatına eklenecek not> | TIMEOUT | CLOSED
  app.post('/api/agent/wake', auth(['worker', 'orchestrator']), async (req, res) => {
    const room = String(req.body?.room ?? '');
    const timeoutSec = Math.min(Math.max(Number(req.body?.timeout_sec ?? 300) || 0, 0), 900);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      const r = await svc.waitForWake(req.agent!.name, room, { timeoutMs: timeoutSec * 1000, immediate: !!req.body?.immediate, signal: ac.signal });
      res.type('text/plain').send(!r ? 'TIMEOUT\n' : r.closed ? 'CLOSED\n' : `WAKE\n${r.note}\n`);
    } catch (e) {
      if (!res.headersSent) res.status(e instanceof RoomError ? 400 : 500).type('text/plain').send(`ERROR\n${(e as Error).message}\n`);
    }
  });

  // ------------------------------------------------------------------ Kayıt (enroll)
  // Uzak makineler paylaşılan kayıt sırrı (ya da admin token'ı) ile kendi agent kimliklerini alır;
  // ekip kurulumu (scripts/team.ts) bunu kullanır. Kaba kuvvete karşı IP başına deneme sınırı vardır.
  const failures = new Map<string, { n: number; until: number }>();
  const enrollGuard = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.n >= 10 && f.until > Date.now()) return res.status(429).json({ error: 'Çok fazla hatalı deneme; 10 dakika sonra tekrar deneyin' });
    const bearer = readToken(req);
    const admin = bearer ? svc.authenticate(bearer) : null;
    if (admin?.role === 'admin') return next();
    if (!opts.enrollSecret) return res.status(404).json({ error: 'Kayıt kapalı (AGENTS_ROOM_ENROLL=off)' });
    const secret = req.body?.secret;
    if (typeof secret !== 'string' || !safeEqual(secret, opts.enrollSecret)) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60_000 };
      cur.n++;
      failures.set(ip, cur);
      svc.log('enroll.denied', typeof req.body?.name === 'string' ? req.body.name : null, { ip }, 'warn');
      return res.status(403).json({ error: 'Kayıt sırrı hatalı' });
    }
    failures.delete(ip);
    next();
  };

  // Ekip kurulumu için: mevcut odalar ve agent adları (gizli bilgi içermez).
  app.post('/api/enroll/info', enrollGuard, (_req, res) => {
    res.json({
      rooms: (svc.listRooms({ includeClosed: true }) as Record<string, unknown>[]).map((r) => ({ name: r.name, topic: r.topic, repo: r.repo, members: r.members, open_tasks: r.open_tasks, closed: !!r.closed_at })),
      agents: svc.listAgents().map((a) => ({ name: a.name, kind: a.kind, role: a.role, status: a.status, machine: a.machine })),
    });
  });

  app.post('/api/enroll', enrollGuard, (req, res) => {
    const { name, kind, role, capabilities, machine, room, topic, repo, reopen } = req.body ?? {};
    if (role === 'admin') return res.status(403).json({ error: 'admin rolü kayıtla alınamaz' });
    const existing = typeof name === 'string' ? svc.getAgent(name) : null;
    if (existing && existing.role === 'admin') return res.status(403).json({ error: 'Bu isim korunuyor' });
    try {
      // İstenen oda yoksa oluşturulur; varsa konu/repo yalnızca boşsa doldurulur.
      let roomInfo: unknown = null;
      if (typeof room === 'string' && room) {
        const cur = svc.getRoom(room);
        if (cur?.closed_at) {
          if (!reopen) return res.status(409).json({ error: `"${room}" odası kapalı; yeniden açmak için reopen: true gönderin` });
          svc.reopenRoom(room, typeof name === 'string' ? name : 'enroll');
        }
        if (!cur) svc.createRoom(room, typeof topic === 'string' ? topic : null, typeof repo === 'string' ? repo : null, typeof name === 'string' ? name : 'enroll');
        else if ((!cur.repo && repo) || (!cur.topic && topic)) svc.createRoom(room, cur.topic ? null : (topic ?? null), cur.repo ? null : (repo ?? null), String(name));
        roomInfo = svc.getRoom(room);
      }
      const r = svc.createAgent({
        name,
        kind: (kind as AgentKind) ?? 'other',
        role: role === 'orchestrator' || role === 'observer' ? role : 'worker',
        capabilities: Array.isArray(capabilities) ? capabilities.map(String) : [],
        machine: typeof machine === 'string' ? machine : undefined,
      });
      res.json({ agent: r.agent, token: r.token, room: roomInfo });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ------------------------------------------------------------------ Panel API
  const panel = auth(['admin', 'observer', 'orchestrator']);

  app.post('/api/login', (req, res) => {
    const token = String(req.body?.token ?? '');
    const a = svc.authenticate(token);
    if (!a || !['admin', 'observer', 'orchestrator'].includes(a.role)) return res.status(401).json({ error: 'Panel için admin/observer token gerekli' });
    res.setHeader('Set-Cookie', `ar_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    res.json({ agent: a });
  });
  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'ar_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/state', panel, (req, res) => res.json({ me: req.agent, ...(svc.snapshot() as object) }));

  app.get('/api/rooms/:room/messages', panel, (req, res) => {
    const since = req.query.since_id !== undefined ? Number(req.query.since_id) : undefined;
    const before = req.query.before_id !== undefined ? Number(req.query.before_id) : undefined;
    res.json(svc.history(null, String(req.params.room), { since_id: since, before_id: before, limit: Number(req.query.limit ?? 100) }));
  });

  const wrap = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      res.json(fn(req));
    } catch (e) {
      res.status(e instanceof RoomError ? 400 : 500).json({ error: (e as Error).message });
    }
  };

  // İnsan katılımcı (admin) panelden mesaj yazabilir ve görevleri yönetebilir.
  app.post('/api/rooms/:room/messages', auth(['admin', 'orchestrator']), wrap((req) => svc.send(req.agent!.name, { room: String(req.params.room), body: String(req.body?.body ?? ''), to: req.body?.to || null })));
  app.post('/api/rooms', auth(['admin']), wrap((req) => svc.createRoom(String(req.body?.name), req.body?.topic ?? null, req.body?.repo ?? null, req.agent!.name)));
  app.post('/api/rooms/:room/close', auth(['admin']), wrap((req) => svc.closeRoom(String(req.params.room), req.agent!.name, req.body?.reason || undefined)));
  app.post('/api/rooms/:room/reopen', auth(['admin']), wrap((req) => svc.reopenRoom(String(req.params.room), req.agent!.name)));
  app.post('/api/tasks', auth(['admin', 'orchestrator']), wrap((req) => svc.createTask(req.agent!.name, req.body)));
  app.post('/api/tasks/:id/review', auth(['admin', 'orchestrator']), wrap((req) => svc.review(req.agent!.name, Number(req.params.id), req.body)));
  app.get('/api/tasks/:id/tree', panel, wrap((req) => svc.tree(Number(req.params.id))));
  app.post('/api/agents', auth(['admin']), wrap((req) => svc.createAgent(req.body)));
  app.delete('/api/agents/:name', auth(['admin']), wrap((req) => {
    svc.revokeAgent(String(req.params.name));
    return { revoked: req.params.name };
  }));
  app.delete('/api/reservations/:id', auth(['admin']), wrap((req) => {
    svc.db.prepare('DELETE FROM reservations WHERE id = ?').run(Number(req.params.id));
    svc.log('files.force_released', req.agent!.name, { id: Number(req.params.id) }, 'warn');
    return { ok: true };
  }));

  // Canlı olay akışı (SSE) — panel anlık güncellenir.
  app.get('/api/stream', panel, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': bağlandı\n\n');
    const onEvent = (ev: BusEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    svc.bus.on('event', onEvent);
    req.on('close', () => {
      clearInterval(ping);
      svc.bus.off('event', onEvent);
    });
  });

  // Panelin markdown işleyicisi ve temizleyicisi yerelden sunulur (internetsiz ağlarda da çalışsın).
  const NM = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
  app.get('/vendor/marked.js', (_req, res) => res.sendFile(join(NM, 'marked', 'lib', 'marked.umd.js')));
  app.get('/vendor/purify.js', (_req, res) => res.sendFile(join(NM, 'dompurify', 'dist', 'purify.min.js')));
  app.use(express.static(PUBLIC_DIR));
  return app;
}
