import { expect, test } from 'bun:test';

test('a follow-up can be written again from its last ask, and a failed one tried again', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-follow-up.tsx', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Follow-up fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 30_000);
