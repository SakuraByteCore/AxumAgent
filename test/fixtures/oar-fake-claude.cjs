#!/usr/bin/env node
// Offline protocol fixture, NOT a real Claude provider.
const fs=require('node:fs');const readline=require('node:readline');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('2.1.63 (offline fixture)');process.exit(0);}
if(args.includes('--help')){console.log('--permission-mode --tools --strict-mcp-config --mcp-config --setting-sources --settings --disable-slash-commands --no-chrome --no-session-persistence');process.exit(0);}
fs.appendFileSync(process.env.OAR_FIXTURE_LOG,JSON.stringify({args,pid:process.pid})+'\n');
const send=x=>console.log(JSON.stringify(x));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(process.env.OAR_FIXTURE_LOG,JSON.stringify({input:m})+'\n');
 if(m.type==='user'){
 send({type:'system',subtype:'init',session_id:'fixture'});
 if(JSON.stringify(m).includes('hold partial')){
  send({type:'assistant',uuid:'partial',message:{id:'partial',role:'assistant',content:[{type:'text',text:'partial native evidence'}]}});
  fs.appendFileSync(process.env.OAR_FIXTURE_LOG,JSON.stringify({partialSent:true})+'\n');return;
 }
 send({type:'assistant',uuid:'answer',message:{id:'answer',role:'assistant',content:[{type:'text',text:'offline OAR answer'}]}});
 send({type:'result',subtype:'success',is_error:false,result:'offline OAR answer'});
 send({type:'result',subtype:'success',is_error:false,result:'duplicate terminal'});
 }
 if(m.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:m.request_id}});
});
