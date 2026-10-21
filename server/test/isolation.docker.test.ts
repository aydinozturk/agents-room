// Agent başına Linux kullanıcısı modu (GV1) için Docker kabul testi: docker/test/isolation.sh'i agent imajında çalıştırır.
// Yavaş olduğu (imaj gerekir) için yalnız AGENTS_ROOM_DOCKER_TEST=1 ile ve Docker varsa çalışır:
//   AGENTS_ROOM_DOCKER_TEST=1 npm test     (imaj: AGENTS_ROOM_TEST_IMAGE, varsayılan aydinozturk/agents-room-agent:latest)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const image = process.env.AGENTS_ROOM_TEST_IMAGE ?? 'aydinozturk/agents-room-agent:latest';
const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const skip = process.env.AGENTS_ROOM_DOCKER_TEST !== '1' ? 'AGENTS_ROOM_DOCKER_TEST=1 değil' : !dockerOk ? 'Docker yok' : false;

function run(mode: 'isolated' | 'fallback'): { out: string; agents: string[] } {
  const r = spawnSync('docker', ['run', '--rm', '-u', 'root', '-v', `${repo}:/src:ro`, '--entrypoint', 'bash', image, '/src/docker/test/isolation.sh', mode], {
    encoding: 'utf8',
    timeout: 420_000,
  });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  const agents = out.split(/^== /m).slice(1).filter((b) => !b.startsWith('branches'));
  assert.equal(agents.length, 2, out);
  return { out, agents };
}

test("agent kullanıcıları: başka agent'ın ortamı ve dosyaları okunamaz, sudo yok, sır yok, push çalışır", { skip, timeout: 430_000 }, () => {
  const { out, agents } = run('isolated');
  assert.match(out, /^teamlog=clean$/m);
  assert.match(out, /^warned=0$/m);
  assert.match(out, /^restart_names=same$/m);
  assert.match(out, /^restart=ok$/m);
  assert.match(out, /^handback=ok$/m);
  assert.match(out, /^rescan=none$/m);
  for (const b of agents) {
    assert.match(b, /^user=ar-/m);
    assert.match(b, /^env=\[\]$/m);
    assert.match(b, /^sudo=no$/m);
    assert.match(b, /^environ:root=denied$/m);
    assert.match(b, /^environ:ar-\S+=denied$/m);
    assert.match(b, /^envfile:\S+=denied$/m);
    assert.match(b, /^umask=0077$/m);
    assert.match(b, /^push=ok$/m);
    assert.doesNotMatch(b, /readable/);
  }
  assert.equal((out.split('== branches')[1] ?? '').trim().split('\n').filter((l) => l.startsWith('ar/iso/t1-')).length, 2, out);
});

test('yalnız tarayıcı girişi: uyarıyla bugünkü ortak node kullanıcısı moduna dönülür', { skip, timeout: 430_000 }, () => {
  const { out, agents } = run('fallback');
  assert.match(out, /^isolated=0$/m);
  assert.match(out, /^warned=1$/m);
  for (const b of agents) {
    assert.match(b, /^user=node$/m);
    assert.match(b, /^push=ok$/m);
  }
});
