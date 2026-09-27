import { expect, test } from 'bun:test';
test('foreground startup, total failure and pause/resume health stay truthful', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-capture-health.tsx', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(err);
    expect(JSON.parse(out)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 10000);
