import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(import.meta.dir, '../native/bin/seashell-meeting-accessibility');
const available = process.platform === 'darwin' && existsSync(binary);
if (!available && process.env.SEASHELL_REQUIRE_NATIVE_TESTS === '1') {
  throw new Error('Native Accessibility helper must be built before required fixture tests.');
}
const directory = mkdtempSync(join(tmpdir(), 'seashell-accessibility-test-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
type AXNode = {
  role: string; title?: string; description?: string; value?: string;
  url?: string; identifier?: string; documentId?: string; classList?: string[];
  children?: AXNode[]; incomplete?: boolean;
};
const page = (children: AXNode[], url = 'https://meet.google.com/abc-defg-hij'): AXNode => ({ role: 'AXWebArea', url, children });
const window = (...children: AXNode[]): AXNode => ({ role: 'AXWindow', children });
const browser = (children: AXNode[], name = 'chrome') => ({ browser: name, running: true, root: { role: 'AXApplication', children } });
const leave: AXNode = { role: 'AXButton', description: 'Leave call' };
let sequence = 0;
function probe(browsers: unknown[], args: string[] = []) {
  const path = join(directory, `fixture-${sequence++}.json`);
  writeFileSync(path, JSON.stringify({ browsers }), { mode: 0o600 });
  const result = Bun.spawnSync([binary, '--fixture', path, ...args]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function actualFixture(name: 'chrome-speaking' | 'chrome-muted') {
  return JSON.parse(readFileSync(resolve(import.meta.dir, `fixtures/meet-accessibility/${name}.json`), 'utf8'));
}
function allNodes(node: AXNode): AXNode[] { return [node, ...(node.children ?? []).flatMap(allNodes)]; }

describe.skipIf(!available)('native Accessibility classifier', () => {
  test('labels a genuine remote speaker in the sanitized real Chrome AX tree', () => {
    const result = probe(actualFixture('chrome-speaking').browsers);
    expect(result.state).toBe('connected');
    expect(result.snapshot.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Local Tester', self: true, speaking: false }),
      expect.objectContaining({ name: 'Seashell Test Speaker', self: false, speaking: true }),
    ]));
  });
  test('the same real tile becomes inactive when the test guest mutes', () => {
    const active = probe(actualFixture('chrome-speaking').browsers);
    const muted = probe(actualFixture('chrome-muted').browsers);
    const before = active.snapshot.participants.find((p: any) => p.name === 'Seashell Test Speaker');
    const after = muted.snapshot.participants.find((p: any) => p.name === 'Seashell Test Speaker');
    expect(before.speaking).toBe(true);
    expect(after.speaking).toBe(false);
    expect(before.id).toBe(after.id);
  });
  test('without a visible roster, only a muted local mic permits active remote labels', () => {
    const fixture = actualFixture('chrome-speaking');
    const root = fixture.browsers[0].root as AXNode;
    const area = allNodes(root).find(n => n.role === 'AXWebArea')!;
    area.children = area.children!.filter(n => n.role !== 'AXList');
    expect(probe(fixture.browsers).snapshot.participants).toEqual([
      expect.objectContaining({ name: 'Seashell Test Speaker', self: false, speaking: true }),
    ]);
    allNodes(area).find(n => n.description === 'Turn on microphone')!.description = 'Turn off microphone';
    expect(probe(fixture.browsers).snapshot.participants).toEqual([]);
  });
  test('a changed name on a reused tile creates a different speaker identity', () => {
    const fixture = actualFixture('chrome-speaking');
    const before = probe(fixture.browsers).snapshot.participants.find((p: any) => p.name === 'Seashell Test Speaker');
    for (const node of allNodes(fixture.browsers[0].root)) if (node.value === 'Seashell Test Speaker') node.value = 'Another Test Speaker';
    const after = probe(fixture.browsers).snapshot.participants.find((p: any) => p.name === 'Another Test Speaker');
    expect(after.id).not.toBe(before.id);
  });
  test('a changing document cannot reuse prior speaker identities', () => {
    const fixture = actualFixture('chrome-speaking');
    const before = probe(fixture.browsers).snapshot.participants.find((p: any) => p.name === 'Seashell Test Speaker');
    allNodes(fixture.browsers[0].root).find(n => n.role === 'AXWebArea')!.documentId = 'new-document';
    const after = probe(fixture.browsers).snapshot.participants.find((p: any) => p.name === 'Seashell Test Speaker');
    expect(after.id).not.toBe(before.id);
  });
  test('does not associate a free-floating speaking badge with a nearby name', () => {
    const fixture = actualFixture('chrome-speaking');
    for (const node of allNodes(fixture.browsers[0].root)) if (node.classList?.includes('oZRSLe')) node.classList = [];
    expect(probe(fixture.browsers).snapshot.participants).toEqual([]);
  });
  test('an unknown simultaneous active badge prevents confident partial attribution', () => {
    const fixture = actualFixture('chrome-speaking');
    const area = allNodes(fixture.browsers[0].root).find(n => n.role === 'AXWebArea')!;
    area.children!.push({ role: 'AXGroup', identifier: 'unbound-speaker', classList: ['DYfzY', 'cYKTje', 'Oaajhc'] });
    expect(probe(fixture.browsers).snapshot.participants).toEqual([]);
  });
  test('duplicate named remote tiles remain distinct and overlapping', () => {
    const fixture = actualFixture('chrome-speaking');
    const area = allNodes(fixture.browsers[0].root).find(n => n.role === 'AXWebArea')!;
    const remote = area.children!.find(n => n.classList?.includes('oZRSLe') && allNodes(n).some(n => n.value === 'Seashell Test Speaker'))!;
    const duplicate = structuredClone(remote);
    for (const node of allNodes(duplicate)) if (node.identifier) node.identifier += '-duplicate';
    area.children!.push(duplicate);
    const result = probe(fixture.browsers);
    const active = result.snapshot.participants.filter((p: any) => p.speaking);
    expect(active).toHaveLength(2);
    expect(active[0].id).not.toBe(active[1].id);
    expect(result.detail).toContain('overlapping');
  });
  test('duplicate display names matching the local user cannot establish self identity', () => {
    const fixture = actualFixture('chrome-speaking');
    for (const node of allNodes(fixture.browsers[0].root)) if (node.value === 'Seashell Test Speaker') node.value = 'Local Tester';
    expect(probe(fixture.browsers).snapshot.participants).toEqual([]);
  });
  test('Chrome class fixtures do not silently enable an unvalidated Safari adapter', () => {
    const fixture = actualFixture('chrome-speaking');
    fixture.browsers[0].browser = 'safari';
    const result = probe(fixture.browsers);
    expect(result.state).toBe('connected');
    expect(result.snapshot.participants).toEqual([]);
  });
  test('does not invent a call when no browser is running', () => {
    expect(probe([{ browser: 'chrome', running: false }])).toMatchObject({
      state: 'idle', absenceConfirmed: true, transport: 'accessibility',
    });
  });
  test('no visible Meet is not proof an established call ended', () => {
    expect(probe([browser([window(page([], 'https://example.com/'))])])).toMatchObject({
      state: 'idle', absenceConfirmed: false,
    });
  });
  test('a Meet landing tab is not mistaken for a hidden call', () => {
    expect(probe([browser([window(page([], 'https://meet.google.com/home'), { role: 'AXRadioButton', description: 'Google Meet - Memory usage - 204 MB' })])])).toMatchObject({
      state: 'idle', absenceConfirmed: false,
    });
  });
  test('detects a muted joined call from its actual Leave call control', () => {
    expect(probe([browser([window(page([leave, { role: 'AXButton', description: 'Turn on microphone' }]))])])).toMatchObject({
      state: 'connected', browser: 'chrome', snapshot: { meeting: '/abc-defg-hij', joined: true, participants: [] },
    });
  });
  test.each(['Join now', 'Ask to join', 'Rejoin'])('recognizes prejoin control %s', (title) => {
    expect(probe([browser([window(page([{ role: 'AXButton', title }]))])])).toMatchObject({ state: 'idle', absenceConfirmed: true });
  });
  test('recognizes a positively observed departure screen', () => {
    expect(probe([browser([window(page([{ role: 'AXHeading', title: 'You left the meeting' }]))])])).toMatchObject({ state: 'idle', absenceConfirmed: true });
  });
  test('transient conflicting call controls are unknown', () => {
    expect(probe([browser([window(page([leave, { role: 'AXButton', title: 'Join now' }]))])]).state).toBe('unavailable');
  });
  test('room URL alone does not prove joined or ended', () => {
    expect(probe([browser([window(page([]))])]).state).toBe('unavailable');
  });
  test('an unexposed background Meet tab prevents a false departure', () => {
    expect(probe([browser([window(page([], 'https://example.com/'), { role: 'AXRadioButton', description: 'Meet - abc-defg-hij' })])]).state).toBe('unavailable');
  });
  test('in-page radio controls are not treated as hidden browser tabs', () => {
    expect(probe([browser([window(page([leave, { role: 'AXRadioButton', description: 'Meet - xyz-abcd-efg' }]))])]).state).toBe('connected');
  });
  test('two joined calls are ambiguous within a browser', () => {
    expect(probe([browser([window(page([leave])), window(page([leave], 'https://meet.google.com/xyz-abcd-efg'))])]).state).toBe('ambiguous');
  });
  test('two joined browsers are ambiguous', () => {
    expect(probe([browser([window(page([leave]))]), browser([window(page([leave]))], 'safari')]).state).toBe('ambiguous');
  });
  test('unreadable second browser prevents mixed audio attribution', () => {
    expect(probe([browser([window(page([leave]))]), { browser: 'safari', running: true }]).state).toBe('unavailable');
  });
  test('browser selection can explicitly constrain the reader', () => {
    expect(probe([browser([window(page([leave]))]), { browser: 'safari', running: true }], ['--browser', 'chrome']).state).toBe('connected');
  });
  test('truncated or overlarge AX trees fail closed', () => {
    expect(probe([browser([{ role: 'AXWindow', incomplete: true, children: [page([leave])] }])]).state).toBe('unavailable');
    expect(probe([browser([window(page(Array.from({ length: 301 }, () => leave)))])]).state).toBe('unavailable');
  });
  test('deep trees fail closed', () => {
    let tree: AXNode = page([leave]);
    for (let i = 0; i < 55; i++) tree = { role: 'AXGroup', children: [tree] };
    expect(probe([browser([window(tree)])]).state).toBe('unavailable');
  });
  test('an unavailable window is not idle', () => {
    expect(probe([browser([window()])]).state).toBe('unavailable');
  });
  test('extra web areas in one window cannot hide another unreadable window', () => {
    expect(probe([browser([
      window(page([leave]), page([], 'https://example.com/')),
      window(),
    ])]).state).toBe('unavailable');
  });
  test('missing page addresses are unknown, not ordinary non-Meet pages', () => {
    expect(probe([browser([window({ role: 'AXWebArea' })])]).state).toBe('unavailable');
    expect(probe([
      browser([window(page([leave]))]),
      browser([window({ role: 'AXWebArea', url: '' })], 'safari'),
    ]).state).toBe('unavailable');
  });
  test('readable internal browser URLs remain ordinary non-Meet pages', () => {
    expect(probe([browser([window(page([], 'chrome://newtab/'))])])).toMatchObject({ state: 'idle', absenceConfirmed: false });
  });
  test.each([
    'https://meet.google.com.evil.example/abc-defg-hij',
    'https://meet.google.com@evil.example/abc-defg-hij',
    'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com/home',
  ])('ignores other pages even with meeting-looking content: %s', (url) => {
    expect(probe([browser([window(page([leave], url))])]).state).toBe('idle');
  });
  test('does not read meeting-looking content inside another site', () => {
    const otherPage = page([page([leave])], 'https://example.com/');
    expect(probe([browser([window(otherPage)])]).state).toBe('idle');
  });
  test('does not invent named speakers from roster, chat, captions, or generic labels', () => {
    const untrustedLabels: AXNode[] = [
      { role: 'AXGroup', description: 'Alice is speaking' },
      { role: 'AXStaticText', value: 'Alice is speaking' },
      { role: 'AXButton', description: 'Bob, speaking' },
      { role: 'AXImage', description: 'Carol is speaking' },
      { role: 'AXGroup', children: [{ role: 'AXStaticText', value: 'Alice' }, { role: 'AXStaticText', value: 'Speaking' }] },
    ];
    expect(probe([browser([window(page([leave, ...untrustedLabels]))])]).snapshot.participants).toEqual([]);
  });
  test('does not merge duplicate display names into one confident speaker', () => {
    const duplicate = { role: 'AXGroup', description: 'Alex is speaking' };
    expect(probe([browser([window(page([leave, duplicate, duplicate]))])]).snapshot.participants).toEqual([]);
  });
  test('invalid fixtures fail with a bounded machine-readable response', () => {
    const path = join(directory, 'invalid.json');
    writeFileSync(path, '{bad json');
    const result = Bun.spawnSync([binary, '--fixture', path]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString()).state).toBe('unavailable');
  });
  test('oversized fixtures are rejected before decoding', () => {
    const path = join(directory, 'oversized.json');
    writeFileSync(path, ' '.repeat(2 * 1024 * 1024 + 1));
    const result = Bun.spawnSync([binary, '--fixture', path]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout.toString()).detail).toContain('oversized');
  });
  test('fixture replay never requests or reads live permissions', () => {
    const result = probe([{ browser: 'chrome', running: false }], ['--request-permission']);
    expect(result.state).toBe('idle');
    expect(result.accessibilityTrusted).toBeUndefined();
  });
  test('invalid CLI arguments fail without prompting', () => {
    for (const args of [['--browser', 'unknown'], ['--dump-tree'], ['--unexpected'], ['--fixture']]) {
      const result = Bun.spawnSync([binary, ...args]);
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout.toString()).state).toBe('unavailable');
    }
  });
});
