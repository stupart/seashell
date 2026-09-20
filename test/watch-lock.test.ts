import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { acquireMeetingWatchLock } from '../src/watch-lock.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('watch lock excludes live owners, recovers stale owners, and releases only itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-watch-lock-'));
  roots.push(root);
  const path = join(root, 'watch.lock');
  const first = acquireMeetingWatchLock({ path, pid: 10, pidAlive: (pid) => pid === 10 });
  expect(first).toBeDefined();
  expect(acquireMeetingWatchLock({ path, pid: 11, pidAlive: (pid) => pid === 10 })).toBeUndefined();
  first?.release();

  writeFileSync(path, JSON.stringify({ pid: 99, token: 'stale' }));
  const recovered = acquireMeetingWatchLock({ path, pid: 12, pidAlive: () => false });
  expect(recovered).toBeDefined();
  recovered?.release();
});

test('a stale-owner takeover cannot remove a competing live lease', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-lock-race-'));
  roots.push(root);
  const path = join(root, 'watch.lock');
  writeFileSync(path, JSON.stringify({ pid: 99, token: 'stale' }));
  let competitor: ReturnType<typeof acquireMeetingWatchLock>;
  const first = acquireMeetingWatchLock({
    path, pid: 11,
    pidAlive: () => {
      competitor = acquireMeetingWatchLock({ path, pid: 12, pidAlive: () => false });
      return false;
    },
  });
  try { expect([first, competitor].filter(Boolean)).toHaveLength(1); }
  finally { first?.release(); competitor?.release(); }
});

test('simultaneous processes elect exactly one watcher and a killed owner releases its lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-lock-processes-'));
  roots.push(root);
  const lockPath = join(root, 'watch.lock');
  const gate = join(root, 'go');
  const worker = join(root, 'worker.ts');
  const module = new URL('../src/watch-lock.ts', import.meta.url).href;
  writeFileSync(worker, `import {writeFileSync, existsSync} from 'fs';
import {acquireMeetingWatchLock} from ${JSON.stringify(module)};
const marker = process.argv[2]!;
writeFileSync(marker+'.ready', '');
while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
const lease=acquireMeetingWatchLock({path:${JSON.stringify(lockPath)}});
writeFileSync(marker+'.result', JSON.stringify(Boolean(lease)));
if (lease) setInterval(()=>{},1000);
`);
  const children = Array.from({ length: 6 }, (_, index) => Bun.spawn([process.execPath, worker, join(root, String(index))], {
    stdout: 'ignore', stderr: 'ignore',
  }));
  const waitFor = async (suffix: string) => {
    const deadline = Date.now() + 3_000;
    while (readdirSync(root).filter((name) => name.endsWith(suffix)).length < children.length && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(readdirSync(root).filter((name) => name.endsWith(suffix))).toHaveLength(children.length);
  };
  try {
    await waitFor('.ready');
    writeFileSync(gate, '');
    await waitFor('.result');
    const owners = children.flatMap((child, index) => JSON.parse(readFileSync(join(root, `${index}.result`), 'utf8')) ? [child] : []);
    expect(owners).toHaveLength(1);
    expect(acquireMeetingWatchLock({ path: lockPath })).toBeUndefined();
    owners[0]!.kill('SIGKILL');
    await owners[0]!.exited;
    const recovered = acquireMeetingWatchLock({ path: lockPath });
    expect(recovered).toBeDefined();
    recovered?.release();
    expect(existsSync(lockPath)).toBe(true); // Stable inode is intentional.
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
    await Promise.all(children.map((child) => child.exited));
  }
}, 10_000);
