import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-ci-test-'));
  const git = (...args) => {
    const p=spawnSync('git',args,{cwd:root,encoding:'utf8'}); assert.equal(p.status,0,p.stderr); return p.stdout.trim();
  };
  for (const dir of ['scripts','test','bin']) mkdirSync(join(root,dir));
  copyFileSync(new URL('./local-ci.mjs',import.meta.url),join(root,'scripts/local-ci.mjs'));
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@humain/engine',type:'module'}));
  writeFileSync(join(root,'.gitignore'),'.ci-results/\n');
  writeFileSync(join(root,'test/ok.test.ts'),`import assert from 'node:assert/strict';import test from 'node:test';test('fixture',()=>assert.ok(true));`);
  writeFileSync(join(root,'scripts/package-smoke.mjs'),'console.log("package passed");');
  writeFileSync(join(root,'bin/npm'),`#!${process.execPath}\nimport fs from 'node:fs';if(process.env.FIXTURE_FAIL)process.exit(7);if(process.env.FIXTURE_CHANGE)fs.appendFileSync('package.json',' ');if(process.env.FIXTURE_HANG){fs.writeFileSync(process.env.FIXTURE_PID,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100);}`,{mode:0o755});
  git('init','--quiet');git('config','user.name','Local CI Fixture');git('config','user.email','fixture@example.invalid');
  git('add','.');git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','fixture');
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH};
  const run=(args=[],extra={})=>spawnSync(process.execPath,['scripts/local-ci.mjs',...args],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:15000});
  const report=()=>JSON.parse(readFileSync(join(root,'.ci-results/latest.json'),'utf8'));
  return {root,git,env,run,report,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

test('full receipt accepts the tested commit and rejects dirty source, quick checks and failed commands',()=>{
  const f=fixture();try {
    assert.equal(f.run(['--verify']).status,1);
    let result=f.run();assert.equal(result.status,0,result.stderr);assert.equal(f.report().status,'passed');
    assert.equal(f.run(['--verify']).status,0);
    writeFileSync(join(f.root,'new-source.ts'),'export const changed=true;');
    assert.equal(f.run(['--verify']).status,1);
    result=f.run();assert.equal(result.status,0,result.stderr);
    assert.equal(f.run(['--verify']).status,1,'uncommitted source cannot certify HEAD');
    f.git('add','.');f.git('-c','core.hooksPath=/dev/null','commit','--quiet','-m','tested change');
    assert.equal(f.run(['--verify']).status,0,'committing identical tested content retains receipt');
    result=f.run(['--quick']);assert.equal(result.status,0,result.stderr);assert.equal(f.run(['--verify']).status,1);
    result=f.run([],{FIXTURE_FAIL:'1'});assert.equal(result.status,1);assert.equal(f.report().steps.at(-1).status,'failed');
    assert.equal(f.run(['--verify']).status,1);
  } finally {f.cleanup();}
});

test('source drift during checks invalidates the run and existing hooks are preserved',()=>{
  const f=fixture();try {
    assert.equal(f.run([],{FIXTURE_CHANGE:'1'}).status,1);
    assert.match(f.report().error,/Source changed/);
    const hook=join(f.root,'.git/hooks/pre-push');writeFileSync(hook,'#!/bin/sh\necho existing\n');
    assert.equal(f.run(['--install-hook']).status,1);assert.match(readFileSync(hook,'utf8'),/existing/);
    rmSync(hook);const result=f.run(['--install-hook']);assert.equal(result.status,0,result.stderr);
    assert.match(readFileSync(hook,'utf8'),/local-ci-verification/);
    assert.equal(f.run(['--install-hook']).status,0);
  } finally {f.cleanup();}
});

test('cancellation drains the active command group and cannot leave a passing receipt',async()=>{
  const f=fixture();const pidPath=join(f.root,'.ci-results/fixture.pid');
  const child=spawn(process.execPath,['scripts/local-ci.mjs'],{cwd:f.root,env:{...f.env,FIXTURE_HANG:'1',FIXTURE_PID:pidPath},stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try {
    const deadline=Date.now()+5000;
    while(!existsSync(pidPath)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.ok(existsSync(pidPath),'command started');
    const pid=Number(readFileSync(pidPath,'utf8'));child.kill('SIGTERM');
    assert.equal(await exited,1);assert.equal(f.report().status,'cancelled');
    assert.throws(()=>process.kill(pid,0));assert.equal(existsSync(join(f.root,'.ci-results/running.json')),false);
  } finally {child.kill('SIGKILL');f.cleanup();}
});
