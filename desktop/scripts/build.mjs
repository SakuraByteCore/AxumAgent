import { mkdir, readFile, writeFile, access, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const desktop = fileURLToPath(new URL('../', import.meta.url));
const revision = 'c18c0df0f0129d5d91c676472468d51f78984a72';
// goproxy.io Origin.Hash 与 GitHub commit SHA/日期交叉核对，见 resolve 阶段证据。
const version = 'v0.7.4-0.20261029055629-c18c0df0f012';
const go = path.join(desktop, '.tools', 'go', 'bin', 'go.exe');
const cache = path.join(desktop, '.cache');
const env = { ...process.env, GOTOOLCHAIN: 'local', GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0', GOPATH: path.join(cache, 'gopath'), GOMODCACHE: path.join(cache, 'gomod'), GOCACHE: path.join(cache, 'gobuild'), GOPROXY: process.env.GOPROXY || 'direct', GOSUMDB: 'sum.golang.org', GOINSECURE: '' };
const direct = env.GOPROXY === 'direct';
const stage = `canonical-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const evidencePath = path.join(cache, `${stage}.json`);
const logPath = path.join(cache, `${stage}.log`);
const started = Date.now();
const budget = 280000;
const evidence = { started: new Date().toISOString(), revision, version, probes: [], proxy: env.GOPROXY, logPath };
try {
  await access(go);
  await mkdir(cache, { recursive: true });
  const probe = async url => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      evidence.probes.push({ url, status: response.status, body: body.slice(0, 1600) });
      return response.status === 200;
    } catch (error) {
      evidence.probes.push({ url, error: String(error), cause: String(error.cause) });
      return false;
    } finally {
      await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    }
  };
  if (direct && !await probe('https://github.com/egoist/mygo.git/info/refs?service=git-upload-pack')) {
    throw new Error(`GitHub direct HTTPS 预检失败；查看 ${evidencePath}；未执行依赖安装`);
  }
  if (!direct) {
    const proxy = new URL(env.GOPROXY);
    if (proxy.protocol !== 'https:') throw new Error('显式代理必须使用 HTTPS；未执行依赖安装');
    if (!await probe(`${proxy.href.replace(/\/$/, '')}/github.com/egoist/mygo/@v/${version}.info`)) {
      throw new Error(`固定 canonical 代理 HTTPS 预检未返回 200；查看 ${evidencePath}；未执行依赖安装`);
    }
    env.GOSUMDB = 'sum.golang.org https://sum.golang.google.cn';
    if (!await probe('https://sum.golang.google.cn/latest')) throw new Error('官方校验镜像预检失败；未执行依赖安装');
  } else if (!await probe('https://sum.golang.org/latest')) {
    if (!await probe('https://sum.golang.google.cn/latest')) {
      throw new Error(`官方校验服务及官方镜像预检失败；查看 ${evidencePath}`);
    }
    env.GOSUMDB = 'sum.golang.org https://sum.golang.google.cn';
  }
  evidence.sumdb = env.GOSUMDB;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  const log = await open(logPath, 'wx');
  try {
    const run = args => {
      const timeout = Math.min(240000, budget - (Date.now() - started));
      if (timeout <= 0) throw new Error('构建总预算 280 秒耗尽');
      console.log(`go ${args.join(' ')}`);
      const result = spawnSync(go, args, { cwd: desktop, env, stdio: ['ignore', log.fd, log.fd], timeout });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`go ${args.join(' ')} 退出 ${result.status}；查看 ${logPath}`);
    };
    run(['help', 'build']);
    run(['help', 'mod']);
    run(['help', 'get']);
    run(['help', 'fmt']);
    run(['version']);
    run(['fmt', './...']);
    run(['get', `github.com/egoist/mygo@${version}`]);
    run(['mod', 'tidy']);
    await mkdir(path.join(desktop, 'dist'), { recursive: true });
    run(['build', '-trimpath', '-o', 'dist/axum-desktop.exe', '.']);
    const binary = await readFile(path.join(desktop, 'dist', 'axum-desktop.exe'));
    const pe = binary.readUInt32LE(60);
    if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('PE AMD64 头校验失败');
    const sha256 = createHash('sha256').update(binary).digest('hex');
    await writeFile(path.join(desktop, 'dist', 'axum-desktop.exe.sha256'), `${sha256}  axum-desktop.exe\n`);
    evidence.artifact = { bytes: binary.length, sha256, pe: 'AMD64' };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    console.log(`构建成功：${binary.length} 字节；SHA256 ${sha256}`);
  } finally { await log.close(); }
} catch (error) {
  evidence.error = String(error);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.error(error);
  process.exitCode = 1;
}
