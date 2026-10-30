import { mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const desktop = fileURLToPath(new URL('../', import.meta.url));
const revision = 'c18c0df0f0129d5d91c676472468d51f78984a72';
const cache = path.join(desktop, '.cache');
const tools = path.join(desktop, '.tools');
const manifestURL = 'https://golang.google.cn/dl/?mode=json';
const evidence = { revision, manifestURL, timestamp: new Date().toISOString() };
await mkdir(cache, { recursive: true });
async function request(url) {
  console.log(`请求 ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'Axum-desktop-prepare' } });
  console.log(`HTTP ${response.status} ${response.url}`);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}
async function source(entry) {
  if (new URL(entry.url).searchParams.get('ref') !== revision) throw new Error(`缓存 revision 不匹配：${entry.path}`);
  const filename = path.join(cache, entry.path.replaceAll('/', '-') + '.source');
  let bytes;
  try { bytes = await readFile(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const blobHash = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (!bytes || blobHash(bytes) !== entry.sha) {
    const data = await (await request(entry.url)).json();
    bytes = Buffer.from(data.content, 'base64');
    if (blobHash(bytes) !== entry.sha) throw new Error(`源码 Git blob 校验失败：${entry.path}`);
    await writeFile(filename, bytes);
  }
  console.log(`固定 revision 缓存已校验：${entry.path} ${entry.sha}`);
  return bytes.toString('utf8');
}
try {
  let root;
  try { root = JSON.parse(await readFile(path.join(cache, 'root.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    root = await (await request(`https://api.github.com/repos/egoist/mygo/contents/?ref=${revision}`)).json();
    await writeFile(path.join(cache, 'root.json'), JSON.stringify(root, null, 2));
  }
  const names = ['go.mod', 'app.go', 'window.go', 'backend_windows.go', 'README.md'];
  const texts = await Promise.all(names.map(name => {
    const entry = root.find(e => e.path === name);
    if (!entry) throw new Error(`固定根目录未发现 ${name}`);
    return source(entry);
  }));
  const required = texts[0].match(/^go (\d+\.\d+\.\d+)$/m)?.[1];
  if (!required) throw new Error('固定 go.mod 缺少可解析版本');
  const localRequired = (await readFile(path.join(desktop, 'go.mod'), 'utf8')).match(/^go (\d+\.\d+\.\d+)$/m)?.[1];
  if (localRequired !== required) throw new Error('本地与固定依赖 Go 版本要求不一致');
  evidence.required = required;
  let raw, previous;
  try {
    previous = JSON.parse(await readFile(path.join(cache, 'go-prepare-evidence.json'), 'utf8'));
    raw = await readFile(path.join(cache, 'go-releases.json'), 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw) {
    if (previous.revision !== revision || createHash('sha256').update(raw).digest('hex') !== previous.manifestSHA256) throw new Error('本地发行清单证据不匹配');
    evidence.manifestSource = 'verified-local-cache';
    evidence.http = previous.http;
  } else {
    const response = await request(manifestURL);
    evidence.http = { status: response.status, url: response.url };
    raw = await response.text();
    await writeFile(path.join(cache, 'go-releases.json'), raw);
  }
  evidence.manifestSHA256 = createHash('sha256').update(raw).digest('hex');
  const releases = JSON.parse(raw);
  const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  evidence.stableVersions = releases.filter(r => r.stable).map(r => r.version);
  const release = releases.filter(r => r.stable && /^go\d+\.\d+\.\d+$/.test(r.version) && compare(r.version.slice(2), required) >= 0).sort((a, b) => compare(a.version.slice(2), b.version.slice(2)))[0];
  if (!release) throw new Error(`官方当前稳定清单没有满足 go ${required} 的工具链`);
  const archive = release.files.find(f => f.os === 'windows' && f.arch === 'amd64' && f.kind === 'archive' && f.filename.endsWith('.zip'));
  if (!archive) throw new Error('所选版本没有 Windows amd64 ZIP');
  evidence.archive = archive;
  const zip = path.join(cache, archive.filename);
  let exists = false;
  try { await stat(zip); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    const download = await request(`https://dl.google.com/go/${archive.filename}`);
    await pipeline(Readable.fromWeb(download.body), createWriteStream(zip));
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(zip)) hash.update(chunk);
  evidence.download = { size: (await stat(zip)).size, sha256: hash.digest('hex'), reused: exists };
  if (evidence.download.size !== archive.size || evidence.download.sha256 !== archive.sha256) throw new Error('Go 压缩包尺寸或 SHA256 不匹配');
  if (exists && previous?.archive && (previous.archive.sha256 !== archive.sha256 || previous.archive.size !== archive.size)) throw new Error('历史 ZIP 证据不匹配');
  console.log(`ZIP 校验成功：${evidence.download.size} 字节；SHA256 ${evidence.download.sha256}；本地复用 ${exists}`);
  await mkdir(tools, { recursive: true });
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead(${quote(zip)}); try { foreach ($entry in $zip.Entries) { $target=[IO.Path]::Combine(${quote(tools)},$entry.FullName); if ($entry.Name -eq '') { [IO.Directory]::CreateDirectory($target) | Out-Null } else { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$target,$true); if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) { throw ('解压长度不符: '+$entry.FullName) } } }; Write-Output ('已解压校验条目: '+$zip.Entries.Count) } finally { $zip.Dispose() }`;
  evidence.extractor = '.NET ZipFile overwrite';
  const extract = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit', timeout: 300000 });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`ZipFile 解压退出 ${extract.status}`);
  evidence.extracted = true;
  const version = spawnSync(path.join(tools, 'go', 'bin', 'go.exe'), ['version'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' }, timeout: 30000 });
  if (version.error) throw version.error;
  if (version.status !== 0 || version.stdout.trim() !== `go version ${release.version} windows/amd64`) throw new Error(`局部 Go 版本验证失败：${version.stdout} ${version.stderr}`);
  evidence.goVersion = version.stdout.trim();
  console.log(evidence.goVersion);
  await writeFile(path.join(tools, 'release.json'), JSON.stringify({ revision, required, ...archive }, null, 2));
  evidence.cleanup = { path: zip, beforeBytes: (await stat(zip)).size, rebuildURL: `https://dl.google.com/go/${archive.filename}` };
  console.log(`清理清单仅一项：${zip}；${evidence.cleanup.beforeBytes} 字节；工具链保留于 ${tools}`);
  await unlink(zip);
  evidence.cleanup.afterBytes = 0;
  console.log(`ZIP 占用：${evidence.cleanup.beforeBytes} -> 0 字节`);
} catch (error) {
  evidence.error = { message: error.message, cause: error.cause && { message: error.cause.message, code: error.cause.code, hostname: error.cause.hostname, host: error.cause.host, port: error.cause.port } };
  console.error(error, error.cause);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(cache, 'go-prepare-evidence.json'), JSON.stringify(evidence, null, 2));
}
