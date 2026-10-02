import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runAutomaticMeetingWatch, watchRestartReason, type AutomaticMeetingWatchEvent } from '../src/automatic-meeting-watch.ts';
import { CaptureSessionStore } from '../src/capture-session.ts';
import { createTranscriptRecord } from '../src/transcript-record.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a package upgrade or a settings change asks the login watcher to restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-restart-reason-'));
  roots.push(root);
  for (const version of ['rc20', 'rc21']) {
    mkdirSync(join(root, version), { recursive: true });
    writeFileSync(join(root, version, 'package.json'), '{}');
  }
  const opt = join(root, 'opt');
  symlinkSync(join(root, 'rc20'), opt);
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, '{}');
  const reason = watchRestartReason({ configPath, packageRoot: opt, codeRoot: join(root, 'rc20') });
  expect(reason()).toBeUndefined();
  const later = new Date(Date.now() + 5_000);
  utimesSync(configPath, later, later);
  expect(reason()).toBe('Settings changed');

  const upgraded = watchRestartReason({ configPath, packageRoot: opt, codeRoot: join(root, 'rc20') });
  unlinkSync(opt);
  symlinkSync(join(root, 'rc21'), opt);
  expect(upgraded()).toBe('Seashell was updated');
  // Homebrew cleanup removes the old version this process is still running from.
  const cleaned = watchRestartReason({ configPath, codeRoot: join(root, 'rc20') });
  rmSync(join(root, 'rc20'), { recursive: true });
  expect(cleaned()).toBe('Seashell was updated');
});

test('the watcher restarts only between meetings, never during one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-restart-idle-'));
  roots.push(root);
  let polls = 0;
  let asked = 0;
  const events: AutomaticMeetingWatchEvent['type'][] = [];
  await runAutomaticMeetingWatch({
    lockPath: join(root, 'watch.lock'),
    config: { libraryDir: root, meeting: { automation: {
      mode: 'automatic', confirmationPolls: 1, pollSeconds: 1, endGraceSeconds: 1, resumeWindowSeconds: 0,
    } } },
    onEvent: value => events.push(value.type),
    restartWhen: () => { asked++; return 'Settings changed'; },
    dependencies: {
      // A Zoom call for the first three polls, then nothing.
      readSignals: () => ({ schemaVersion: 1, capturedAtUnixMs: Date.now(), supported: true,
        inputProcesses: ++polls <= 3 ? [{ pid: 42, bundleId: 'us.zoom.xos', name: 'Zoom' }] : [] }),
      startCapture: options => {
        const store = new CaptureSessionStore({ libraryDir: root, sessionId: 'restart-call', startedAtUnixMs: options.startedAt!.getTime() });
        return { store, sessionId: 'restart-call', manifestPath: store.manifestPath,
          async stop() { return store.setStatus('captured', 'test'); } };
      },
      finalizeCapture: async () => createTranscriptRecord({ transcript: [{ start: 0, end: 1, text: 'done' }], speakers: [] },
        { id: 'restart-call', now: new Date() }),
    },
  });
  expect(events).toEqual(['watch.ready', 'meeting.started', 'meeting.capture-finished', 'meeting.ready', 'watch.restarting']);
  expect(polls).toBeGreaterThanOrEqual(5);
  expect(asked).toBe(1);
}, 20_000);
