import { expect, test } from 'bun:test';
import { fileURLToPath } from 'url';

for (const mode of ['manual', 'meeting']) {
  test(`TUI ${mode} capture excludes initial idle time and retains only pauses within a recording`, async () => {
    const child = Bun.spawn([process.execPath,
      fileURLToPath(new URL('./fixtures/tui-capture-clock.tsx', import.meta.url)), mode], {
      stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0) throw new Error(`TUI fixture exited ${code}: ${stderr}`);
      const starts = JSON.parse(stdout) as Array<{ source: string; clock: number; now: number }>;
      expect(starts).toHaveLength(6);
      expect(starts[0]!.clock).toBe(starts[0]!.now);
      expect(starts[1]!.clock).toBe(starts[0]!.clock);
      expect(starts[2]!.clock).toBe(starts[0]!.clock);
      expect(starts[3]!.clock).toBe(starts[0]!.clock);
      expect(starts[4]!.clock).toBe(starts[4]!.now);
      expect(starts[5]!.clock).toBe(starts[4]!.clock);
    } finally { clearTimeout(timer); child.kill(); }
  }, 10_000);
}
