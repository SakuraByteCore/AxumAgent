import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { registerDesktopPet, petLaunchCommand } from '../plugin/pi-agent/desktop-pet.ts';

// No process/IPC mocks: extension producers launch the shipping Windows consumer.
test('native desktop pet session reentry isolates late dialogs and removes state', {
 skip: process.platform !== 'win32' || process.env.AXUM_DESKTOP_PET === '0', timeout: 20000,
}, async () => {
 const before = new Set(fs.readdirSync(os.tmpdir()));
 const handlers = new Map();
 const warnings = [];
 const answers = [];
 const original = () => new Promise(resolve => answers.push(resolve));
 const ctx = { hasUI: true, ui: { notify: message => warnings.push(message),
  confirm: original, select: async () => '', input: async () => '' } };
 registerDesktopPet({ on: (name, fn) => handlers.set(name, fn) });
 const emit = (name, event = {}) => handlers.get(name)(event, ctx);
 const statePath = () => {
  const dirs = fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('axum-pet-') && !before.has(name));
  assert.equal(dirs.length, 1);
  return path.join(os.tmpdir(), dirs[0], 'state.json');
 };
 const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
 try {
  emit('session_start');
  const oldPath = statePath();
  const oldAnswer = ctx.ui.confirm();
  assert.equal(JSON.parse(fs.readFileSync(oldPath)).state, 'waiting');
  emit('session_start');
  assert.equal(fs.existsSync(oldPath), false);
  const file = statePath();
  const state = () => JSON.parse(fs.readFileSync(file)).state;
  emit('agent_start');
  emit('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'thinking_delta' } });
  assert.equal(state(), 'thinking');
  const newAnswer = ctx.ui.confirm();
  answers.shift()(true); await oldAnswer;
  assert.equal(state(), 'waiting');
  answers.shift()(false); await newAnswer;
  assert.equal(state(), 'thinking');
  emit('message_update', { message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta' } });
  assert.equal(state(), 'replying');
  emit('tool_execution_start'); assert.equal(state(), 'working');
  await wait(2200); // Let the actual PowerShell/WPF consumer initialize.
  assert.deepEqual(warnings, []);
  for (const [name, data, expected] of [
   ['tool_execution_end', { isError: true }, 'failed'],
   ['agent_settled', {}, 'failed'], ['agent_start', {}, 'working'], ['agent_settled', {}, 'idle'],
  ]) {
   emit(name, data); assert.equal(state(), expected); await wait(150);
  }
  const pending = ctx.ui.confirm();
  emit('session_shutdown');
  answers.shift()(true); await pending;
  assert.equal(fs.existsSync(file), false);
  assert.equal(ctx.ui.confirm, original);
  await wait(200);
  assert.deepEqual(warnings, []);
  emit('session_start'); const replaced = statePath();
  handlers.get('session_start')({}, { hasUI: false });
  assert.equal(fs.existsSync(replaced), false);
  assert.equal(ctx.ui.confirm, original);
 } finally { emit('session_shutdown'); }
});

test('shipping WPF exits on parent death without state-file removal', {
 skip: process.platform !== 'win32', timeout: 15000,
}, async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-parent-test-'));
 const statePath = path.join(directory, 'state.json');
 fs.writeFileSync(statePath, '{"state":"idle"}');
 const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
 const launch = petLaunchCommand({ platform: process.platform, env: { ...process.env, AXUM_DESKTOP_PET: '1' }, statePath, parentPid: parent.pid });
 const child = spawn(launch.command, launch.args, { windowsHide: true });
 let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
 const exited = once(child, 'exit');
 try {
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(child.exitCode, null, errors);
  parent.kill();
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.equal(fs.existsSync(statePath), true);
 } finally { parent.kill(); child.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
});
