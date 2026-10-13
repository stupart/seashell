import { expect, test } from 'bun:test';

test('notes setup chooses a template, writes a note and turns AI off for one meeting', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-notes-setup.tsx', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Notes setup fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 30_000);
