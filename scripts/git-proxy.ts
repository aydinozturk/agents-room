// Yerel git/GitHub vekili: ortak reponun erişim anahtarı yalnız bu süreçte (team.ts) durur, agent'lara hiç verilmez.
// Agent'ların klonu origin adresini buraya yönlendirir (git config url.<vekil>.insteadOf <repo>); vekil istekleri
// anahtarı ekleyerek ortak repoya iletir. Yalnız bu reponun git uçları ve GitHub'da bu reponun PR/issue API'si açıktır.
// Yalnızca 127.0.0.1'e bağlanır: konteynerin dışından erişilemez.
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { githubSlug } from './git-auth.ts';

export interface GitProxy {
  /** Agent'ın klonunda insteadOf hedefi: <url>/git */
  gitUrl: string;
  /** GitHub reposuysa bu reponun API kökü (…/github → api.github.com/repos/<org>/<repo>), değilse null. */
  apiUrl: string | null;
  close(): Promise<void>;
}

const GIT_PATH = /^\/git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const API_PATH = /^\/github\/((?:pulls|issues)(?:\/[\w./-]*)?)$/;
const HOP = new Set(['host', 'authorization', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect', 'cookie']);

function forwardHeaders(h: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  return out;
}

function pipeTo(target: URL, auth: string, req: IncomingMessage, res: ServerResponse, extra: Record<string, string> = {}): void {
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers: { ...forwardHeaders(req.headers), ...extra, authorization: auth } }, (r) => {
    const headers = forwardHeaders(r.headers);
    delete headers['transfer-encoding'];
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`agents-room git proxy: ${e.message}\n`);
  });
  req.pipe(up);
}

export async function startGitProxy(opt: { repoUrl: string; token: string; port?: number; apiBase?: string }): Promise<GitProxy> {
  const upstream = opt.repoUrl.replace(/\/+$/, '');
  const basic = `Basic ${Buffer.from(`x-access-token:${opt.token}`).toString('base64')}`;
  const slug = githubSlug(upstream);
  const apiRoot = slug ? `${(opt.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')}/repos/${slug.owner}/${slug.repo}` : null;

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://proxy');
    const g = u.pathname.match(GIT_PATH);
    if (g && (req.method === 'GET' || req.method === 'POST')) return pipeTo(new URL(`${upstream}/${g[1]}${u.search}`), basic, req, res);
    const a = u.pathname.match(API_PATH);
    if (a && apiRoot && ['GET', 'POST', 'PATCH'].includes(req.method ?? '')) {
      return pipeTo(new URL(`${apiRoot}/${a[1]}${u.search}`), `Bearer ${opt.token}`, req, res, {
        accept: req.headers.accept ?? 'application/vnd.github+json',
        'user-agent': 'agents-room',
      });
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('agents-room git proxy: only this repo\'s git endpoints and /github/{pulls,issues} are available\n');
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opt.port ?? 0, '127.0.0.1', () => ok());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    gitUrl: `${base}/git`,
    apiUrl: apiRoot ? `${base}/github` : null,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
