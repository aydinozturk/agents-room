// Test için Basic auth isteyen akıllı-HTTP git sunucusu (git http-backend CGI).
// Kullanım: node git-http-server.ts <proje-kökü> <token>  → stdout'a portu yazar.
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const [root, token] = process.argv.slice(2) as [string, string];
const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
const server = createServer((req, res) => {
  const [user, pass] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':');
  if (user !== 'x-access-token' || pass !== token) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
    return res.end();
  }
  const url = new URL(req.url!, 'http://x');
  const cgi = spawn(join(execPath, 'git-http-backend'), [], {
    env: {
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: user,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method!,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
      HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
    },
  });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0);
  let sent = false;
  cgi.stdout.on('data', (d: Buffer) => {
    if (sent) return void res.write(d);
    head = Buffer.concat([head, d]);
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.subarray(0, i).toString().split('\r\n')) {
      const [k, ...v] = line.split(':');
      if (k!.toLowerCase() === 'status') status = parseInt(v.join(':'));
      else headers[k!] = v.join(':').trim();
    }
    res.writeHead(status, headers);
    res.write(head.subarray(i + 4));
    sent = true;
  });
  cgi.on('close', () => res.end());
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${(server.address() as AddressInfo).port}\n`));
