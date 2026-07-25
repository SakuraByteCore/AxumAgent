import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fetchOpenAICompatibleModels, getDefaultProviderSelection, listProviders, providerNameFromBaseUrl, saveDefaultProviderSelection, upsertOpenAICompatibleProvider } from "./provider-config.js";
import { diffSystemPromptFile, readSystemPromptFile, saveSystemPromptFile } from "./system-prompt-config.js";

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
:root{color-scheme:light dark;--bg:#f6f7fb;--bg2:#eef2f8;--bg3:#fff;--grid:rgba(99,102,241,.12);--orbA:rgba(109,93,252,.28);--orbB:rgba(14,165,233,.18);--orbC:rgba(168,85,247,.14);--panel:rgba(255,255,255,.94);--panel2:#f8fafc;--text:#111827;--muted:#5f6b7a;--line:#d8e0ea;--accent:#6d5dfc;--accentText:#fff;--ok:#15803d;--err:#dc2626;--badgeBg:#eef2ff;--badgeText:#4f46e5;--badgeLine:#c7d2fe;--inputBg:#fff;--inputText:#111827;--shadow:#0f172a24;--statusOkBg:#ecfdf3;--statusOkText:#166534;--statusOkLine:#bbf7d0;--statusErrBg:#fef2f2;--statusErrText:#991b1b;--statusErrLine:#fecaca;--warn:#a16207;--warnBg:#fef9c3}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 12%,var(--bg2) 0,transparent 34%),radial-gradient(circle at 84% 18%,var(--orbB) 0,transparent 28%),linear-gradient(135deg,var(--bg) 0,var(--bg3) 100%);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center;padding:28px;position:relative;overflow-x:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:42px 42px;mask-image:radial-gradient(circle at center,#000 0,rgba(0,0,0,.7) 42%,transparent 78%);opacity:.55}body:after{content:"";position:fixed;width:720px;height:520px;left:50%;top:50%;transform:translate(-50%,-50%);pointer-events:none;background:radial-gradient(circle at 30% 34%,var(--orbA) 0,transparent 38%),radial-gradient(circle at 70% 64%,var(--orbC) 0,transparent 42%);filter:blur(20px);opacity:.9}.shell{width:min(980px,100%);display:grid;grid-template-columns:1fr 300px;background:var(--panel);border:1px solid var(--line);border-radius:22px;box-shadow:0 30px 100px var(--shadow),0 0 0 1px rgba(255,255,255,.34) inset;overflow:hidden;position:relative;z-index:1}.shell:before{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(135deg,rgba(255,255,255,.22),transparent 34%,rgba(109,93,252,.08));opacity:.8}.main{padding:30px;position:relative;z-index:1}.side{background:var(--panel2);border-left:1px solid var(--line);padding:28px;position:relative;z-index:1}h1{font-size:24px;margin:0 0 8px;letter-spacing:-.03em}p{color:var(--muted);margin:0}.badge{display:inline-block;background:var(--badgeBg);color:var(--badgeText);border:1px solid var(--badgeLine);border-radius:999px;padding:4px 9px;font-size:12px;margin-bottom:14px}.divider{height:1px;background:var(--line);margin:20px 0}.field{display:grid;gap:7px;margin:14px 0}.field label{font-weight:700;color:var(--text)}.field input,.field select{width:100%;height:44px;border-radius:11px;border:1px solid var(--line);background:var(--inputBg);color:var(--inputText);padding:0 13px;outline:none}.field input:focus,.field select:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}.row{display:flex;gap:10px;align-items:center}.secret-row{display:grid;grid-template-columns:1fr 46px;gap:8px}.eye{height:44px;border-radius:11px;border:1px solid var(--line);background:var(--panel2);color:var(--text);cursor:pointer;font-size:18px}.btn{height:42px;border:0;border-radius:11px;background:var(--accent);color:var(--accentText);font-weight:800;padding:0 16px;cursor:pointer}.btn.secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}.btn.ok{background:var(--ok);color:white;width:100%}.btn:disabled{opacity:.55;cursor:not-allowed}.hint{font-size:12px;color:var(--muted)}.status{border-radius:13px;padding:13px;margin-top:14px;display:none}.status.ok{display:block;border:1px solid var(--statusOkLine);background:var(--statusOkBg);color:var(--statusOkText)}.status.err{display:block;border:1px solid var(--statusErrLine);background:var(--statusErrBg);color:var(--statusErrText)}.step{display:flex;gap:10px;margin:15px 0;color:var(--muted)}.step i{width:22px;height:22px;border-radius:50%;background:var(--line);display:grid;place-items:center;font-style:normal;font-size:12px}.step.done i{background:var(--ok);color:white}.step.err i{background:var(--err);color:white}.manual{display:none}.manual.show{display:grid}.tabs{display:flex;gap:8px;margin:20px 0 4px}.tab{height:38px;border-radius:999px;border:1px solid var(--line);background:var(--panel2);color:var(--text);font-weight:800;padding:0 14px;cursor:pointer}.tab.active{background:var(--accent);border-color:var(--accent);color:var(--accentText)}.tab-panel{display:none}.tab-panel.active{display:block}.footer{color:var(--muted);font-size:12px;margin-top:18px}.secret-note{color:var(--warn);background:var(--warnBg);border-radius:10px;padding:8px 10px;font-size:12px;margin-top:8px}.prompt-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}.prompt-editor{width:100%;min-height:180px;resize:vertical;border-radius:12px;border:1px solid var(--line);background:var(--inputBg);color:var(--inputText);padding:12px;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}.prompt-editor:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}.path-box{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px;overflow-wrap:anywhere}.diff{display:none;white-space:pre-wrap;max-height:260px;overflow:auto;border-radius:12px;border:1px solid var(--line);background:var(--panel2);padding:12px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.diff.show{display:block}.diff .add{color:var(--ok)}.diff .del{color:var(--err)}.diff .meta{color:var(--muted)}@media(prefers-color-scheme:dark){:root{--bg:#070a12;--bg2:#111a2f;--bg3:#080b10;--grid:rgba(124,92,255,.16);--orbA:rgba(124,92,255,.24);--orbB:rgba(34,211,238,.11);--orbC:rgba(99,102,241,.18);--panel:rgba(18,24,36,.96);--panel2:rgba(13,18,26,.92);--text:#eef2f7;--muted:#8b95a7;--line:#2b364b;--accent:#7c5cff;--badgeBg:#162236;--badgeText:#93c5fd;--badgeLine:#28446b;--inputBg:#0b0f16;--inputText:#eef2f7;--shadow:#0009;--statusOkBg:#0d2117;--statusOkText:#bbf7d0;--statusOkLine:#205c38;--statusErrBg:#251111;--statusErrText:#fecaca;--statusErrLine:#6b2a2a;--warn:#fbbf24;--warnBg:transparent}.shell{box-shadow:0 30px 110px var(--shadow),0 0 0 1px rgba(124,92,255,.12) inset}.shell:before{background:linear-gradient(135deg,rgba(255,255,255,.06),transparent 34%,rgba(124,92,255,.1))}}@media(max-width:760px){body{padding:18px}.shell{grid-template-columns:1fr}.side{border-left:0;border-top:1px solid var(--line)}.prompt-row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><section class="main"><span class="badge">OpenAI-compatible only</span><h1>添加模型提供商</h1><p>填写服务地址和 Key，或编辑 Pi 原生 System Prompt 文件。</p><div class="tabs"><button class="tab active" id="providerTab" type="button">Provider</button><button class="tab" id="promptTab" type="button">System Prompt</button></div><div class="divider"></div><div class="tab-panel active" id="providerPanel"><div class="field"><label>服务地址</label><input id="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off"></div><div class="field"><label>API Key</label><div class="secret-row"><input id="apiKey" type="password" placeholder="sk-..." autocomplete="off"><button class="eye" id="toggleKey" type="button" aria-label="API Key 表示切替">👁</button></div><div class="secret-note">Key 将保存到本机 Axum/Pi 配置文件，请不要在共享机器上使用别人的账号。</div></div><div class="row"><button class="btn" id="fetchModels">获取模型</button><button class="btn secondary" id="manualBtn" type="button">手动输入</button></div><div class="field"><label>模型</label><select id="model"><option value="">先获取模型列表</option></select></div><div class="field manual" id="manualWrap"><label>手动模型名</label><input id="manualModel" placeholder="model-id"></div><div class="field"><label>Provider 名称</label><input id="providerName" placeholder="自动生成，可选" autocomplete="off"><span class="hint">留空时根据服务地址自动生成。</span></div><button class="btn ok" id="save">保存为默认配置</button><div id="status" class="status"></div></div><div class="tab-panel" id="promptPanel"><h2 style="margin:0 0 8px;font-size:18px">System Prompt</h2><p>编辑 Pi 原生 prompt 文件。默认全局追加：<code>~/.pi/agent/APPEND_SYSTEM.md</code>。</p><div class="prompt-row"><div class="field"><label>范围</label><select id="promptScope"><option value="global" selected>Global (~/.pi/agent)</option><option value="project">Project (./.pi)</option></select></div><div class="field"><label>文件</label><select id="promptMode"><option value="append" selected>APPEND_SYSTEM.md（追加，推荐）</option><option value="system">SYSTEM.md（替换默认 prompt）</option></select></div></div><div class="path-box" id="promptPath">等待载入</div><div class="field"><label>内容</label><textarea class="prompt-editor" id="promptContent" placeholder="写入要追加或替换的 system prompt..."></textarea><span class="hint" id="promptHint">SYSTEM.md 会替换 Pi 默认 system prompt；APPEND_SYSTEM.md 只追加。</span></div><div class="row"><button class="btn secondary" id="previewPromptDiff" type="button">预览 diff</button><button class="btn" id="reloadPrompt" type="button">重新加载</button><button class="btn ok" id="savePrompt" type="button" style="width:auto">保存 prompt 文件</button></div><pre class="diff" id="promptDiff"></pre><div id="promptStatus" class="status"></div></div></section><aside class="side"><h2 style="margin:0 0 8px;font-size:18px">状态</h2><div class="step" id="s1"><i>1</i><span>等待填写地址和 Key</span></div><div class="step" id="s2"><i>2</i><span>等待获取模型列表</span></div><div class="step" id="s3"><i>3</i><span>等待保存</span></div><p class="footer">保存成功后可以关闭此页面。Axum 之后默认使用刚保存的 provider 和 model。</p></aside></main><script>const token=${JSON.stringify(token)};const $=id=>document.getElementById(id);let promptBaseHash="";let promptLoaded=false;function esc(v){return String(v).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}function setStatus(type,msg){const el=$('status');el.className='status '+type;el.textContent=msg}function setPromptStatus(type,msg){const el=$('promptStatus');el.className='status '+type;el.textContent=msg}function step(id,state,text){const el=$(id);el.className='step '+(state||'');el.querySelector('span').textContent=text}function selectedModel(){return $('manualWrap').classList.contains('show')?$('manualModel').value.trim():$('model').value.trim()}function fillProvider(p,model){$('providerName').value=p.id;$('baseUrl').value=p.baseUrl||'';$('model').innerHTML=(p.models||[]).map(m=>'<option value="'+esc(m)+'"'+(m===model?' selected':'')+'>'+esc(m)+'</option>').join('')||'<option value="'+esc(model||'')+'">'+esc(model||'')+'</option>';$('apiKey').value=p.apiKey||'';$('apiKey').placeholder='sk-...';step('s1','done','已载入现有 provider');step('s2','done','已载入已保存模型');step('s3','','可直接保存或修改');setStatus('ok','已载入现有配置。API Key 默认密文显示，点击小眼睛可查看明文。')}async function loadExisting(){try{const r=await fetch('/api/config?token='+encodeURIComponent(token));const j=await r.json();if(!r.ok)throw new Error(j.error||'读取配置失败');const p=j.providers.find(x=>x.id===j.defaultProvider)||j.providers[0];if(p)fillProvider(p,j.defaultModel||p.models?.[0]);}catch(e){setStatus('err',e.message)}}function promptQuery(){return 'scope='+encodeURIComponent($('promptScope').value)+'&mode='+encodeURIComponent($('promptMode').value)}function renderDiff(text){$('promptDiff').innerHTML=String(text).split('\\n').map(line=>'<span class="'+(line.startsWith('+')?'add':line.startsWith('-')?'del':line.startsWith('@')?'meta':'')+'">'+esc(line)+'</span>').join('\\n');$('promptDiff').classList.add('show')}async function loadSystemPrompt(){try{const r=await fetch('/api/system-prompt?token='+encodeURIComponent(token)+'&'+promptQuery());const j=await r.json();if(!r.ok)throw new Error(j.error||'读取 prompt 失败');promptLoaded=true;promptBaseHash=j.hash;$('promptPath').textContent=(j.exists?'已存在: ':'新文件: ')+j.path;$('promptContent').value=j.content||'';$('promptDiff').classList.remove('show');setPromptStatus('ok',(j.mode==='system'?'正在编辑 SYSTEM.md：会替换默认 system prompt':'正在编辑 APPEND_SYSTEM.md：会追加到默认 system prompt'));}catch(e){setPromptStatus('err',e.message)}}async function previewSystemPromptDiff(){try{const r=await fetch('/api/system-prompt/diff?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:$('promptScope').value,mode:$('promptMode').value,content:$('promptContent').value,baseHash:promptBaseHash})});const j=await r.json();if(!r.ok)throw new Error(j.error||'生成 diff 失败');renderDiff(j.diff);setPromptStatus('ok','Diff 已生成，保存前请确认。');}catch(e){setPromptStatus('err',e.message)}}async function saveSystemPrompt(){try{if(!$('promptContent').value.trim()){setPromptStatus('err','System prompt 不能为空');return}await previewSystemPromptDiff();const r=await fetch('/api/system-prompt/save?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:$('promptScope').value,mode:$('promptMode').value,content:$('promptContent').value,baseHash:promptBaseHash})});const j=await r.json();if(!r.ok)throw new Error(j.error||'保存 prompt 失败');promptLoaded=true;promptBaseHash=j.hash;$('promptPath').textContent='已保存: '+j.path;setPromptStatus('ok','Prompt 文件已保存。下次 axum code 会按 Pi 原生规则加载。');}catch(e){setPromptStatus('err',e.message)}}function activateTab(name){const prompt=name==='prompt';$('providerTab').classList.toggle('active',!prompt);$('promptTab').classList.toggle('active',prompt);$('providerPanel').classList.toggle('active',!prompt);$('promptPanel').classList.toggle('active',prompt);if(prompt&&!promptLoaded)loadSystemPrompt()}$('providerTab').onclick=()=>activateTab('provider');$('promptTab').onclick=()=>activateTab('prompt');$('toggleKey').onclick=()=>{$('apiKey').type=$('apiKey').type==='password'?'text':'password';$('toggleKey').textContent=$('apiKey').type==='password'?'👁':'🙈'};$('manualBtn').onclick=()=>{$('manualWrap').classList.toggle('show')};$('baseUrl').addEventListener('change',()=>{try{const u=new URL($('baseUrl').value.trim()); if(!$('providerName').value) $('providerName').value=u.hostname.replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()}catch{}});$('promptScope').onchange=loadSystemPrompt;$('promptMode').onchange=loadSystemPrompt;$('reloadPrompt').onclick=loadSystemPrompt;$('previewPromptDiff').onclick=previewSystemPromptDiff;$('savePrompt').onclick=saveSystemPrompt;$('fetchModels').onclick=async()=>{setStatus('', '');step('s1','done','地址和 Key 已填写');step('s2','','正在获取模型列表');$('fetchModels').disabled=true;try{const r=await fetch('/api/models?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:$('baseUrl').value,apiKey:$('apiKey').value.trim()})});const j=await r.json();if(!r.ok)throw new Error(j.error||'获取失败');$('model').innerHTML=j.models.map(m=>'<option value="'+esc(m)+'">'+esc(m)+'</option>').join('');step('s2','done','已获取 '+j.models.length+' 个模型');step('s3','','选择模型后保存');setStatus('ok','模型列表已更新');}catch(e){step('s2','err','获取模型失败，可手动输入');setStatus('err',e.message);$('manualWrap').classList.add('show')}finally{$('fetchModels').disabled=false}};$('save').onclick=async()=>{const model=selectedModel();if(!model){setStatus('err','请选择或手动输入模型');return}if(!$('apiKey').value.trim()){setStatus('err','API Key 不能为空');return}$('save').disabled=true;try{const r=await fetch('/api/save?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl:$('baseUrl').value,apiKey:$('apiKey').value.trim(),model,name:$('providerName').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'保存失败');step('s3','done','已保存为默认配置');$('apiKey').type='password';$('toggleKey').textContent='👁';setStatus('ok','保存成功，可以关闭此页面。')}catch(e){step('s3','err','保存失败');setStatus('err',e.message)}finally{$('save').disabled=false}};loadExisting();loadSystemPrompt();</script></body></html>`;
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
      if (req.method === "GET" && url.pathname === "/api/config") {
        const defaults = getDefaultProviderSelection() || {};
        const providers = listProviders(undefined, { includeSecrets: true });
        return json(res, 200, { providers, defaultProvider: defaults.provider, defaultModel: defaults.model });
      }
      if (req.method === "GET" && url.pathname === "/api/system-prompt") {
        const prompt = readSystemPromptFile({ scope: url.searchParams.get("scope") || "global", mode: url.searchParams.get("mode") || "append", cwd: options.cwd, env: process.env });
        return json(res, 200, prompt);
      }
      if (req.method === "POST" && url.pathname === "/api/system-prompt/diff") {
        const body = await readJson(req);
        const prompt = diffSystemPromptFile({ scope: body.scope || "global", mode: body.mode || "append", content: body.content || "", cwd: options.cwd, env: process.env });
        return json(res, 200, prompt);
      }
      if (req.method === "POST" && url.pathname === "/api/system-prompt/save") {
        const body = await readJson(req);
        const prompt = saveSystemPromptFile({ scope: body.scope || "global", mode: body.mode || "append", content: body.content || "", baseHash: body.baseHash, cwd: options.cwd, env: process.env });
        return json(res, 200, prompt);
      }
      if (req.method === "POST" && url.pathname === "/api/models") {
        const body = await readJson(req);
        if (!String(body.apiKey || "").trim()) throw new Error("API Key is required");
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
