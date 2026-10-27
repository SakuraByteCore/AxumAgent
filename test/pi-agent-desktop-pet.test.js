import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { petState, petLaunchCommand, registerDesktopPet } from '../plugin/pi-agent/desktop-pet.ts';

test('desktop pet reflects lifecycle, confirmation and failure without launching Windows', async (t) => {
 const platform = Object.getOwnPropertyDescriptor(process, 'platform');
 const disabled = process.env.AXUM_DESKTOP_PET;
 Object.defineProperty(process, 'platform', {value:'win32'});
 delete process.env.AXUM_DESKTOP_PET;
 t.after(() => { Object.defineProperty(process,'platform',platform); if(disabled === undefined) delete process.env.AXUM_DESKTOP_PET; else process.env.AXUM_DESKTOP_PET=disabled; });
 const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
 let args;
 const spawnMock=t.mock.method(childProcess,'spawn', (_command, argv) => {args=argv; return child;});
 syncBuiltinESMExports(); t.after(()=>{spawnMock.mock.restore(); syncBuiltinESMExports();});
 const handlers = new Map(); registerDesktopPet({on:(name,fn)=>handlers.set(name,fn)});
 let answer;
 const ctx = {hasUI:true,ui:{notify:()=>{}, confirm:()=>new Promise(resolve=>{answer=resolve;}),select:async()=>'',input:async()=>''}};
 handlers.get('session_start')({},ctx);
 const path=args[args.indexOf('-StatePath')+1];
 t.after(()=>handlers.get('session_shutdown')());
 const state=()=>JSON.parse(fs.readFileSync(path)).state;
 assert.equal(state(),'idle');
 handlers.get('agent_start')({},ctx); assert.equal(state(),'working');
 const pending=ctx.ui.confirm('approve','continue'); assert.equal(state(),'waiting');
 answer(true); assert.equal(await pending,true); assert.equal(state(),'working');
 handlers.get('tool_execution_end')({isError:true}); assert.equal(state(),'failed');
 handlers.get('agent_settled')(); assert.equal(state(),'failed');
 handlers.get('agent_start')({},ctx); assert.equal(state(),'working');
 handlers.get('agent_settled')(); assert.equal(state(),'idle');
 handlers.get('message_end')({message:{role:'assistant',stopReason:'error'}}); assert.equal(state(),'failed');
 handlers.get('session_shutdown')(); assert.equal(fs.existsSync(path),false);
});

test('desktop pet state priority and unsupported-platform guard', () => {
 assert.equal(petState(true,1,true),'waiting');
 assert.equal(petState(false,0,false),'idle');
 if(!['win32','darwin','linux'].includes(process.platform)) registerDesktopPet({on:()=>assert.fail('must not register on this platform')});
});


test('desktop pet selects native Windows and Qt desktop backends', () => {
 const options={statePath:'/tmp/state with spaces.json',parentPid:42,env:{}};
 const windows=petLaunchCommand({...options,platform:'win32'});
 assert.equal(windows.command,'powershell.exe');
 assert.ok(windows.args.includes(options.statePath));
 const mac=petLaunchCommand({...options,platform:'darwin',env:{AXUM_DESKTOP_PET_PYTHON:'/venv/bin/python'}});
 assert.equal(mac.command,'/venv/bin/python');
 assert.equal(mac.args[1],options.statePath);
 assert.equal(mac.args.at(-1),'42');
 const linux=petLaunchCommand({...options,platform:'linux',env:{DISPLAY:':0',WAYLAND_DISPLAY:'wayland-0'}});
 assert.equal(linux.env.QT_QPA_PLATFORM,'xcb');
 assert.equal(linux.command,'python3');
 assert.equal(petLaunchCommand({...options,platform:'linux'}),undefined);
 assert.equal(petLaunchCommand({...options,platform:'linux',env:{WAYLAND_DISPLAY:'wayland-0'}}),undefined);
 assert.equal(petLaunchCommand({...options,platform:'android'}),undefined);
 assert.equal(petLaunchCommand({...options,platform:'darwin',env:{AXUM_DESKTOP_PET:'0'}}),undefined);
});
