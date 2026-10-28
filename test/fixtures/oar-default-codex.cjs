#!/usr/bin/env node
// Offline JSON-RPC app-server; no provider, Docker, network or model calls.
const fs = require('node:fs');
const path = require('node:path');
const {createInterface} = require('node:readline');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const log = value => fs.appendFileSync(process.env.OAR_DEFAULT_LOG, JSON.stringify(value) + '\n');
let cwd;
log({spawn:process.pid,args:process.argv.slice(2)});
process.on('exit',()=>log({exit:process.pid}));
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); log({pid:process.pid,method:m.method,params:m.params});
 if(m.id===undefined)return;
 if(m.method==='thread/start'){
  cwd=m.params.cwd;
  emit({id:m.id,result:{thread:{id:'fixture-'+process.pid},model:'fixture'}});
 }else if(m.method==='turn/start'){
  const text=m.params.input.map(x=>x.text||'').join('');
  const spec=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
  const threadId='fixture-'+process.pid;
  emit({id:m.id,result:{turn:{id:'turn'}}});
  emit({method:'turn/started',params:{threadId,turn:{id:'turn'}}});
  for(const [name,content] of Object.entries(spec.files||{})){
   fs.mkdirSync(path.dirname(path.join(cwd,name)),{recursive:true});
   fs.writeFileSync(path.join(cwd,name),content);
  }
  if(spec.check){
   const result=require('node:child_process').spawnSync(process.execPath,['--check',spec.check],{cwd,encoding:'utf8'});
   if(result.status!==0)throw Error('offline syntax check failed: '+result.stderr);
   log({check:spec.check,status:result.status,pid:process.pid});
  }
  emit({method:'item/agentMessage/delta',params:{threadId,turnId:'turn',itemId:'answer',delta:'native test evidence: offline check passed'}});
  log({partial:true,cwd,pid:process.pid});
  if(!spec.hold)setTimeout(()=>{
   log({completed:true,pid:process.pid});
   emit({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
   // Duplicate terminal notification must not dispatch or publish a second task.
   emit({method:'turn/completed',params:{threadId,turn:{id:'turn',status:'completed'}}});
  },spec.delay||150);
 }else emit({id:m.id,result:{}});
});
