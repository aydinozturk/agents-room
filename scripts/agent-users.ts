// Agent başına ayrı Linux kullanıcısı (konteynerde, team.ts root olarak çalışırken).
// Her agent kendi kullanıcısıyla (ar-<ad>) ve kendi 0700 HOME'uyla çalışır: başka bir agent'ın süreç ortamını
// (/proc/<pid>/environ), kimlik dosyalarını ve çalışma kopyasını okuyamaz; sudo'su yoktur. Ortak reponun anahtarı
// agent'lara verilmez (scripts/git-proxy.ts). Model girişleri ortamdan gelir (CLAUDE_CODE_OAUTH_TOKEN, OPENAI_API_KEY,
// GEMINI_API_KEY): tarayıcı girişi dosyaları kullanıcılar arasında paylaşılamaz.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, lchownSync, lstatSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentUser {
  agent: string;
  user: string;
  uid: number;
  gid: number;
  home: string;
}

/** Bu süreç agent kullanıcıları oluşturabilir mi? (null = evet, değilse nedeni) */
export function agentUsersUnavailable(): string | null {
  if (process.platform !== 'linux') return 'yalnız Linux (konteyner) üzerinde';
  if (process.getuid?.() !== 0) return 'root olarak çalışmıyor';
  if (spawnSync('sh', ['-c', 'command -v useradd'], { stdio: 'ignore' }).status !== 0) return 'useradd yok';
  return null;
}

export const userName = (agent: string) => `ar-${agent.replace(/[^a-z0-9_-]/g, '-')}`.slice(0, 32);

function idOf(user: string): { uid: number; gid: number } | null {
  const u = spawnSync('id', ['-u', user], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', user], { encoding: 'utf8' });
  if (u.status !== 0 || g.status !== 0) return null;
  return { uid: Number(u.stdout.trim()), gid: Number(g.stdout.trim()) };
}

/** Kullanıcıyı (yoksa) oluşturur, HOME'u yalnız ona açık hazırlar. */
export function ensureAgentUser(agent: string, home: string): AgentUser {
  const user = userName(agent);
  if (!idOf(user)) {
    const r = spawnSync('useradd', ['--no-create-home', '--no-log-init', '--user-group', '--home-dir', home, '--shell', '/bin/bash', user], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${user} kullanıcısı oluşturulamadı: ${r.stderr.trim()}`);
  }
  const id = idOf(user)!;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chownSync(home, id.uid, id.gid);
  chmodSync(home, 0o700);
  return { agent, user, home, ...id };
}

/** Klasörün sahibi agent değilse (ilk geçiş ya da root'un açtığı yeni klon) bütün ağacı ona verir; kök 0700 olur. */
export function giveTree(dir: string, u: AgentUser): void {
  if (!existsSync(dir)) return;
  const st = statSync(dir);
  if (st.uid !== u.uid || st.gid !== u.gid) {
    const r = spawnSync('chown', ['-R', `${u.uid}:${u.gid}`, dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${dir} sahipliği verilemedi: ${r.stderr.trim()}`);
  }
  chmodSync(dir, 0o700);
}

/** Agent kullanıcısı olarak çalışırken kullanılacak sade ortam (root'un ortamı ve sırları taşınmaz). */
export function baseEnv(u: AgentUser): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: u.home,
    USER: u.user,
    LOGNAME: u.user,
    SHELL: '/bin/bash',
    LANG: process.env.LANG ?? 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function runAs(u: AgentUser, cmd: string, args: string[], opt: SpawnSyncOptions = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opt, uid: u.uid, gid: u.gid, env: { ...baseEnv(u), ...(opt.env as Record<string, string> | undefined) } });
}

function ownedDir(path: string, u: AgentUser): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chownSync(path, u.uid, u.gid);
}

function ownedLink(target: string, path: string, u: AgentUser): void {
  try {
    lstatSync(path);
    return;
  } catch {
    /* yok */
  }
  symlinkSync(target, path);
  lchownSync(path, u.uid, u.gid);
}

/**
 * HOME içeriği: skill bağlantıları, oturum logları ve görev worktree'leri için klasörler; gerekirse Codex API anahtarı
 * girişi ve SSH deploy key kopyası (SSH ile anahtar agent'tan gizlenemez; tam yalıtım için token kullanın).
 */
export function prepareHome(u: AgentUser, opt: { skill: string; codex: boolean; sshKey?: string }): { logs: string; worktrees: string; sshKey?: string } {
  for (const d of ['.claude', '.claude/skills', '.agents', '.agents/skills', '.gemini', '.codex']) ownedDir(join(u.home, d), u);
  ownedLink(opt.skill, join(u.home, '.claude', 'skills', 'agents-room'), u);
  ownedLink(opt.skill, join(u.home, '.agents', 'skills', 'agents-room'), u);
  const logs = join(u.home, 'logs');
  const worktrees = join(u.home, 'worktrees');
  ownedDir(logs, u);
  ownedDir(worktrees, u);
  if (opt.codex && process.env.OPENAI_API_KEY && !existsSync(join(u.home, '.codex', 'auth.json'))) {
    const r = runAs(u, 'codex', ['login', '--with-api-key'], { input: process.env.OPENAI_API_KEY, stdio: ['pipe', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`${u.agent}: codex girişi yapılamadı: ${String(r.stderr).trim().slice(0, 200)}`);
  }
  let sshKey: string | undefined;
  if (opt.sshKey) {
    ownedDir(join(u.home, '.ssh'), u);
    sshKey = join(u.home, '.ssh', 'repo_key');
    copyFileSync(opt.sshKey, sshKey);
    chownSync(sshKey, u.uid, u.gid);
    chmodSync(sshKey, 0o600);
  }
  return { logs, worktrees, sshKey };
}
