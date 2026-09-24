import { test, expect } from 'bun:test';
import { fileURLToPath } from 'url';
for (const size of ['wide', 'narrow']) test(`speaker setup preserves capture and handles readiness (${size})`, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-speakers.tsx', import.meta.url)), size], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Speaker UI fixture: ${error}`);
    expect(JSON.parse(out)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 15000);
