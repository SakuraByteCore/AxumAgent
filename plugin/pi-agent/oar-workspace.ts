import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// This is a bounded file snapshot, NOT an OS sandbox. Callers must stop native
// processes before integration and hold WriteScopeLocks through integration.
// Node has no portable openat/renameat API: hostile concurrent host filesystem
// mutation is not supported. All paths are rechecked before each replacement.
const MAX_FILES = 20000, MAX_BYTES = 128 * 1024 * 1024;
const excluded = (name: string) => /^(?:\.git|node_modules|\.env(?:\..*)?|\.codex|\.claude|\.pi|\.mcp\.json|\.ssh|\.aws|\.azure|\.config|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(?:\.json)?|auth\.json|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(name);
type Entry = { data: Buffer; mode: number };
type Tree = Map<string, Entry>;
function canonical(path: string): string {
 if (!path || /^[a-z]:/i.test(path) || isAbsolute(path) || path.includes('\\') || path.includes('\0') || ['*', '?', '[', ']'].some(c => path.includes(c)) || path.split('/').some(p => !p || p === '.' || p === '..' || excluded(p)))
  throw new Error('Invalid or protected writeScope path: ' + path);
 return path;
}
async function checked(root: string, path: string): Promise<void> {
 const rootStat = await fs.lstat(root);
 if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe workspace root');
 const parts = path.split('/');
 for (let i = 0; i < parts.length; i++) {
  try {
   const s = await fs.lstat(join(root, ...parts.slice(0, i + 1)));
   if (s.isSymbolicLink() || (!s.isDirectory() && (i < parts.length - 1 || !s.isFile())) || (s.isFile() && s.nlink !== 1)) throw new Error('Unsupported linked/special path: ' + path);
  } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
 }
}
async function readEntry(root: string, path: string): Promise<Entry | undefined> {
 await checked(root, path);
 let handle;
 try {
  handle = await fs.open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  const s = await handle.stat();
  if (!s.isFile() || s.nlink !== 1 || s.size > MAX_BYTES) throw new Error('Unsupported file: ' + path);
  const data = await handle.readFile();
  if (data.length > MAX_BYTES) throw new Error('Workspace file too large');
  return { data, mode: s.mode & 0o777 };
 } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
 finally { await handle?.close(); }
}
async function scan(root: string, input: boolean): Promise<Tree> {
 const tree: Tree = new Map(); let bytes = 0, count = 0;
 async function visit(dir: string) {
  for (const name of (await fs.readdir(join(root, dir))).sort()) {
   if (input && excluded(name)) continue;
   const path = dir ? dir + '/' + name : name;
   canonical(path);
   if (++count > MAX_FILES) throw new Error('Workspace entry limit exceeded');
   if (!input && excluded(name)) throw new Error('Protected workspace output: ' + path);
   await checked(root, path);
   const stat = await fs.lstat(join(root, path));
   if (stat.isDirectory()) await visit(path);
   else {
    const entry = await readEntry(root, path);
    if (!entry) throw new Error('Workspace changed during scan');
    bytes += entry.data.length;
    if (bytes > MAX_BYTES) throw new Error('Workspace byte limit exceeded');
    tree.set(path, entry);
   }
  }
 }
 await checked(root, ''); await visit(''); return tree;
}
function same(a?: Entry, b?: Entry) { return !a || !b ? a === b : a.mode === b.mode && a.data.equals(b.data); }

/** Undefined/empty writeScope is read-only; directory scopes include descendants.
 * Scopes are literal canonical relative paths (no globs, dot segments or secrets).
 * Snapshot includes safe regular project files, including uncommitted inputs.
 * No git metadata, dependencies, credential directories or linked files are read.
 * Empty directories are not part of the file diff. Directory/file replacement
 * is unsupported; arbitrary secrets embedded in normal source cannot be detected.
 * Validation is all-or-nothing; application uses atomic per-file renames, not a
 * multi-file transaction (I/O failure can leave already-applied files in place).
 */
export async function prepareOarWorkspace(cwd: string, writeScope: string[] = []): Promise<{ cwd: string; integrate(): Promise<{ changedFiles: string[]; patch?: string }>; dispose(): Promise<void> }> {
 const root = resolve(cwd);
 if (await fs.realpath(root) !== root) throw new Error('Workspace root must be canonical and not linked');
 const scopes = writeScope.map(canonical);
 for (const scope of scopes) await checked(root, scope);
 const baseline = await scan(root, true);
 const temp = await fs.mkdtemp(join(tmpdir(), 'axum-oar-workspace-'));
 let disposed = false, integrated = false, busy = false;
 try {
  for (const [path, entry] of baseline) {
   await fs.mkdir(dirname(join(temp, path)), { recursive: true });
   await fs.writeFile(join(temp, path), entry.data, { mode: entry.mode });
   await fs.chmod(join(temp, path), entry.mode);
  }
 } catch (e) { await fs.rm(temp, { recursive: true, force: true }); throw e; }
 return {
  cwd: temp,
  async integrate() {
   if (disposed || integrated || busy) throw new Error('Workspace is disposed, integrated or busy');
   busy = true;
   try {
    const output = await scan(temp, false);
    const changedFiles = [...new Set([...baseline.keys(), ...output.keys()])].filter(p => !same(baseline.get(p), output.get(p))).sort();
    // Validate the COMPLETE diff and every conflict before touching parent files.
    for (const path of changedFiles) {
     if (!scopes.some(scope => path === scope || path.startsWith(scope + '/'))) throw new Error('Outside writeScope: ' + path);
     if (!same(baseline.get(path), await readEntry(root, path))) throw new Error('Parent conflict: ' + path);
    }
    for (const path of changedFiles) {
     await checked(root, path);
     if (!same(baseline.get(path), await readEntry(root, path))) throw new Error('Parent conflict: ' + path);
     const target = join(root, path), entry = output.get(path);
     if (!entry) { await fs.unlink(target); continue; }
     await fs.mkdir(dirname(target), { recursive: true });
     await checked(root, path);
     const staging = await fs.mkdtemp(join(dirname(target), '.oar-integrate-'));
     try {
      const staged = join(staging, 'file');
      await fs.writeFile(staged, entry.data, { flag: 'wx', mode: entry.mode });
      await fs.chmod(staged, entry.mode);
      await checked(root, path);
      if (!same(baseline.get(path), await readEntry(root, path))) throw new Error('Parent conflict: ' + path);
      await fs.rename(staged, target);
     } finally { await fs.rm(staging, { recursive: true, force: true }); }
    }
    integrated = true;
    return { changedFiles };
   } finally { busy = false; }
  },
  async dispose() {
   if (busy) throw new Error('Workspace integration in progress');
   if (!disposed) { await fs.rm(temp, { recursive: true, force: true }); disposed = true; }
  },
 };
}
