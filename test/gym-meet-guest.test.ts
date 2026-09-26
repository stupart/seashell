import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { CdpClient, parseMeetGuestOptions, validateDebuggerEndpoint, validateMeetTestUrl } from '../scripts/gym-meet-guest.ts';

test('live guest requires an explicit canonical Meet test room and bounded duration', () => {
  expect(parseMeetGuestOptions(['--url', 'https://meet.google.com/abc-defg-hij/', '--audio', 'fixture.wav'])).toEqual({
    url: 'https://meet.google.com/abc-defg-hij', audio: resolve('fixture.wav'), name: 'Seashell Test Speaker', seconds: 60, allowLobby: false,
  });
  for (const seconds of ['0', '4', '301', 'Infinity', '1.5', 'oops']) {
    expect(() => parseMeetGuestOptions(['--url', 'https://meet.google.com/abc-defg-hij', '--audio', 'fixture.wav', '--seconds', seconds])).toThrow('--seconds');
  }
  expect(() => parseMeetGuestOptions(['--audio', 'fixture.wav'])).toThrow('--url');
  expect(() => parseMeetGuestOptions(['--url', 'https://meet.google.com/abc-defg-hij', '--audio', 'fixture.wav', '--audio', 'other.wav'])).toThrow('Duplicate');
  expect(() => parseMeetGuestOptions(['--url', 'https://meet.google.com/abc-defg-hij', '--audio', 'fixture.wav', '--name', 'one\ntwo'])).toThrow('--name');
  expect(() => parseMeetGuestOptions(['--user-data-dir', '/my/browser'])).toThrow('Unknown');
});

test('lobby admission requires a standalone explicit opt-in', () => {
  const required = ['--url', 'https://meet.google.com/abc-defg-hij', '--audio', 'fixture.wav'];
  expect(parseMeetGuestOptions([...required, '--allow-lobby']).allowLobby).toBe(true);
  expect(parseMeetGuestOptions(['--allow-lobby', ...required]).allowLobby).toBe(true);
  expect(parseMeetGuestOptions(required).allowLobby).toBe(false);
  expect(() => parseMeetGuestOptions([...required, '--allow-lobby', '--allow-lobby'])).toThrow('Duplicate');
  expect(() => parseMeetGuestOptions([...required, '--allow-lobby', 'false'])).toThrow('Unknown');
});

test('live guest rejects non-Meet, credential, redirect, and extra URL surfaces', () => {
  for (const url of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.test/abc-defg-hij',
    'https://name:secret@meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij?authuser=0',
    'https://meet.google.com/abc-defg-hij#room', 'https://meet.google.com:8443/abc-defg-hij',
    'https://meet.google.com/lookup/team', 'file:///tmp/test']) {
    expect(() => validateMeetTestUrl(url)).toThrow();
  }
});

test('debugger connections stay on the owned loopback port and expected target kind', () => {
  expect(validateDebuggerEndpoint('ws://127.0.0.1:54321/devtools/page/ABC-123', 54321, 'page'))
    .toBe('ws://127.0.0.1:54321/devtools/page/ABC-123');
  for (const url of ['ws://localhost:54321/devtools/page/ABC', 'ws://127.0.0.1:9222/devtools/page/ABC',
    'ws://example.test:54321/devtools/page/ABC', 'wss://127.0.0.1:54321/devtools/page/ABC',
    'ws://127.0.0.1:54321/devtools/browser/ABC', 'ws://127.0.0.1:54321/devtools/page/ABC?next=elsewhere']) {
    expect(() => validateDebuggerEndpoint(url, 54321, 'page')).toThrow('Refusing');
  }
});

class FakeSocket extends EventTarget {
  sent: Array<{ id: number; method: string }> = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.dispatchEvent(new Event('close')); }
  reply(id: number, result: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) })); }
}

test('CDP fixture correlates concurrent replies and rejects pending work on close', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket as unknown as WebSocket);
  const first = client.call('Page.enable'), second = client.call('Runtime.evaluate');
  socket.reply(socket.sent[1]!.id, { value: 2 });
  socket.reply(socket.sent[0]!.id, { value: 1 });
  expect(await first).toEqual({ value: 1 }); expect(await second).toEqual({ value: 2 });
  const pending = client.call('Page.navigate');
  client.close(); await expect(pending).rejects.toThrow('disconnected');
  await expect(client.call('Browser.close')).rejects.toThrow('disconnected');
});

test('CDP fixture bounds an unresponsive command and ignores its late reply', async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket as unknown as WebSocket);
  await expect(client.call('Runtime.evaluate', {}, 10)).rejects.toThrow('timed out');
  socket.reply(socket.sent[0]!.id, { late: true });
  client.close();
});
