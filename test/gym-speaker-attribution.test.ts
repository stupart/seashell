import { expect, test } from 'bun:test';
import { renderSpeakerReplayReport, runSpeakerReplayGym } from '../scripts/gym-speaker-attribution.ts';

test('speaker replay scores reloaded final transcripts, preserves captures and removes scratch data across rounds', async () => {
  const report = await runSpeakerReplayGym({ rounds: 2 });
  expect(report.kind).toBe('synthetic-speaker-attribution-replay');
  expect(report.scratchRemoved).toBe(true);
  expect(report.results).toHaveLength(18);
  expect(report.results.filter(result => !result.passed)).toEqual([]);
  expect(report.results.every(result => result.captureVerified)).toBe(true);
  for (const id of ['two-remote-speakers', 'simultaneous-local-microphone', 'legacy-provenance']) {
    expect(report.results.filter(result => result.case === id).map(result => result.evaluation?.namedCoverage)).toEqual([1, 1]);
  }
  expect(report.results.filter(result => result.case === 'reader-gap').map(result => result.evaluation?.unknownNameSeconds)).toEqual([1, 1]);
  expect(renderSpeakerReplayReport(report)).toContain('not live Meet name accuracy');
}, 10_000);

test('replay bounds rounds and honours cancellation without dispatching models or devices', async () => {
  for (const rounds of [0, 11, 1.5, NaN]) await expect(runSpeakerReplayGym({ rounds })).rejects.toThrow('between 1 and 10');
  const controller = new AbortController(); controller.abort();
  await expect(runSpeakerReplayGym({ signal: controller.signal })).rejects.toThrow('cancelled');
});
