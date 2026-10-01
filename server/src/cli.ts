#!/usr/bin/env node
// Yönetim CLI'ı: doğrudan veritabanı üzerinde çalışır (sunucu makinesinde).
//   node src/cli.ts agent add <isim> --kind claude-code --role worker --caps ts,test --machine mac1
//   node src/cli.ts agent list | agent revoke <isim>
//   node src/cli.ts room add <isim> --topic "..." --repo github.com/org/proje
//   node src/cli.ts status
import { parseArgs } from 'node:util';
import { hostname } from 'node:os';
import { openDb } from './db.ts';
import { type AgentKind, type AgentRole, RoomService } from './room.ts';
import { loadConfig } from './config.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    kind: { type: 'string', default: 'other' },
    role: { type: 'string', default: 'worker' },
    caps: { type: 'string', default: '' },
    machine: { type: 'string' },
    topic: { type: 'string' },
    repo: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const cfg = loadConfig();
const svc = new RoomService(openDb(cfg.dbPath));
const [area, cmd, name] = positionals;

function out(v: unknown) {
  console.log(values.json ? JSON.stringify(v, null, 2) : v);
}

switch (`${area ?? ''} ${cmd ?? ''}`.trim()) {
  case 'agent add': {
    if (!name) throw new Error('isim gerekli');
    const r = svc.createAgent({
      name,
      kind: values.kind as AgentKind,
      role: values.role as AgentRole,
      capabilities: values.caps ? values.caps.split(',').map((s) => s.trim()) : [],
      machine: values.machine ?? hostname(),
    });
    if (values.json) out(r);
    else {
      console.log(`agent: ${r.agent.name} (${r.agent.kind}, ${r.agent.role}) yetenekler=${r.agent.capabilities.join(',')}`);
      console.log(`token: ${r.token}`);
      console.log('Bu token bir daha gösterilmez. İstemcide AGENTS_ROOM_TOKEN olarak ayarlayın.');
    }
    break;
  }
  case 'agent list':
    for (const a of svc.listAgents()) {
      console.log(`${a.name.padEnd(24)} ${a.kind.padEnd(12)} ${a.role.padEnd(13)} ${a.status.padEnd(8)} ${a.last_seen ? new Date(a.last_seen).toISOString() : '-'}  ${a.activity ?? ''}`);
    }
    break;
  case 'agent revoke':
    if (!name) throw new Error('isim gerekli');
    svc.revokeAgent(name);
    console.log(`iptal edildi: ${name}`);
    break;
  case 'room add':
    if (!name) throw new Error('isim gerekli');
    out(svc.createRoom(name, values.topic ?? null, values.repo ?? null, 'admin'));
    break;
  case 'room list':
    out(svc.listRooms());
    break;
  case 'status': {
    const s = svc.snapshot() as { agents: unknown[]; task_counts: unknown; reservations: unknown[]; errors: unknown[] };
    out({ agents: s.agents.length, tasks: s.task_counts, reservations: s.reservations.length, recent_errors: s.errors.length });
    break;
  }
  default:
    console.log(`Kullanım:
  agent add <isim> [--kind claude-code|codex|hermes|human|other] [--role worker|orchestrator|observer|admin] [--caps a,b] [--machine m]
  agent list
  agent revoke <isim>
  room add <isim> [--topic ...] [--repo github.com/org/proje]
  room list
  status
Veritabanı: ${cfg.dbPath}`);
}
