import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { meetingProviderPatch, meetingRolesPatch, currentMeetingRoutes, suggestedMeetingRoutes, roleRoute,
  preferredAIProvider, recommendedMeetingSetup, meetingModelClass } from '../src/ai-provider.ts';
import { loadConfig, resolveMeetingRoute, updateMeetingConfig } from '../src/config.ts';
import { parseCliArgs } from '../src/cli-args.ts';
import type { HumainModelOption } from '../src/humain-client.ts';

test('provider choice replaces role overrides while retaining compatible budgets and unrelated settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'seashell-provider-'));
  const path = join(root, 'config.json');
  try {
    const raw = { futureSetting: true, libraryDir: '/tmp/library', meeting: {
      backend: 'claude-code', model: 'sonnet', mode: 'hybrid', maxBudgetMicrousd: 100000,
      calendar: { enabled: false }, contextFiles: ['/tmp/context.md'],
      routes: { chat: { backend: 'openrouter', model: 'old-model', maxCostMicrousd: 200000, maxOutputTokens: 512 } },
    } };
    writeFileSync(path, JSON.stringify(raw));
    const saved = updateMeetingConfig(meetingProviderPatch(loadConfig(path).meeting, 'codex', ' custom-model '), path);
    for (const role of ['observer', 'reconciliation', 'chat'] as const) {
      expect(resolveMeetingRoute(saved.meeting, role)).toMatchObject({ backend: 'codex', model: 'custom-model' });
      expect(resolveMeetingRoute(saved.meeting, role)?.maxBudgetMicrousd).toBeUndefined();
      expect(resolveMeetingRoute(saved.meeting, role)?.maxOutputTokens).toBeUndefined();
    }
    expect(saved.meeting?.routes?.chat?.maxCostMicrousd).toBe(200000);
    expect(saved.meeting?.mode).toBe('post-session');
    expect(saved.meeting?.calendar).toEqual({ enabled: false });
    expect(saved.meeting?.contextFiles).toEqual(['/tmp/context.md']);
    expect(JSON.parse(readFileSync(path, 'utf8')).futureSetting).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('picker requires a model and its CLI does not silently become a JSON write command', () => {
  for (const value of ['', '   ', 'model\nother', 'x'.repeat(201)]) expect(() => meetingProviderPatch(undefined, 'codex', value)).toThrow();
  expect(parseCliArgs(['ai', 'setup'])).toEqual({ kind: 'ai-setup' });
  expect(() => parseCliArgs(['ai', 'setup', '--json'])).toThrow();
});

for (const size of ['wide', 'narrow']) test(`AI picker saves explicit choices without restarting capture (${size})`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-ai-provider.tsx', import.meta.url).pathname, size], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(err);
    expect(JSON.parse(out)).toEqual({ listedBoth: true, unavailablePreservedConfig: true, codexSaved: true, captureStarts: 1, captureStops: 0 });
  } finally { clearTimeout(timer); child.kill(); }
}, 12000);


test('role edits preserve other roles, budgets and explicit mode; unsupported effort fails config validation', () => {
  const root=mkdtempSync(join(tmpdir(),'seashell-roles-'));const path=join(root,'config.json');
  try {
    writeFileSync(path,JSON.stringify({meeting:{backend:'claude-code',model:'sonnet',mode:'hybrid',maxBudgetMicrousd:100000,contextFiles:['context.md']}}));
    const current=loadConfig(path).meeting; const routes=currentMeetingRoutes(current);
    routes.chat=roleRoute(routes.chat,'codex','model','high');
    const saved=updateMeetingConfig(meetingRolesPatch(current,routes,'hybrid'),path);
    expect(resolveMeetingRoute(saved.meeting,'observer')).toMatchObject({backend:'claude-code',model:'sonnet',maxBudgetMicrousd:100000});
    expect(resolveMeetingRoute(saved.meeting,'chat')).toEqual({backend:'codex',model:'model',effort:'high'});
    expect(saved.meeting?.contextFiles).toEqual(['context.md']);
    expect(()=>meetingRolesPatch(undefined,{},'hybrid')).toThrow('Choose models');
    writeFileSync(path,JSON.stringify({meeting:{routes:{chat:{backend:'local-openai',model:'m',effort:'high'}}}}));
    expect(()=>loadConfig(path)).toThrow('effort');
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('suggestions use discovered models and only supported effort levels', () => {
  const routes=suggestedMeetingRoutes('claude-code',[
    {id:'haiku',name:'Haiku',description:'',efforts:[]},
    {id:'sonnet',name:'Sonnet',description:'',efforts:['low','medium','high']},
    {id:'fable',name:'Fable',description:'',efforts:['low','high']},
  ],{});
  expect(routes.observer).toEqual({backend:'claude-code',model:'haiku'});
  expect(routes.reconciliation).toEqual({backend:'claude-code',model:'fable',effort:'high'});
  expect(routes.chat).toEqual({backend:'claude-code',model:'sonnet',effort:'medium'});
  expect(()=>suggestedMeetingRoutes('codex',[],{})).toThrow();
});

test('automatic setup keeps expensive defaults out of live analysis and never guesses unknown cloud models', () => {
  const models: HumainModelOption[] = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'].map((id, i) => ({
    id, name: id, description: '', efforts: ['low', 'medium', 'high'], isDefault: i === 0,
  }));
  const patch = recommendedMeetingSetup(undefined, 'codex', models);
  expect(patch.mode).toBe('post-session');
  expect(patch.modelSelection).toBe('automatic');
  expect(patch.routes?.observer).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
  expect(patch.routes?.reconciliation).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
  expect(patch.routes?.chat).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' });
  const noFast = recommendedMeetingSetup({ mode: 'hybrid' }, 'codex', models.slice(0, 2));
  expect(noFast.mode).toBe('post-session');
  expect(noFast.routes?.observer).toBeUndefined();
  const unknown = { id: 'unreviewed-model', name: 'Fast cheap', description: 'Use for everything', efforts: [] };
  expect(meetingModelClass(unknown)).toBe('unknown');
  expect(() => recommendedMeetingSetup(undefined, 'openrouter', [unknown])).toThrow('Advanced');
  expect(recommendedMeetingSetup(undefined, 'local-openai', [unknown]).routes?.observer).toBeUndefined();
});

test('provider recommendation prefers configured local and native logins, while skipping unavailable routes', () => {
  const statuses = ['openrouter', 'claude-code', 'codex', 'local-openai'].map((id) => ({ id, ready: true }));
  expect(preferredAIProvider(statuses)).toBe('local-openai');
  expect(preferredAIProvider(statuses.slice(0, 3))).toBe('codex');
  expect(preferredAIProvider(statuses.map((status) => ({ ...status, ready: status.id === 'claude-code' })))).toBe('claude-code');
  expect(preferredAIProvider([])).toBeUndefined();
});

for (const size of ['wide', 'narrow']) test(`first AI use needs only one confirmation and resumes the question (${size})`, async () => {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/tui-ai-onboarding.tsx', import.meta.url).pathname, size], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(err);
    expect(JSON.parse(out)).toEqual({ automatic: true, resumedQuestion: true, noModelCalls: true, cancelledSafely: true });
  } finally { clearTimeout(timer); child.kill(); }
}, 10000);
