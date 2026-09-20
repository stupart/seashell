import { expect, test } from 'bun:test';
import { fileURLToPath } from 'url';

for (const size of ['wide', 'narrow']) {
test(`live reader follows speech, respects browsing, and omits punctuation-only results (${size})`, async () => {
  const child = Bun.spawn([process.execPath,
    fileURLToPath(new URL('./fixtures/tui-live-follow.tsx', import.meta.url)), size], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Live reader fixture exited ${code}: ${stderr}`);
    expect(JSON.parse(stdout)).toEqual({
      followsLatest: true, returnsToLatest: true, resumesAtBottom: true, stayedWhileBrowsing: true,
      punctuationSaved: false, textCount: 16,
    });
  } finally { clearTimeout(timer); child.kill(); }
}, 12_000);
}
