import { expect, test } from 'bun:test';

for (const width of ['wide', 'narrow']) test(`live text paused says why on the transcript's last row, and a catch-up says how far it read (${width})`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-live-text-paused.tsx', import.meta.url).pathname, width], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Live text paused fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 30_000);
