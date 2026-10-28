import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {patchPiDispatchOnlyLoader, applyBundledPiPatches} from '../src/bundled-pi-patches.js';

const synthetic = "import {pathToFileURL} from 'node:url';\nimport path from 'node:path';\nfunction api(extension) {return {\n        registerTool(tool) {\n extension.tools.set(tool.name,{definition:tool});\n}};}\nasync function loadExtensionModule(extensionPath, cacheToken) {return (await import(pathToFileURL(extensionPath).href)).default;}\nasync function initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime) {\n const extension={tools:new Map()}; await factory(api(extension)); return extension;\n}\nasync function loadExtension(extensionPath,cwd) {\n const resolvedPath=path.resolve(cwd,extensionPath); try {\n        const factory = await loadExtensionModule(resolvedPath, cacheToken);\n return {extension:await initializeExtension(factory,extensionPath,resolvedPath,cwd)};\n } catch(e) {return {error:e.message};}\n}\nconst cacheToken=undefined;\nexport async function loadExtensionFromFactory(factory,cwd,eventBus,runtime,extensionPath='<inline>') {return initializeExtension(factory,extensionPath,extensionPath,cwd,eventBus,runtime);}\nexport async function loadExtensions(paths,cwd) {const extensions=[],errors=[];for (const p of paths) {const r=await loadExtension(p,cwd);if(r.error) errors.push(r.error);else extensions.push(r.extension);}return {extensions,errors};}\n";
const modules = process.env.AXUM_INTEGRATION_NODE_MODULES || path.resolve('../../refs/axum-validation/pi-cache/node_modules');
const sdk = path.join(modules, '@earendil-works/pi-coding-agent');

test('dispatch-only patch is idempotent and fails closed on SDK drift', () => {
 const patched = patchPiDispatchOnlyLoader(synthetic);
 assert.equal(patchPiDispatchOnlyLoader(patched), patched);
 for (const anchor of ['async function loadExtensionModule', 'async function initializeExtension', 'registerTool(tool)', 'const factory = await loadExtensionModule']) {
  assert.throws(() => patchPiDispatchOnlyLoader(synthetic.replace(anchor, 'changed')), /anchor/);
 }
 assert.match(applyBundledPiPatches.toString(), /patchPiDispatchOnlyLoader, patchPiJitiLazyLoader/);
});

for (const real of [false, true]) test(real ? 'real isolated SDK loader dispatch-only contract' : 'synthetic loader dispatch-only contract', {skip:real && !fs.existsSync(sdk)}, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axum-dispatch-loader-'));
 try {
  fs.writeFileSync(path.join(root,'package.json'), JSON.stringify({type:'module'}));
  let loaderPath;
  if (real) {
   const copy = path.join(root,'sdk'); fs.cpSync(sdk, copy, {recursive:true});
   fs.symlinkSync(modules, path.join(root,'node_modules'), 'dir');
   loaderPath = path.join(copy,'dist/core/extensions/loader.js');
   fs.writeFileSync(loaderPath, patchPiDispatchOnlyLoader(fs.readFileSync(loaderPath,'utf8')));
  } else {
   loaderPath = path.join(root,'loader.mjs'); fs.writeFileSync(loaderPath, patchPiDispatchOnlyLoader(synthetic));
  }
  const loader = await import(pathToFileURL(loaderPath).href);
  const names = ['subagent_supervisor','subagent','subagents_enable','contact_supervisor','workflowScript'];
  const allowed = ['dispatch_agent','manage_agent','structured_output','read','supervisor_status','subagent_metrics','agent','quick','orchestrate'];
  const runtime = loader.createExtensionRuntime?.();
  let api, executed = 0;
  const extension = await loader.loadExtensionFromFactory(pi => {
   api = pi;
   for (const name of [...names,...allowed]) pi.registerTool({name, parameters:{type:'object'},execute:()=>{executed++;}});
  }, root, undefined, runtime);
  assert.deepEqual([...extension.tools.keys()], allowed);
  api.registerTool({name:'subagent_supervisor',execute:()=>{executed++;}});
  assert.equal(extension.tools.has('subagent_supervisor'),false);
  assert.equal(executed,0);
  for (const [dir, manifest] of [['pi-subagents',{}],['renamed',{name:'pi-subagents'}],['scoped',{name:'@vendor/pi-subagents'}]]) {
   const base = path.join(root,dir); fs.mkdirSync(path.join(base,'src'),{recursive:true});
   fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({type:'module',...manifest}));
   const entry = path.join(base,'src/index.js');
   fs.writeFileSync(entry, 'throw new Error("IMPORT SIDE EFFECT RAN"); export default () => {};');
   const result = await loader.loadExtensions([entry],root);
   assert.equal(result.extensions.length,0);
   assert.match(JSON.stringify(result.errors), /dispatch-only policy/);
   assert.doesNotMatch(JSON.stringify(result.errors), /SIDE EFFECT/);
   await assert.rejects(loader.loadExtensionFromFactory(()=>{throw Error('FACTORY RAN');},root,undefined,undefined,entry), /dispatch-only policy/);
  }
  fs.writeFileSync(path.join(root,'package.json'), '{ malformed optional ancestor');
  const good = path.join(root,'good.mjs');
  fs.writeFileSync(good, 'export default pi => pi.registerTool({name:"read",parameters:{type:"object"}});');
  assert.equal((await loader.loadExtensions([good],root)).extensions.length,1);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
