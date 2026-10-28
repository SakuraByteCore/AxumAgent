import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
const root = new URL('../plugin/pi-agent/',import.meta.url);
const runtime = 'data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(readFileSync(new URL('runtime.ts',root),'utf8'),{mode:'transform'})).toString('base64');
let source=stripTypeScriptTypes(readFileSync(new URL('oar-codex.ts',root),'utf8'),{mode:'transform'}).replace("'./runtime.js'",JSON.stringify(runtime)).replaceAll("'./vendor/oar/", "'"+new URL('vendor/oar/',root).href);
const {codingContainerArgs,createCodingTransport,loadOarCodingRuntime}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const deployment={image:'example/codex@sha256:'+'a'.repeat(64),apiKey:'fixture-secret',baseUrl:'https://provider.example/v1',model:'fixture'};
test('fixed launcher contains only snapshot and immutable sandbox without secrets',()=>{
 process.env.OAR_CODEX_SANDBOX='danger-full-access';
 for(const writable of [true,false]){
 const a=codingContainerArgs('/snapshot',writable,deployment);
 assert.ok(a.includes('--user='+process.getuid()+':'+process.getgid()));assert.ok(a.includes('--read-only'));assert.ok(a.includes('--cap-drop=ALL'));
 assert.ok(a.includes('sandbox_mode='+JSON.stringify(writable?'workspace-write':'read-only')));
 assert.ok(a.includes('sandbox_workspace_write.network_access=false'));
 assert.equal(a.filter(x=>x==='--mount').length,1);
 assert.ok(a.includes('type=bind,src=/snapshot,dst=/workspace'+(writable?'':',readonly')));
 assert.ok(!a.join(' ').includes('fixture-secret'));assert.ok(!a.join(' ').includes('danger-full-access'));
 }
 delete process.env.OAR_CODEX_SANDBOX;
});
test('invalid deployment and bind injection fail closed',async()=>{
 for(const image of ['codex:latest','--privileged','repo@sha256:bad']) assert.throws(()=>codingContainerArgs('/snapshot',true,{...deployment,image}));
 assert.throws(()=>codingContainerArgs('/snapshot,src=/',true,deployment));
 assert.throws(()=>codingContainerArgs('/snapshot',true,{...deployment,baseUrl:'http://provider'}));
 await assert.rejects(loadOarCodingRuntime({cwd:tmpdir(),writable:false,deployment:{...deployment,docker:'/nonexistent/docker'}}));
});
test('real vendored transport completes scripted offline turn',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oar-fixture-'));
 try {
 const file=path.join(dir,'codex');
 const fixture = [
 "const {createInterface}=require('node:readline');",
 "const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');",
 "createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;",
 "if(m.method==='thread/start')emit({id:m.id,result:{thread:{id:'fixture'},model:'fixture'}});",
 "else if(m.method==='turn/start'){emit({id:m.id,result:{turn:{id:'turn'}}});",
 "emit({method:'turn/started',params:{threadId:'fixture',turn:{id:'turn'}}});",
 "emit({method:'item/agentMessage/delta',params:{threadId:'fixture',turnId:'turn',itemId:'answer',delta:'offline answer'}});",
 "emit({method:'turn/completed',params:{threadId:'fixture',turn:{id:'turn',status:'completed'}}});}",
 "else emit({id:m.id,result:{}});});"
 ].join('\n');
 await writeFile(file,'#!'+process.execPath+'\n'+fixture,{mode:0o700});
 const r=await createCodingTransport({kind:'available',via:'executable',command:file},false,{HOME:dir,CODEX_HOME:dir});
 const result=await r.start({task:'offline',cwd:dir,signal:new AbortController().signal,timeoutMs:3000}).result;
 assert.equal(result.stopReason,'completed');assert.equal(result.text,'offline answer');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('production wrapper scrubs ambient config and awaits explicit container cleanup',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oar-launcher-'));
 const docker=path.join(dir,'docker'),ledger=path.join(dir,'ledger');
 try {
 const script = [
 "const fs=require('node:fs');",
 'fs.appendFileSync('+JSON.stringify(ledger)+',JSON.stringify({args:process.argv.slice(2),env:process.env})+"\\n");',
 "if(process.argv[2]==='rm')process.exit(0);",
 "require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:'offline refused'}})+'\\n');});"
 ].join('\n');
 await writeFile(docker,'#!'+process.execPath+'\n'+script,{mode:0o700});
 process.env.DOCKER_HOST='untrusted';process.env.OPENAI_API_KEY='host-secret';
 const runtime=await loadOarCodingRuntime({cwd:dir,writable:false,deployment:{...deployment,docker}});
 assert.throws(()=>runtime.start({cwd:'/',task:'x',signal:new AbortController().signal}),/snapshot mismatch/);
 const result=await runtime.start({cwd:dir,task:'x',signal:new AbortController().signal,timeoutMs:2000}).result;
 assert.equal(result.stopReason,'error');
 const entries=readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(entries.length,2);assert.equal(entries[1].args[0],'rm');
 assert.equal(entries[0].env.DOCKER_HOST,undefined);assert.equal(entries[0].env.OPENAI_API_KEY,undefined);
 assert.equal(entries[0].env.AXUM_PROVIDER_KEY,'fixture-secret');
 assert.ok(entries[0].args.includes('type=bind,src='+dir+',dst=/workspace,readonly'));
 }finally{delete process.env.DOCKER_HOST;delete process.env.OPENAI_API_KEY;await rm(dir,{recursive:true,force:true});}
});

test('container cleanup failure remains structured and cancellation does not duplicate removal',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'oar-cleanup-'));
 const docker=path.join(dir,'docker'),ledger=path.join(dir,'ledger');
 try{
  const script='#!'+process.execPath+'\n'+
   'const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(ledger)+',process.argv[2]+"\\n");'+
   'if(process.argv[2]==="rm"){process.stderr.write("offline daemon unavailable");process.exit(1);}'+
   'require("node:readline").createInterface({input:process.stdin}).on("line",l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,error:{code:-1,message:"refused"}})+"\\n");});';
  await writeFile(docker,script,{mode:0o700});
  const runtime=await loadOarCodingRuntime({cwd:dir,writable:true,deployment:{...deployment,docker}});
  const handle=runtime.start({cwd:dir,task:'one task',signal:new AbortController().signal});
  const result=await handle.result;
  assert.equal(result.stopReason,'error');assert.equal(result.cleanupFailure.stage,'dispose');
  await Promise.all([handle.cancel(),handle.dispose(),handle.cancel()]);
  assert.equal(readFileSync(ledger,'utf8').trim().split('\n').filter(x=>x==='rm').length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
