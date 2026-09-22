import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'stream';
import { stripVTControlCharacters } from 'util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const root=mkdtempSync(join(tmpdir(),'seashell-picker-ui-'));
const config=join(root,'config.json');
process.env.SEASHELL_CONFIG=config; process.env.SEASHELL_LIBRARY_DIR=join(root,'library'); process.env.SEASHELL_DISABLE_SYSTEM_AUDIO='1';
writeFileSync(config,JSON.stringify({meeting:{automation:{enabled:false}},transcription:{mode:'local',canonicalFinal:'local'}}));
const original=readFileSync(config,'utf8');
const mic={...await import('../../src/live-microphone.ts')};
const client={...await import('../../src/humain-client.ts')};
let starts=0,stops=0;
mock.module('../../src/live-microphone.ts',()=>({...mic,startMicrophoneCapture(options:any){ starts++;options.onState({state:'active'});return {done:Promise.resolve(),startup:Promise.resolve(),stop(){stops++;}}; }}));
mock.module('../../src/humain-client.ts',()=>({...client,async discoverHumainProviders(){return {integrations:[
  {id:'claude-code',ready:true,detail:'installed and authenticated'}, {id:'codex',ready:true,detail:'installed and authenticated'},
  {id:'local-openai',ready:false,detail:'No server',nextStep:'Configure your local model server'},
 ]};},async discoverHumainModels(backend:string){return backend==='codex' ? [
  {id:'fixture-fast',name:'Codex Fast',description:'Fast',efforts:['low','high']},
  {id:'fixture-codex',name:'Codex Detailed',description:'Detailed',efforts:['low','medium','high']},
] : [
  {id:'haiku',name:'Haiku',description:'Fast',efforts:[]},
  {id:'sonnet',name:'Sonnet',description:'Balanced',efforts:['low','medium','high']},
  {id:'fable',name:'Fable',description:'Detailed',efforts:['low','medium','high','max']},
];},async runHumainMeeting(){throw new Error('Choosing a provider must not dispatch a model');}}));
const columns=process.argv[2]==='narrow'?48:100;
Object.defineProperty(process.stdout,'columns',{value:columns});Object.defineProperty(process.stdout,'rows',{value:28});
const {default:App}=await import('../../src/app.tsx');
const input=Object.assign(new PassThrough(),{isTTY:true,setRawMode(){},ref(){},unref(){}});
let rendered='';
const output=Object.assign(new Writable({write(chunk,_enc,cb){rendered+=chunk.toString();cb();}}),{columns,rows:28});
const app=render(<App/>,{stdin:input as any,stdout:output as any,stderr:output as any,debug:true,patchConsole:false,exitOnCtrlC:false});
const until=async(check:()=>boolean)=>{const end=Date.now()+3000;while(!check()&&Date.now()<end)await Bun.sleep(10);assert.ok(check(),'UI condition timed out');};
const type=async(text:string)=>{input.write(text);await Bun.sleep(80);};
try{
  await until(()=>starts===1);
  await type('p');await until(()=>/models by role/.test(stripVTControlCharacters(rendered)));
  await type('\r');await until(()=>/Codex · Ready/.test(stripVTControlCharacters(rendered)));
  const listedBoth=/Claude Code · Ready/.test(stripVTControlCharacters(rendered));
  await type('\x1b[B');await type('\x1b[B');await type('\r');
  assert.ok(rendered.includes('Configure your local model server'));
  const unavailablePreservedConfig=readFileSync(config,'utf8')===original;
  await type('\x1b');
  for(let i=0;i<3;i++)await type('\x1b[B');await type('\r');await type('\r');
  await until(()=>rendered.includes('Suggested models filled in'));
  assert.equal(readFileSync(config,'utf8'),original,'Suggestions are only a draft');
  for(let i=0;i<3;i++)await type('\x1b[A');await type('\r');await type('\x1b[B');await type('\r');
  await until(()=>rendered.includes('Codex Detailed'));
  await type('\x1b[B');await type('\r');
  await until(()=>rendered.includes('reasoning effort'));
  for(let i=0;i<3;i++)await type('\x1b[B');await type('\r');
  await type('\x1b[B');await type('\x1b[B');await type('\r'); // explicitly enable live + final
  if(process.env.SEASHELL_TUI_EVIDENCE)writeFileSync(process.env.SEASHELL_TUI_EVIDENCE,stripVTControlCharacters(rendered));
  await type('\x1b[B');await type('\r');
  const saved=JSON.parse(readFileSync(config,'utf8'));
  const codexSaved=saved.meeting.routes.chat.backend==='codex'&&saved.meeting.routes.chat.model==='fixture-codex'&&saved.meeting.routes.chat.effort==='high';
  assert.equal(saved.meeting.routes.observer.model,'haiku');assert.equal(saved.meeting.routes.observer.effort,undefined);
  assert.equal(saved.meeting.routes.reconciliation.model,'fable');assert.equal(saved.meeting.routes.reconciliation.effort,'high');
  assert.equal(saved.meeting.mode,'hybrid');
  assert.deepEqual(saved.transcription,JSON.parse(original).transcription);
  console.log(JSON.stringify({listedBoth,unavailablePreservedConfig,codexSaved,captureStarts:starts,captureStops:stops}));
}finally{app.unmount();rmSync(root,{recursive:true,force:true});}
