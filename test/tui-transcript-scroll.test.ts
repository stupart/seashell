import { test, expect } from 'bun:test';
import { fileURLToPath } from 'url';
for (const size of ['wide', 'narrow']) test(`reader scrolls long paragraphs with keys and wheel (${size})`, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-transcript-scroll.tsx', import.meta.url)), size],
    { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Scroll fixture: ${error}`);
    expect(JSON.parse(out)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 15000);
