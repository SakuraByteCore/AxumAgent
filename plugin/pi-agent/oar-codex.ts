import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm, realpath, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants } from 'node:fs';
import { createOarRuntime, type Runtime, type RuntimeResult } from './runtime.js';

export interface CodingDeployment {
 image: string; apiKey: string; baseUrl: string; model: string;
 /** Absolute deployment-owned Docker CLI, never a task-provided command. */
 docker?: string;
}
export interface CodingOptions { cwd: string; writable: boolean; deployment?: CodingDeployment }
/** Pure deployment launcher plan. Image must contain /usr/local/bin/codex with
 * Linux sandbox support. Pin and audit the image (including its ENTRYPOINT,
 * system config and Codex version); the entrypoint is overridden here.
 * Docker daemon is trusted. No daemon socket, host HOME or config is mounted.
 * App-server has provider networking; Codex shell sandbox MUST disable network.
 */
export function codingContainerArgs(cwd: string, writable: boolean, deployment: CodingDeployment): string[] {
 if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(deployment.image)) throw new Error('OAR_CODEX_IMAGE must be digest-pinned');
 if (!path.isAbsolute(cwd) || /[,\n\r]/.test(cwd)) throw new Error('Invalid snapshot mount');
 const endpoint = new URL(deployment.baseUrl);
 if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider requires credential-free HTTPS URL');
 if (!deployment.apiKey || !deployment.model) throw new Error('Explicit provider credential and model required');
 const uid=process.getuid?.(), gid=process.getgid?.();
 if(uid===undefined || gid===undefined || uid===0)throw new Error('OAR Docker requires a non-root Linux host account');
 const mode = writable ? 'workspace-write' : 'read-only';
 const config: Record<string,string> = {
  sandbox_mode: JSON.stringify(mode), approval_policy: '"never"',
  'sandbox_workspace_write.network_access': 'false',
  'sandbox_workspace_write.exclude_tmpdir_env_var': 'true',
  'sandbox_workspace_write.exclude_slash_tmp': 'true',
  model_provider: '"axum"', model: JSON.stringify(deployment.model),
  'model_providers.axum.name': '"Axum deployment"',
  'model_providers.axum.base_url': JSON.stringify(deployment.baseUrl),
  'model_providers.axum.env_key': '"AXUM_PROVIDER_KEY"',
  'model_providers.axum.wire_api': '"responses"',
  'shell_environment_policy.inherit': '"none"',
  'shell_environment_policy.ignore_default_excludes': 'false',
  'projects."/workspace".trust_level': '"untrusted"',
  mcp_servers: '{}', web_search: '"disabled"', 'features.web_search_request': 'false', 'features.multi_agent': 'false',
 };
 return ['run','--rm','--interactive','--init','--pull=never','--read-only',
  '--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256',
  '--user='+uid+':'+gid,'--workdir=/workspace',
  '--tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777',
  '--tmpfs=/home/codex:rw,nosuid,nodev,size=64m,mode=1777',
  '--env=HOME=/home/codex','--env=CODEX_HOME=/home/codex/.codex',
  '--env=AXUM_PROVIDER_KEY',
  '--mount', 'type=bind,src='+cwd+',dst=/workspace'+(writable ? '' : ',readonly'),
  '--entrypoint=/usr/local/bin/codex', deployment.image, 'app-server',
  ...Object.entries(config).flatMap(([k,v]) => ['-c',k+'='+v]), '--listen','stdio://'];
}
/** Real OAR transport factory for offline scripted app-server tests. This lower
 * level API does not supply isolation; production uses loadOarCodingRuntime. */
export async function createCodingTransport(installation: object, writable: boolean, env: Record<string,string|null> = {}): Promise<Runtime> {
 const { codexSession } = await import('./vendor/oar/runtimes/codex/session.js');
 const { awaitTurnEnd } = await import('./vendor/oar/observe/turns.js');
 return createOarRuntime({ installation: async () => installation, session: (i: any, o: any) => codexSession(i, { ...o, sandboxMode: writable ? 'workspace-write' : 'read-only' }) } as any, awaitTurnEnd as any, { env });
}
/** Required deployment variables: AXUM_OAR_CODEX_IMAGE (digest),
 * AXUM_OAR_CODEX_API_KEY, AXUM_OAR_CODEX_BASE_URL (HTTPS Responses API),
 * AXUM_OAR_CODEX_MODEL. Docker at /usr/bin/docker with local pinned image.
 * Snapshot must be independent and owned by the non-root host account. No fallback
 * to host execution. No model requests are made during construction.
 */
