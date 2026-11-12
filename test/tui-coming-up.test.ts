import { expect, test } from 'bun:test';

test('b lists what is coming up; Enter makes or reads a brief, and finds a point in the meeting it cites', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-coming-up.tsx', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Coming up fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 30_000);
