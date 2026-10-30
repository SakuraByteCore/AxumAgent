import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const revision = 'c18c0df0f0129d5d91c676472468d51f78984a72';
const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
const stage = `resolve-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(cache, { recursive: true });
const requests = [
  ['cn-full', `https://goproxy.cn/github.com/egoist/mygo/@v/${revision}.info`],
  ['github-commit', `https://api.github.com/repos/egoist/mygo/commits/${revision}`],
  ['cn-short', `https://goproxy.cn/github.com/egoist/mygo/@v/${revision.slice(0, 12)}.info`],
  ['io-full', `https://goproxy.io/github.com/egoist/mygo/@v/${revision}.info`],
];
const results = await Promise.all(requests.map(async ([name, url]) => {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'mygo-dependency-diagnostic', Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.text();
    const result = { name, url, status: response.status };
    if (name === 'github-commit') {
      if (response.ok) {
        const data = JSON.parse(body);
        result.sha = data.sha;
        result.commit = { author: { date: data.commit.author.date }, committer: { date: data.commit.committer.date } };
      } else result.body = body.slice(0, 1600);
    } else {
      result.bodyFile = path.join(cache, `${stage}-${name}.txt`);
      await writeFile(result.bodyFile, body, { flag: 'wx' });
      result.preview = body.slice(0, 1600);
      if (response.ok) result.metadata = JSON.parse(body);
    }
    return result;
  } catch (error) {
    return { name, url, error: String(error), cause: String(error.cause) };
  }
}));
const evidence = { revision, stage, results };
const evidencePath = path.join(cache, `${stage}.json`);
await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ evidencePath, ...evidence }, null, 2));
