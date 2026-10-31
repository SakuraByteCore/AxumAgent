import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Persist observations, never executable sessions or permission bridges. */
export class TaskHistory {
 readonly directory: string;
 readonly sessionId: string;
 readonly file: string;
 constructor(base: string, cwd: string, sessionId: string) {
  this.directory=join(base,"task-history",createHash("sha256").update(realpathSync(cwd)).digest("hex"));
  this.sessionId=sessionId;
  this.file=join(this.directory,createHash("sha256").update(sessionId).digest("hex")+".json");
 }
 save(records: any[]): void {
  let previous: any[]=[];
  try {previous=JSON.parse(readFileSync(this.file,"utf8")).records;}
  catch(error:any){if(error.code!=="ENOENT")throw error;}
  const merged=new Map(previous.map(record=>[record.recordId,record]));
  for(const record of records)merged.set(record.recordId,record);
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const temp=this.file+"."+randomUUID()+".tmp";
  writeFileSync(temp,JSON.stringify({version:1,sessionId:this.sessionId,updatedAt:Date.now(),records:[...merged.values()]}),{mode:0o600});
  renameSync(temp,this.file);
 }
 read(options: {sessionId?:string; agentId?:string; batchId?:string; limit?:number} = {}) {
  let names:string[];
  try { names=readdirSync(this.directory).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)); }
  catch(error:any){if(error.code==="ENOENT")return [];throw error;}
  const records:any[]=[];
  for(const name of names){
   const saved=JSON.parse(readFileSync(join(this.directory,name),"utf8"));
   if(saved.version!==1)throw new Error("Unsupported task history version");
   if(options.sessionId && saved.sessionId!==options.sessionId)continue;
   for(const record of saved.records){
    if(options.agentId && record.id!==options.agentId || options.batchId && record.batchId!==options.batchId)continue;
    records.push({...record,sessionId:saved.sessionId,historical:true,live:false,
     state:record.state==="pending"||record.state==="running"?"unknown_after_restart":record.state,
     recordedState:record.state,updatedAt:saved.updatedAt});
   }
  }
  return records.sort((a,b)=>(b.completedAt??b.createdAt??b.updatedAt)-(a.completedAt??a.createdAt??a.updatedAt)).slice(0,options.limit??50);
 }
}
