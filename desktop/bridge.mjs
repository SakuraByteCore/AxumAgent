import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolvePiWebBin } from '../src/pi-web-chat.js';

// 父进程通过 stdin 保持所有权；stdout 仅输出就绪协议，日志走 stderr。
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
const preload = new URL('../src/pi-web-fast-loader.js', import.meta.url).href;
const child = spawn(process.execPath, [resolvePiWebBin(), '--hostname', '127.0.0.1', '--port', String(port), '--no-open'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stdio: ['ignore', 'pipe', 'inherit'],
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(' ') },
});
let stopping = false;
let announced = false;
let pending = '';
const startupTimeoutMs = 60000;
const timer = setTimeout(() => {
  console.error('聊天服务启动超过 60000ms');
  shutdown(1);
}, startupTimeoutMs);
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  if (!child.pid) { process.exitCode = code; return; }
  // Windows 信号不会可靠传递到孙进程，只终止此桥创建的 PID 树。
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'inherit' });
  killer.on('error', error => { console.error(error); process.exitCode = 1; });
  killer.on('exit', result => { process.exitCode = result === 0 ? code : 1; process.stdin.destroy(); });
}
child.on('error', error => {
  console.error(error);
  clearTimeout(timer);
  process.stdin.destroy();
  process.exitCode = 1;
});
child.stdout.on('data', chunk => {
  process.stderr.write(chunk);
  pending = (pending + chunk.toString()).slice(-8192);
  if (!announced && pending.includes('Ready')) {
    announced = true;
    clearTimeout(timer);
    process.stdout.write(JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${port}` }) + '\n');
  }
});
child.on('exit', code => {
  clearTimeout(timer);
  if (!stopping) {
    console.error(`聊天服务退出：${code}`);
    process.exitCode = code || 1;
    process.stdin.destroy();
  }
});
process.stdin.resume();
process.stdin.on('end', () => shutdown());
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
