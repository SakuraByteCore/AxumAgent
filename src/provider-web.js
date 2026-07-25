import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fetchOpenAICompatibleModels, providerNameFromBaseUrl, saveDefaultProviderSelection, upsertOpenAICompatibleProvider } from "./provider-config.js";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  return JSON.parse(body);
}

export function openBrowser(url, { platform = process.platform, env = process.env } = {}) {
  if (env.AXUM_PROVIDER_WEB_NO_OPEN === "1") return false;

  const candidates = [];
  if (platform === "android" || env.TERMUX_VERSION || env.PREFIX?.includes("/com.termux/")) {
    candidates.push(["termux-open-url", [url]]);
  }
  if (platform === "darwin") candidates.push(["open", [url]]);
  else if (platform === "win32") candidates.push(["cmd", ["/c", "start", "", url]]);
  else candidates.push(["xdg-open", [url]]);

  for (const [command, args] of candidates) {
    if (!commandAvailable(command, platform)) continue;
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
      return true;
    } catch {
      // Try the next platform opener.
    }
  }
  return false;
}

function commandAvailable(command, platform) {
  if (platform === "win32" && command === "cmd") return true;
  const result = spawnSync("command", ["-v", command], { shell: true, stdio: "ignore" });
  return result.status === 0;
}

