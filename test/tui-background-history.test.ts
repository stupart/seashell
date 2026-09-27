import { expect, test } from 'bun:test';

for (const width of ['wide', 'narrow']) test(`background meeting flow: approval, live text, audio failure, scrolling and history (${width})`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-background-history.tsx', import.meta.url).pathname, width],
    { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(err);
    expect(JSON.parse(out)).toEqual({ consent: true, recordingState: true, liveText: true, scroll: true, audioHelp: true, historyIdentity: true, staleStatus: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 22_000);
