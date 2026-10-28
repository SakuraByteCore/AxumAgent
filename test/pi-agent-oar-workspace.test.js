import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOarWorkspace } from '../plugin/pi-agent/oar-workspace.ts';
async function fixture(t) {
 const root = await fs.mkdtemp(join(tmpdir(), 'oar-workspace-test-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 await fs.writeFile(join(root, 'a'), 'uncommitted');
 await fs.writeFile(join(root, 'b'), 'original');
 return root;
}
async function workspace(t, root, scope) {
 const w = await prepareOarWorkspace(root, scope); t.after(() => w.dispose()); return w;
}
test('independent snapshot merges modified, added, deleted files and modes', async t => {
 const root = await fixture(t), w = await workspace(t, root, ['a', 'b', 'new']);
 assert.equal(await fs.readFile(join(w.cwd, 'a'), 'utf8'), 'uncommitted');
 await fs.writeFile(join(w.cwd, 'a'), 'edited');
 assert.equal(await fs.readFile(join(root, 'a'), 'utf8'), 'uncommitted');
 await fs.chmod(join(w.cwd, 'a'), 0o755);
 await fs.unlink(join(w.cwd, 'b'));
 await fs.mkdir(join(w.cwd, 'new')); await fs.writeFile(join(w.cwd, 'new/file'), 'new');
 assert.deepEqual((await w.integrate()).changedFiles, ['a', 'b', 'new/file']);
 assert.equal(await fs.readFile(join(root, 'a'), 'utf8'), 'edited');
 assert.equal((await fs.stat(join(root, 'a'))).mode & 0o777, 0o755);
 await assert.rejects(fs.stat(join(root, 'b')), { code: 'ENOENT' });
 assert.equal(await fs.readFile(join(root, 'new/file'), 'utf8'), 'new');
});
test('read-only and complete outside-scope rejection before any parent writes', async t => {
 const root = await fixture(t);
 for (const scope of [undefined, [], ['a']]) {
  const w = await workspace(t, root, scope);
  await fs.writeFile(join(w.cwd, 'a'), 'edited'); await fs.writeFile(join(w.cwd, 'b'), 'escape');
  await assert.rejects(w.integrate(), /Outside writeScope/);
  assert.equal(await fs.readFile(join(root, 'a'), 'utf8'), 'uncommitted');
 }
});
test('parent edit/add/delete conflicts are never overwritten, complete diff preflight', async t => {
 for (const mutation of ['edit', 'add', 'delete']) {
  const root = await fixture(t), w = await workspace(t, root, ['a', 'b', 'c']);
  await fs.writeFile(join(w.cwd, 'a'), 'candidate');
  if (mutation === 'edit') { await fs.writeFile(join(root, 'b'), 'parent'); await fs.writeFile(join(w.cwd, 'b'), 'child'); }
  if (mutation === 'add') { await fs.writeFile(join(root, 'c'), 'parent'); await fs.writeFile(join(w.cwd, 'c'), 'child'); }
  if (mutation === 'delete') { await fs.unlink(join(root, 'b')); await fs.writeFile(join(w.cwd, 'b'), 'child'); }
  await assert.rejects(w.integrate(), /Parent conflict/);
  assert.equal(await fs.readFile(join(root, 'a'), 'utf8'), 'uncommitted');
 }
});
test('canonical scopes reject escapes, credentials, glob and ambiguous paths', async t => {
 const root = await fixture(t);
 for (const scope of ['../a', '/tmp/a', '.', 'a/../b', 'a//b', 'a/', '.env', '.codex/x', 'x/*.js', 'x?y', 'x[y]', 'a\\b'])
  await assert.rejects(prepareOarWorkspace(root, [scope]), /Invalid/);
});
test('credentials and dependency links excluded without following; ordinary symlinks and hardlinks rejected', async t => {
 const root = await fixture(t), outside = await fs.mkdtemp(join(tmpdir(), 'oar-private-'));
 t.after(() => fs.rm(outside, { recursive: true, force: true }));
 await fs.writeFile(join(outside, 'token'), 'PRIVATE');
 for (const name of ['.git', '.codex', '.claude', 'node_modules']) await fs.symlink(outside, join(root, name));
 await fs.writeFile(join(root, '.env'), 'PRIVATE');
 const w = await workspace(t, root, ['a']);
 assert.deepEqual((await fs.readdir(w.cwd)).sort(), ['a', 'b']);
 await fs.symlink(outside, join(root, 'ordinary'));
 await assert.rejects(prepareOarWorkspace(root), /linked/);
 await fs.unlink(join(root, 'ordinary'));
 await fs.link(join(outside, 'token'), join(root, 'hard'));
 await assert.rejects(prepareOarWorkspace(root), /linked/);
});
test('output links and substituted parent ancestor rejected without outside writes', async t => {
 const root = await fixture(t), w = await workspace(t, root, ['dir']);
 await fs.mkdir(join(w.cwd, 'dir')); await fs.writeFile(join(w.cwd, 'dir/file'), 'child');
 await fs.symlink(w.cwd, join(root, 'dir'));
 await assert.rejects(w.integrate(), /linked/);
 await fs.unlink(join(root, 'dir')); await fs.symlink(root, join(w.cwd, 'link'));
 await assert.rejects(w.integrate(), /linked/);
});
test('disjoint concurrent merges preserve sibling and unrelated parent changes', async t => {
 const root = await fixture(t), a = await workspace(t, root, ['a']), b = await workspace(t, root, ['b']);
 await fs.writeFile(join(a.cwd, 'a'), 'A'); await fs.writeFile(join(b.cwd, 'b'), 'B');
 await fs.writeFile(join(root, 'unrelated'), 'parent');
 await Promise.all([a.integrate(), b.integrate()]);
 assert.equal(await fs.readFile(join(root, 'a'), 'utf8'), 'A');
 assert.equal(await fs.readFile(join(root, 'b'), 'utf8'), 'B');
 assert.equal(await fs.readFile(join(root, 'unrelated'), 'utf8'), 'parent');
});
test('dispose idempotent and integration unavailable afterwards', async t => {
 const root = await fixture(t), w = await workspace(t, root);
 await w.dispose(); await w.dispose();
 await assert.rejects(fs.stat(w.cwd), { code: 'ENOENT' });
 await assert.rejects(w.integrate(), /disposed/);
});

test('host agent and MCP configuration never enters a snapshot',async t=>{
 const root=await fixture(t);
 await fs.mkdir(join(root,'.pi'));await fs.writeFile(join(root,'.pi','settings.json'),'private-config');
 await fs.writeFile(join(root,'.mcp.json'),'private-mcp');
 const w=await workspace(t,root,['a']);
 await assert.rejects(fs.stat(join(w.cwd,'.pi')),{code:'ENOENT'});
 await assert.rejects(fs.stat(join(w.cwd,'.mcp.json')),{code:'ENOENT'});
});