function page(token) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Axum Provider Setup</title><style>
:root{--bg:#080b10;--panel:#121824;--panel2:#0d121a;--text:#eef2f7;--muted:#8b95a7;--line:#2b364b;--accent:#7c5cff;--ok:#16a34a;--err:#ef4444}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#1e2a45 0,#0c1017 38%,#080b10 100%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:28px}.shell{width:min(980px,100%);display:grid;grid-template-columns:1fr 300px;background:rgba(18,24,36,.96);border:1px solid var(--line);border-radius:22px;box-shadow:0 30px 100px #0009;overflow:hidden}.main{padding:30px}.side{background:#0d121a;border-left:1px solid #283248;padding:28px}h1{font-size:24px;margin:0 0 8px;letter-spacing:-.03em}p{color:var(--muted);margin:0}.badge{display:inline-block;background:#162236;color:#93c5fd;border:1px solid #28446b;border-radius:999px;padding:4px 9px;font-size:12px;margin-bottom:14px}.divider{height:1px;background:#2b3548;margin:20px 0}.field{display:grid;gap:7px;margin:14px 0}.field label{font-weight:700;color:#dbe4f0}.field input,.field select{width:100%;height:44px;border-radius:11px;border:1px solid #303b50;background:#0b0f16;color:var(--text);padding:0 13px;outline:none}.row{display:flex;gap:10px;align-items:center}.btn{height:42px;border:0;border-radius:11px;background:var(--accent);color:white;font-weight:800;padding:0 16px;cursor:pointer}.btn.secondary{background:#1c2534;color:#dbe4f0;border:1px solid #344057}.btn.ok{background:var(--ok);width:100%}.btn:disabled{opacity:.55;cursor:not-allowed}.hint{font-size:12px;color:var(--muted)}.status{border-radius:13px;padding:13px;margin-top:14px;display:none}.status.ok{display:block;border:1px solid #205c38;background:#0d2117;color:#bbf7d0}.status.err{display:block;border:1px solid #6b2a2a;background:#251111;color:#fecaca}.step{display:flex;gap:10px;margin:15px 0;color:#aeb9cc}.step i{width:22px;height:22px;border-radius:50%;background:#263147;display:grid;place-items:center;font-style:normal;font-size:12px}.step.done i{background:#16a34a;color:white}.step.err i{background:#ef4444;color:white}.manual{display:none}.manual.show{display:grid}.footer{color:#8e99aa;font-size:12px;margin-top:18px}.secret-note{color:#fbbf24;font-size:12px;margin-top:8px}@media(max-width:760px){.shell{grid-template-columns:1fr}.side{border-left:0;border-top:1px solid #283248}}
</style></head><body><main class="shell"><section class="main"><span class="badge">OpenAI-compatible only</span><h1>添加模型提供商</h1><p>填写服务地址和 Key，Axum 会读取模型列表，保存后设为默认配置。页面不会显示命令。</p><div class="divider"></div><div class="field"><label>服务地址</label><input id="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off"></div><div class="field"><label>API Key</label><input id="apiKey" type="password" placeholder="sk-..." autocomplete="off"><div class="secret-note">Key 将保存到本机 Axum/Pi 配置文件，请不要在共享机器上使用别人的账号。</div></div><div class="row"><button class="btn" id="fetchModels">获取模型</button><button class="btn secondary" id="manualBtn" type="button">手动输入</button></div><div class="field"><label>模型</label><select id="model"><option value="">先获取模型列表</option></select></div><div class="field manual" id="manualWrap"><label>手动模型名</label><input id="manualModel" placeholder="model-id"></div><div class="field"><label>Provider 名称</label><input id="providerName" placeholder="自动生成，可选" autocomplete="off"><span class="hint">留空时根据服务地址自动生成。</span></div><button class="btn ok" id="save">保存为默认配置</button><div id="status" class="status"></div></section><aside class="side"><h2 style="margin:0 0 8px;font-size:18px">状态</h2><div class="step" id="s1"><i>1</i><span>等待填写地址和 Key</span></div><div class="step" id="s2"><i>2</i><span>等待获取模型列表</span></div><div class="step" id="s3"><i>3</i><span>等待保存</span></div><p class="footer">保存成功后可以关闭此页面。Axum 之后默认使用刚保存的 provider 和 model。</p></aside></main><script>
const token=${JSON.stringify(token)};const $=id=>document.getElementById(id);function setStatus(type,msg){const el=$('status');el.className='status '+type;el.textContent=msg}function step(id,state,text){const el=$(id);el.className='step '+(state||'');el.querySelector('span').textContent=text}function selectedModel(){return $('manualWrap').classList.contains('show')?$('manualModel').value.trim():$('model').value.trim()}$('manualBtn').onclick=()=>{$('manualWrap').classList.toggle('show')};$('baseUrl').addEventListener('change',()=>{try{const u=new URL($('baseUrl').value.trim()); if(!$('providerName').value) $('providerName').value=u.hostname.replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()}catch{}});$('fetchModels').onclick=async()=>{setStatus('', '');step('s1','done','地址和 Key 已填写');step('s2','','正在获取模型列表');$('fetchModels').disabled=true;try{const r=await fetch('/api/models?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:$('baseUrl').value,apiKey:$('apiKey').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'获取失败');$('model').innerHTML=j.models.map(m=>'<option value="'+m.replaceAll('&','&amp;').replaceAll('"','&quot;')+'">'+m.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</option>').join('');step('s2','done','已获取 '+j.models.length+' 个模型');step('s3','','选择模型后保存');setStatus('ok','模型列表已更新');}catch(e){step('s2','err','获取模型失败，可手动输入');setStatus('err',e.message);$('manualWrap').classList.add('show')}finally{$('fetchModels').disabled=false}};$('save').onclick=async()=>{const model=selectedModel();if(!model){setStatus('err','请选择或手动输入模型');return}$('save').disabled=true;try{const r=await fetch('/api/save?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:$('baseUrl').value,apiKey:$('apiKey').value,model,name:$('providerName').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'保存失败');step('s3','done','已保存为默认配置');setStatus('ok','保存成功，可以关闭此页面。')}catch(e){step('s3','err','保存失败');setStatus('err',e.message)}finally{$('save').disabled=false}};
</script></body></html>`;
}

export async function startProviderWeb(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 0);
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (url.searchParams.get("token") !== token) return json(res, 403, { error: "invalid token" });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page(token));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/models") {
        const body = await readJson(req);
        const models = await fetchOpenAICompatibleModels({ baseUrl: body.baseUrl, apiKey: body.apiKey });
        return json(res, 200, { models });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        const body = await readJson(req);
        const name = body.name || providerNameFromBaseUrl(body.baseUrl);
        const result = upsertOpenAICompatibleProvider({ name, baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey });
        const defaults = saveDefaultProviderSelection({ provider: result.name, model: body.model });
        return json(res, 200, { ok: true, provider: result.name, model: body.model, modelsPath: result.file, defaultsPath: defaults.file });
      }
      return json(res, 404, { error: "not found" });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`;
  const opened = options.openBrowser === false ? false : openBrowser(url, options);
  if (opened) console.log(`Axum provider setup opened in browser: ${url}`);
  else console.log(`Axum provider setup: ${url}`);
  console.log("Press Ctrl+C when finished.");
  return { server, url, opened };
}