export async function loadOarCodingRuntime(options: CodingOptions): Promise<Runtime> {
 if (Number(process.versions.node.split('.')[0]) < 24)throw new Error('Default OAR Codex requires Node >=24; no fallback started');
 if (!options || typeof options.writable !== 'boolean') throw new Error('Explicit isolated snapshot and writable policy required');
 const cwd = await realpath(options.cwd);
 const deployment = Object.freeze({ ...(options.deployment ?? {
  image: process.env.AXUM_OAR_CODEX_IMAGE ?? '', apiKey: process.env.AXUM_OAR_CODEX_API_KEY ?? '',
  baseUrl: process.env.AXUM_OAR_CODEX_BASE_URL ?? '', model: process.env.AXUM_OAR_CODEX_MODEL ?? '',
 }) });
 const docker = deployment.docker ?? '/usr/bin/docker';
 if (!path.isAbsolute(docker)) throw new Error('Docker executable must be absolute');
 const args = codingContainerArgs(cwd, options.writable, deployment);
 try{await access(docker, constants.X_OK);}catch{throw new Error('Default OAR Codex requires executable /usr/bin/docker (or deployment-owned Docker CLI), local pinned image and working native sandbox; no fallback started');}
 const writable = options.writable;
 return { start(request) {
  if (path.resolve(request.cwd) !== cwd) throw new Error('Runtime snapshot mismatch');
  // Adapter creates a private wrapper per run; generated code contains no key.
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once:true });
  if (request.signal.aborted) abort();
  const input = { ...request, signal:controller.signal };
  const startedAt=Date.now();
  let handle: ReturnType<Runtime['start']> | undefined;
  const ready = (async ():Promise<RuntimeResult> => {
   const dir = await mkdtemp(path.join(tmpdir(), 'axum-oar-codex-'));
   const containerName = 'axum-oar-' + randomUUID();
   const runArgs = [...args]; runArgs.splice(1, 0, '--name=' + containerName);
   let result: RuntimeResult={text:'',stopReason:'error',partial:true,diagnostics:[]};
   try {
    const wrapper = path.join(dir, 'codex');
    const source = '#!' + process.execPath + '\n' +
     'const {spawn}=require("node:child_process");const c=spawn('+JSON.stringify(docker)+','+JSON.stringify(runArgs)+',{stdio:"inherit",env:{PATH:"/usr/bin:/bin",AXUM_PROVIDER_KEY:process.env.AXUM_PROVIDER_KEY}});'+
     'for(const s of ["SIGINT","SIGTERM"])process.on(s,()=>c.kill(s));c.on("error",()=>process.exit(127));c.on("exit",c=>process.exit(c??1));\n';
    await writeFile(wrapper, source, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const env: Record<string,string|null> = Object.fromEntries(Object.keys(process.env).map(k => [k,null]));
    env.PATH = '/usr/bin:/bin'; env.HOME = dir; env.CODEX_HOME = dir;
    env.AXUM_PROVIDER_KEY = deployment.apiKey;
    const runtime = await createCodingTransport({ kind:'available', via:'executable', command:wrapper }, writable, env);
    handle = runtime.start({ ...input, cwd: '/workspace', ...(input.timeoutMs===undefined?{}:{timeoutMs:Math.max(1,input.timeoutMs-(Date.now()-startedAt))}) });
    result=await handle.result;
   } catch {result={...result,stopReason:controller.signal.aborted?'aborted':'error',partial:true,diagnostics:[...result.diagnostics,{stage:'startup',message:'OAR isolated runtime startup failed; check Docker image, provider configuration and native sandbox prerequisites'}]};}
   finally {
    request.signal.removeEventListener('abort', abort);
    try { await new Promise<void>((resolve, reject) => execFile(docker, ['rm','--force',containerName], { env:{PATH:'/usr/bin:/bin'}, timeout:10000 }, (error, _stdout, stderr) => { if (error && !stderr.includes('No such container')) reject(new Error('Container cleanup failed')); else resolve(); }));
    await rm(dir, { recursive:true, force:true });
    }catch{result={...result,cleanupFailure:{stage:'dispose',message:'OAR container cleanup failed; inspect owned container '+containerName+' before redispatch'}};}
   }
   return result;
  })();
  return { result:ready, wait: ms => ms === undefined ? ready : new Promise(resolve => { const t=setTimeout(()=>resolve(undefined),ms); void ready.then(r=>{clearTimeout(t);resolve(r);},()=>{clearTimeout(t);resolve(undefined);}); }),
   cancel: async()=>{ controller.abort(); await handle?.cancel(); await ready; }, dispose: async()=>{ controller.abort(); await handle?.dispose(); await ready; } };
 } };
}
