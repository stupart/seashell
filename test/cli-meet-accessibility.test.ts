import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('meeting speaker CLI prompts only on setup and keeps checks private/read-only', async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/cli-meet-accessibility.ts', import.meta.url))],
    { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Accessibility CLI fixture: ${error}`);
    expect(JSON.parse(out)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 12_000);
