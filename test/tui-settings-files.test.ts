import { test, expect } from 'bun:test';
import { fileURLToPath } from 'url';
for (const size of ['wide', 'narrow']) test(`Settings keeps prompts, extractors, voices and video (${size})`, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-settings-files.tsx', import.meta.url)), size], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Settings files fixture: ${error}`);
    expect(JSON.parse(out.trim().split('\n').at(-1)!)).toEqual({ passed: true });
  } finally { clearTimeout(timeout); child.kill(); }
}, 25_000);
