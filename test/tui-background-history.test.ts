import { expect, test } from 'bun:test';

test('background library shows capture immediately and refreshes the open transcript after finalization', async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-background-history.tsx', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    expect(JSON.parse(out)).toEqual({ sidebar: true, recordingState: true, refreshed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 12_000);
