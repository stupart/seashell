import { test, expect } from 'bun:test';
import { fileURLToPath } from 'url';
for (const size of ['wide', 'narrow']) test(`a meeting plays its video, keeps suggested names and runs its extractors (${size})`, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-meeting-extras.tsx', import.meta.url)), size], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Meeting extras fixture: ${error}`);
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 35_000);
