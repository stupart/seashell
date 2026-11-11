import { expect, test } from 'bun:test';
import { fileURLToPath } from 'url';
import { planGuide } from '../src/Onboarding.tsx';
import type { FeatureId, FeatureState, FeatureStatus } from '../src/feature-status.ts';

for (const size of ['wide', 'narrow']) test(`the guided setup hears the microphone before it calls setup done (${size})`, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./fixtures/tui-onboarding.tsx', import.meta.url)), size], { stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 40_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Onboarding UI fixture: ${error}`);
    expect(out.trim().split('\n').at(-1)).toBe(JSON.stringify({ passed: true }));
  } finally { clearTimeout(timeout); child.kill(); }
}, 45_000);

const statuses = (states: Partial<Record<FeatureId, FeatureState>>): FeatureStatus[] =>
  (['recorder', 'microphone', 'computer-audio', 'meet-names', 'speaker-separation', 'ai-notes', 'calendar'] as FeatureId[])
    .map((id) => ({ id, label: id, optional: false, state: states[id] ?? 'ok', summary: '', detail: '' }));

test('the guide skips what is done, but always listens to the microphone', () => {
  expect(planGuide(statuses({}))).toEqual(['microphone', 'done']);
  expect(planGuide(statuses({ recorder: 'broken', 'computer-audio': 'attention', calendar: 'off' })))
    .toEqual(['recorder', 'microphone', 'computer', 'extras', 'done']);
});
