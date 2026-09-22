import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { meetingProviderPatch, meetingRolesPatch, currentMeetingRoutes, suggestedMeetingRoutes, roleRoute } from '../src/ai-provider.ts';
import { loadConfig, resolveMeetingRoute, updateMeetingConfig } from '../src/config.ts';
import { parseCliArgs } from '../src/cli-args.ts';

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
