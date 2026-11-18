import { providerWebStyles } from "./provider-web-style.js";
import { readFastModels, saveFastModels } from "./fast-service-tier.js";
import http from "node:http";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { getCommandRetentionSettings, saveCommandRetentionSettings, cloneProvider, deleteProvider, exportProviders, fetchOpenAICompatibleModels, getDefaultProviderSelection, getLanguagePreference, getRetrySettings, getSteeringMode, importProviders, listProviders, readSettingsRaw, saveProviderMaxTokens, saveDefaultProviderSelection, saveLanguagePreference, saveRetrySettings, saveSteeringMode, upsertProvider, getUserAgent, DEFAULT_THINKING_LEVEL, DEFAULT_API_FORM, DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_TOKENS, PROVIDER_PRESETS, API_FORMS } from "./provider-config.js";
import { deleteSystemPromptFile, diffSystemPromptFile, readSystemPromptFile, saveSystemPromptFile } from "./system-prompt-config.js";
import { listSessions, readSession, deleteSession, deleteSessions, deleteAllSessions, exportSessions, importSessions } from "./session-store.js";
import { deleteAllPromptHistory, deleteGlobalPromptHistoryEntry, deletePromptHistoryEntries, exportPromptHistory, importPromptHistory, listPromptHistory, promotePromptHistoryEntry } from "./prompt-history-store.js";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

async function readJson(req) {
  let body = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes <= MAX_JSON_BODY_BYTES) body += chunk;
  }
  if (bytes > MAX_JSON_BODY_BYTES) throw new Error("Request body too large");
  if (!body) return {};
  return JSON.parse(body);
}

const TEST_TIMEOUT_MS = 20000;
const TEST_CONCURRENCY = 3;
const TEST_PROBE_MAX_TOKENS = 1;
const MISSING_CHOICES_DETAIL = "response missing choices array";

async function testModelAvailability(baseUrl, apiKey, model, timeoutMs = TEST_TIMEOUT_MS) {
  const start = Date.now();
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const customUA = getUserAgent();
  if (customUA) headers["User-Agent"] = customUA;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalized}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: TEST_PROBE_MAX_TOKENS, stream: false }),
      signal: controller.signal,
    });
    const latency = Date.now() - start;
    if (res.status < 200 || res.status >= 300) return { model, ok: false, latency, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.choices)) return { model, ok: false, latency, detail: MISSING_CHOICES_DETAIL };
    return { model, ok: true, latency };
  } catch (error) {
    return { model, ok: false, latency: Date.now() - start, detail: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function testModelsBatch(list, baseUrl, apiKey, concurrency = TEST_CONCURRENCY) {
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await testModelAvailability(baseUrl, apiKey, list[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return results;
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

function page(token, presets = PROVIDER_PRESETS, apiForms = API_FORMS) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark"><title>Axum · Workspace</title>
<style>${providerWebStyles}</style></head><body>
<div class="shell">
<aside class="sidebar">
<a class="brand" href="/" aria-label="Axum">
<span class="brand-mark">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="m5 17 7-12 7 12M8 13h8M8 19h8"/>
</svg>
</span>
<span>
<span class="brand-name">Axum</span>
<span class="brand-caption" data-i18n="workspaceCaption">Agent workspace</span>
</span>
</a>
<nav class="sidebar-nav" aria-label="Workspace" data-i18n-aria="workspaceLabel">
<div class="nav-label" data-i18n="workspaceLabel">Workspace</div>
<div class="tabs" role="tablist" aria-orientation="vertical">
<button class="tab" id="providerTab" type="button" role="tab" aria-controls="providerPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<rect x="3" y="3" width="7" height="7" rx="1.5"/>
<rect x="14" y="3" width="7" height="7" rx="1.5"/>
<rect x="3" y="14" width="7" height="7" rx="1.5"/>
<rect x="14" y="14" width="7" height="7" rx="1.5"/>
</svg>
<span data-i18n="tabProvider">Provider</span>
</button>
<button class="tab" id="promptTab" type="button" role="tab" aria-controls="promptPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M8 4H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3M9 8l-2 2 2 2m6-4 2 2-2 2"/>
</svg>
<span data-i18n="tabPrompt">Prompt</span>
</button>
<button class="tab" id="retryTab" type="button" role="tab" aria-controls="retryPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13a9 9 0 0 1-15 6l-3-3M3 21v-5h5"/>
</svg>
<span data-i18n="tabRetry">Retry</span>
</button>
<button class="tab" id="sessionsTab" type="button" role="tab" aria-controls="sessionsPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>
</svg>
<span data-i18n="tabSessions">Sessions</span>
</button>
<button class="tab" id="historyTab" type="button" role="tab" aria-controls="historyPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M3 11a9 9 0 1 1 3 7M3 4v7h7M12 7v5l3 2"/>
</svg>
<span data-i18n="tabHistory">History</span>
</button>
<button class="tab" id="settingsTab" type="button" role="tab" aria-controls="settingsPanel" aria-selected="false" tabindex="-1">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M8 3H5v18h14V3h-3M9 3h6v4H9zM8 12h8M8 16h5"/>
</svg>
<span data-i18n="tabSettings">Settings</span>
</button>
</div>
</nav>
<aside class="side">
<h2 data-i18n="status">ステータス</h2>
<div class="step" id="s1">
<i>1</i>
<span data-i18n="step1">URL とキーを入力</span>
</div>
<div class="step" id="s2">
<i>2</i>
<span data-i18n="step2">モデル取得</span>
</div>
<div class="step" id="s3">
<i>3</i>
<span data-i18n="step3">保存</span>
</div>
<p class="footer">
<span data-i18n="footer">保存後ページを閉じてください。</span>
</p>
</aside>
<div class="sidebar-footer">
<span class="local-state" data-i18n="localWorkspace">Local workspace</span>
<div class="sidebar-controls">
<select id="langSelect" aria-label="Language" data-i18n-aria="languageLabel">
<option value="en">English</option>
<option value="ja">日本語</option>
<option value="zh">中文</option>
</select>
<select id="themeSelect" aria-label="Appearance" data-i18n-aria="themeLabel">
<option value="system" data-i18n="themeSystem">System</option>
<option value="light" data-i18n="themeLight">Light</option>
<option value="dark" data-i18n="themeDark">Dark</option>
</select>
</div>
</div>
</aside>
<main class="main" id="mainContent">
<header class="topbar">
<div class="breadcrumb">
<span data-i18n="workspaceLabel">Workspace</span>
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="m9 5 7 7-7 7"/>
</svg>
<strong id="breadcrumbTitle" data-i18n="tabProvider">Provider</strong>
</div>
<span class="local-state" data-i18n="localWorkspace">Local workspace</span>
</header>
<div class="content">
<header class="page-heading">
<h1 id="pageTitle" data-i18n="tabProvider">Provider</h1>
<p id="pageDescription" data-i18n="providerDescription">Connect providers, choose models and set your workspace default.</p>
</header>
<section class="tab-panel" id="providerPanel" role="tabpanel" aria-labelledby="providerTab" tabindex="0">
<div class="provider-list-wrap">
<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 8px">
<h2 class="sect-title" style="margin:0" data-i18n="savedProviders">saved</h2>
<button class="test-btn" id="newProvider" type="button" data-i18n="provNew">New provider</button>
</div>
<div class="provider-list" id="providersList">
</div>
</div>
<section class="form-section">
<div class="section-heading">
<h2 data-i18n="connectionTitle">Connection</h2>
<p data-i18n="connectionDescription">Choose a preset or enter your endpoint.</p>
</div>
<div class="preset-row">
<span class="preset-label" data-i18n="presetLabel">Presets</span>${presets.map((p)=>'<button class="preset-btn" id="preset-'+p.id+'" type="button" data-i18n="'+p.labelKey+'">'+p.id+'</button>').join('')}</div>
<div class="connection-grid">
<div class="field">
<label for="apiShape" data-i18n="apiShapeLabel">API form</label>
<select id="apiShape">
<option value="openai-completions" data-i18n="apiShapeOpenAI">OpenAI compatible</option>
<option value="anthropic-messages" data-i18n="apiShapeAnthropic">Anthropic Messages</option>
<option value="openai-responses" data-i18n="apiShapeOpenAIResponses">OpenAI Responses</option>
</select>
<span class="hint" id="apiShapeHint">
</span>
</div>
<div class="field">
<label for="baseUrl" data-i18n="serviceUrl">サービス URL</label>
<input type="url" spellcheck="false" autocapitalize="none" id="baseUrl" placeholder="https://api.example.com/v1" data-i18n-ph="serviceUrlPlaceholder" autocomplete="off">
</div>
<div class="field full">
<label for="apiKey" data-i18n="apiKey">API キー</label>
<div class="secret-row">
<input spellcheck="false" autocapitalize="none" id="apiKey" type="password" placeholder="sk-..." autocomplete="off">
<button class="eye" id="toggleKey" aria-pressed="false" type="button" aria-label="API キー表示切替" data-i18n-aria="toggleKey">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/>
<circle cx="12" cy="12" r="3"/>
</svg>
</button>
</div>
<div class="secret-note" data-i18n="apiKeyNote">API キーはローカル設定ファイルに保存されます。</div>
</div>
</div>
</section>
<section class="form-section">
<div class="section-heading">
<h2 data-i18n="modelsTitle">Models</h2>
<p data-i18n="modelsDescription">Add models, then choose the default and reasoning level.</p>
</div>
<div class="field">
<label for="model" data-i18n="model">モデル</label>
<div class="combo" id="modelCombo">
<input id="model" placeholder="モデル名を入力または選択" data-i18n-ph="modelInputPlaceholder" autocomplete="off" aria-expanded="false" aria-autocomplete="list" aria-controls="modelDropdown" role="combobox">
<button class="combo-fetch" id="addModel" type="button" aria-label="Add model" data-i18n-aria="addModelLabel">＋</button>
<div class="combo-dropdown" id="modelDropdown" role="listbox" hidden>
</div>
</div>
<div class="model-list" id="modelList">
</div>
<span class="hint" id="modelHint">
</span>
</div>
<div class="field" style="gap:8px">
<div class="test-row">
<span class="test-sum" id="modelTestHint">
</span>
<button class="test-btn" id="testModels" type="button" data-i18n="testModels">テスト</button>
</div>
<div class="test-list" id="modelTestList">
</div>
</div>
</section>
<section class="form-section">
<div class="section-heading">
<h2 data-i18n="preferencesTitle">Preferences</h2>
</div>
<div class="field">
<label for="providerName" data-i18n="providerName">プロバイダー名</label>
<input id="providerName" placeholder="自動生成、任意" data-i18n-ph="providerNamePlaceholder" autocomplete="off">
<span class="hint" data-i18n="autoGenHint">空欄で自動生成します。</span>
</div>
<div class="field">
<label for="fastMode" style="display:flex;align-items:center;gap:8px">
<input type="checkbox" id="fastMode" style="width:auto;height:auto">
<span data-i18n="fastMode">Fast service tier</span>
</label>
<span class="hint" data-i18n="fastModeHint">Send service_tier: fast for these OpenAI models in Web chat.</span>
</div>
</section>
<div class="action-bar">
<div class="row">
<button class="btn secondary" id="exportProviders" type="button" data-i18n="exportProviders">プロバイダーをエクスポート</button>
<button class="btn secondary" id="importProviders" type="button" data-i18n="importProviders">プロバイダーをインポート</button>
<span class="hint" id="exportSessionsHint">
</span>
<input type="file" id="importFile" accept=".json,application/json" hidden>
</div>
<button class="btn ok" id="save" data-i18n="saveAsDefault">デフォルト設定として保存</button>
</div>
<div id="status" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="tab-panel" id="promptPanel" role="tabpanel" aria-labelledby="promptTab" tabindex="0">
<h2 data-i18n="systemPromptTitle">システムプロンプト</h2>
<p>
<span data-i18n="promptEditDesc">Pi プロンプトファイルを編集します。デフォルト：</span>
<code>~/.pi/agent/SYSTEM.md</code>。</p>
<div class="prompt-row">
<div class="field">
<label for="promptScope" data-i18n="scope">スコープ</label>
<select id="promptScope">
<option value="global" selected data-i18n="scopeGlobal">グローバル (~/.pi/agent)</option>
<option value="project" data-i18n="scopeProject">プロジェクト (./.pi)</option>
</select>
</div>
<div class="field">
<label for="promptMode" data-i18n="file">ファイル</label>
<select id="promptMode">
<option value="append" data-i18n="modeAppend">APPEND_SYSTEM.md（追記、推奨）</option>
<option value="system" selected data-i18n="modeSystem">SYSTEM.md（デフォルトプロンプト置換）</option>
<option value="plan" data-i18n="modePlan">plan-prompt.md（/plan テンプレート）</option>
</select>
</div>
</div>
<div class="path-box" id="promptPath">読み込み待機中</div>
<div class="field">
<label for="promptContent" data-i18n="content">内容</label>
<textarea class="prompt-editor" id="promptContent" placeholder="追記または置換するシステムプロンプトを入力..." data-i18n-ph="contentPlaceholder">
</textarea>
<span class="hint" id="promptHint" data-i18n="promptHint">SYSTEM.md は置換、APPEND_SYSTEM.md は追記。</span>
</div>
<div class="row">
<button class="btn ok" id="savePrompt" type="button" style="width:auto" data-i18n="savePrompt">プロンプトファイルを保存</button>
<button class="diff-toggle" id="diffToggle" type="button" data-i18n="showDiff">差分を表示</button>
<button class="btn secondary" id="planReset" type="button" style="width:auto;display:none" data-i18n="planReset">内蔵テンプレートに戻す</button>
</div>
<div class="diff-viewer" id="promptDiff">
<pre id="promptDiffPre">
</pre>
</div>
<div id="promptStatus" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="tab-panel" id="retryPanel" role="tabpanel" aria-labelledby="retryTab" tabindex="0">
<section class="form-section">
<h2 data-i18n="retryTitle">リクエストリトライ</h2>
<p>
<span data-i18n="retryDesc">Pi API リクエストのリトライ戦略を設定します。</span>
<code>~/.pi/agent/settings.json</code>
<span data-i18n="retryDestSuffix"> に保存されます。</span>
</p>
<div class="field">
<label data-i18n="retryEnabled">リトライ有効化</label>
<label style="font-weight:400;display:flex;align-items:center;gap:8px">
<input type="checkbox" id="retryEnabled">
<span data-i18n="retryEnabledDesc">Retry failed requests automatically.</span>
</label>
</div>
<div class="provider-row">
<div class="field">
<label for="retryMax" data-i18n="maxRetryCount">最大リトライ回数</label>
<input id="retryMax" inputmode="numeric" placeholder="3" autocomplete="off">
<span class="hint" data-i18n="retryMaxHint">デフォルト 3。</span>
</div>
<div class="field">
<label for="retryDelay" data-i18n="baseDelay">基底バックオフ遅延 (ms)</label>
<input id="retryDelay" inputmode="numeric" placeholder="2000" autocomplete="off">
<span class="hint" data-i18n="retryDelayHint">デフォルト 2000。</span>
</div>
<div class="field">
<label for="retryFixedDelay" data-i18n="fixedDelay">固定リトライ遅延 (ms)</label>
<input id="retryFixedDelay" inputmode="numeric" placeholder="3000" autocomplete="off">
<span class="hint" data-i18n="retryFixedDelayHint">デフォルト 3000。429 または接続リトライの固定間隔。</span>
</div>
</div>
<button class="btn ok" id="saveRetry" type="button" data-i18n="saveRetry">リトライ設定を保存</button>
<div id="retryStatus" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="form-section">
<h2 data-i18n="steeringTitle">Steering mode</h2>
<p>
<span data-i18n="steeringDesc">Agent 実行中に入力を割り込ませる場合の処理方法を設定します。</span>
<code>settings.json</code>
<span data-i18n="steeringDestSuffix"> に保存されます。</span>
</p>
<div class="field">
<label for="steeringMode" data-i18n="steeringMode">Steering mode</label>
<select id="steeringMode">
<option value="one-at-a-time" data-i18n="steeringOneAtATime">One at a time</option>
<option value="all" data-i18n="steeringAll">All</option>
</select>
<span class="hint" data-i18n="steeringHint">one-at-a-time: 起動中のトークに 1 件ずつ割り込む。all: 起動中のトークにまとめて割り込む。次回 Pi セッション開始時に反映されます。</span>
</div>
<button class="btn ok" id="saveSteering" type="button" data-i18n="saveSteering">Steering 設定を保存</button>
<div id="steeringStatus" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="form-section">
<h2 data-i18n="commandLifecycle">Command lifecycle</h2>
<div class="field">
<label>
<input type="checkbox" id="retainCommands" style="width:auto;height:auto;margin-right:8px">
<span data-i18n="retainCommandsLabel">Retain temporary commands after completion</span>
</label>
<p class="hint" data-i18n="retainCommandsHint">Keep temporary commands available after their agents finish.</p>
</div>
<div class="row">
<button class="btn secondary" id="saveCommands" data-i18n="saveCommandsLabel">Save command settings</button>
<div id="commandsStatus" class="status" role="status" aria-live="polite"></div>
</div>
</section>
</section>
<section class="tab-panel" id="sessionsPanel" role="tabpanel" aria-labelledby="sessionsTab" tabindex="0">
<div class="sess-head">
<h2 data-i18n="sessionsTitle">セッション</h2>
<button class="btn danger sess-del-selected" id="sessDeleteSelected" type="button" disabled data-i18n="sessDeleteSelectedZero">選択を削除</button>
<button class="btn danger sess-del-all" id="sessDeleteAll" type="button" data-i18n="sessDeleteAll">すべて削除</button>
</div>
<p data-i18n="sessionsDesc">Pi の会話履歴を管理します。</p>
<div class="sess-toolbar">
<input class="sess-search" id="sessSearch" type="search" autocomplete="off" placeholder="検索..." data-i18n-ph="sessSearchPlaceholder">
<button class="sess-refresh" id="sessSelectAll" type="button" data-i18n="sessSelectAll">すべて選択</button>
<button class="sess-refresh" id="sessClearSelection" type="button" data-i18n="sessClearSelection">選択解除</button>
<button class="sess-refresh" id="sessRefresh" type="button" data-i18n="sessRefresh">更新</button>
<span class="sess-count" id="sessCount">
</span>
<span class="sess-sel-count" id="sessSelCount">
</span>
</div>
<div id="sessionsTree" style="margin-top:12px">
</div>
<div id="sessionsDetail" style="display:none;margin-top:4px">
</div>
<div id="sessionsStatus" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="tab-panel" id="historyPanel" role="tabpanel" aria-labelledby="historyTab" tabindex="0">
<div class="sess-head">
<h2 data-i18n="historyTitle">プロンプト履歴</h2>
<button class="btn danger sess-del-selected" id="histDeleteSelected" type="button" disabled data-i18n="sessDeleteSelectedZero">選択を削除</button>
<button class="btn danger sess-del-all" id="histDeleteAll" type="button" data-i18n="histDeleteAll">すべて削除</button>
</div>
<p data-i18n="historyDesc">Pi のプロンプト入力履歴を管理します。</p>
<div class="sess-toolbar">
<input class="sess-search" id="histSearch" type="search" autocomplete="off" placeholder="検索..." data-i18n-ph="histSearchPlaceholder">
<button class="sess-refresh" id="histSelectAll" type="button" data-i18n="sessSelectAll">すべて選択</button>
<button class="sess-refresh" id="histClearSelection" type="button" data-i18n="sessClearSelection">選択解除</button>
<button class="sess-refresh" id="histRefresh" type="button" data-i18n="sessRefresh">更新</button>
<span class="sess-count" id="histCount">
</span>
<span class="sess-sel-count" id="histSelCount">
</span>
</div>
<div id="histTree" style="margin-top:12px">
</div>
<div id="historyStatus" class="status" role="status" aria-live="polite">
</div>
</section>
<section class="tab-panel" id="settingsPanel" role="tabpanel" aria-labelledby="settingsTab" tabindex="0">
<h2 data-i18n="settingsTitle">settings.json（読み取り専用）</h2>
<p>
<span data-i18n="settingsIntro">
</span>
<code>~/.pi/agent/settings.json</code>
<span data-i18n="settingsReadonly">
</span>
</p>
<div class="readonly-intro" data-i18n="settingsWarning">
</div>
<div class="path-box" id="settingsPath">読み込み待機中</div>
<div class="field">
<label data-i18n="settingsContent">
</label>
<div id="settingsContent" class="readonly-viewer empty" tabindex="0">
</div>
<span class="hint" id="settingsHint">
</span>
</div>
</section>
</div>
</main>
</div>
<div class="modal-overlay" id="confirmModal" hidden>
<div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalBody">
<div class="modal-icon" id="modalIcon">
</div>
<h3 class="modal-title" id="modalTitle">
</h3>
<p class="modal-body" id="modalBody">
</p>
<div class="modal-actions">
<button class="btn secondary" id="modalCancel" type="button" data-i18n="modalCancel">キャンセル</button>
<button class="btn danger" id="modalConfirm" type="button" data-i18n="modalConfirm">削除</button>
</div>
</div>
</div><script>const token=${JSON.stringify(token)};function apiFetch(url,options={}){const headers=new Headers(options.headers);headers.set('x-axum-token',token);return fetch(url,{...options,headers})}const PRESETS=${JSON.stringify(presets)};const API_FORMS=${JSON.stringify(apiForms)};const DEFAULT_API_FORM=${JSON.stringify(DEFAULT_API_FORM)};const DEFAULTS=${JSON.stringify({maxTokens:DEFAULT_MODEL_MAX_TOKENS})};let currentLang='en';const I18N={"en":{"fastMode":"Fast service tier","fastModeHint":"Web chat: send service_tier: fast for these OpenAI models. Off by default.","compatOnly":"OpenAI compatible only","addProviderTitle":"Add Model Provider","setupDesc":"Configure provider or system prompt.","tabProvider":"Provider","tabPrompt":"System Prompt","tabRetry":"Runtime","serviceUrl":"Service URL","serviceUrlPlaceholder":"https://api.example.com/v1","apiKey":"API Key","toggleKey":"Toggle API Key visibility","apiKeyNote":"API key is stored in local config file.","model":"Model","providerName":"Provider name","providerNamePlaceholder":"Auto-generated, optional","autoGenHint":"Leave blank for auto-generation.","maxOutputTokens":"Max output tokens","maxTokensHint":"Saved automatically. Applies to the next request in running code sessions.","providerTokensSaved":"Output limit saved. Applies to the next request.","reasoningStrength":"Reasoning strength","reasoningOff":"Off","reasoningMinimal":"Minimal","reasoningLow":"Low","reasoningMedium":"Medium","reasoningHigh":"High","reasoningXhigh":"Extra high","reasoningMax":"Max","exportProviders":"Export providers","importProviders":"Import providers","savedProviders":"Saved Providers","presetLabel":"Presets","presetAnthropic":"Anthropic","presetOpenAIChat":"OpenAI Chat","presetOpenAIResponses":"OpenAI Responses","presetApplied":"Preset applied — enter your API key, then pick a model","apiShapeLabel":"API form","apiShapeOpenAI":"OpenAI compatible","apiShapeAnthropic":"Anthropic Messages (native)","apiShapeOpenAIResponses":"OpenAI Responses","apiShapeNoFetch":"This API form has no model list endpoint — pick a preset suggestion or enter the model ID manually.","provNew":"New provider","provClone":"Clone","cloneFailed":"Failed to clone provider","providerCloned":"Cloned as {name} — edit and save","newProviderHint":"Blank form ready: enter URL, key and models, then save.","provSetDefault":"Set Default","provDelete":"Delete","provDeleteConfirm":"Delete provider {name}? Its record is removed from models.json.","providerDeleted":"Provider {name} deleted.","defaultSetOk":"Default provider updated.","defaultSetFailed":"Failed to update default provider.","deleteFailed":"Failed to delete provider.","modelsCount":"models","saveAsDefault":"Save as default","systemPromptTitle":"System Prompt","promptEditDesc":"Edit Pi prompt file. Default:","scope":"Scope","scopeGlobal":"Global (~/.pi/agent)","scopeProject":"Project (./.pi)","file":"File","modeAppend":"APPEND_SYSTEM.md (append, recommended)","modeSystem":"SYSTEM.md (default prompt replacement)","modePlan":"plan-prompt.md (/plan template)","editPlan":"Editing plan-prompt.md: /plan command template","planHint":"The /plan template must include the {{requirement}} placeholder. A missing file falls back to the built-in template.","planReset":"Restore built-in template","planResetConfirm":"Delete plan-prompt.md to restore the built-in /plan template?","planResetDone":"Restored the built-in /plan template.","planResetFailed":"Failed to restore the built-in template","loadingPrompt":"Waiting to load...","content":"Content","contentPlaceholder":"Enter system prompt to append or replace...","promptHint":"SYSTEM.md replaces, APPEND_SYSTEM.md appends.","savePrompt":"Save Prompt File","retryTitle":"Request Retry","retryDesc":"Configure retry strategy for Pi API requests.","retryDestSuffix":" is stored.","retryEnabled":"Enable retry","retryEnabledDesc":"When enabled, retries automatically on request failure","maxRetryCount":"Max retries","retryMaxHint":"Default 3.","baseDelay":"Base backoff delay (ms)","retryDelayHint":"Default 2000.","fixedDelay":"Fixed retry delay (ms)","retryFixedDelayHint":"Default 3000. Fixed-cadence delay for 429 rate-limit and connection retries.","saveRetry":"Save Retry Settings","status":"Status","step1":"Enter URL and key","step2":"Fetch models","step3":"Save","footer":"Changes apply to your local workspace.","providerLoaded":"Provider loaded","modelsLoaded":"Models loaded","saveOrEdit":"Save or edit available","configLoaded":"Configuration loaded.","configLoadFailed":"Failed to load config","promptLoadFailed":"Failed to load prompt","existingFile":"Existing file: ","newFile":"New file: ","editSystem":"Editing SYSTEM.md: default prompt replacement","editAppend":"Editing APPEND_SYSTEM.md: prompt append","promptEmpty":"System prompt cannot be empty","promptSaveFailed":"Failed to save prompt","savedAs":"Saved: ","promptSaved":"Prompt saved.","retryLoadFailed":"Failed to load retry settings","retryOn":"Retry enabled","retryOff":"Retry disabled","retrySaveFailed":"Failed to save retry settings","retrySavedOn":"Retry enabled and saved.","retrySavedOff":"Retry disabled and saved.","steeringTitle":"Steering mode","steeringDesc":"How queued steering input is handled while the agent is streaming.","steeringDestSuffix":" is stored.","steeringMode":"Steering mode","steeringOneAtATime":"One at a time","steeringAll":"All","steeringHint":"one-at-a-time: interrupt the running turn with each queued message one by one. all: deliver all queued steering messages at once. Applies on the next Pi session start.","saveSteering":"Save Steering Settings","modelsUpdated":"Models updated.","exportFailed":"Export failed","exported":"Providers exported.","importFailed":"Import failed","importOkPrefix":"Import done: added ","importOkMid":" / replaced ","importOkMid2":" / skipped ","importOkSuffix":" / total ","importOkRejected":" / rejected ","importOkDefault":" · default provider restored","modelInputPlaceholder":"Enter or select model","modelRequired":"Please select or manually enter a model","apiKeyRequired":"API key is required","saveFailed":"Save failed","saveAsDefaultDone":"Saved as default","promptSavedOk":"Saved.","tabSessions":"Sessions","sessionsTitle":"Sessions","sessionsDesc":"Manage Pi conversation history.","sessionsLoading":"Loading sessions...","sessionsLoadFailed":"Failed to load sessions","sessionsEmpty":"No sessions found.","sessMsgs":"messages","sessRead":"Read","sessDel":"Delete","sessDeleteConfirm":"Delete this session?","sessDeleteFailed":"Failed to delete session","sessDeleted":"Session deleted.","sessBack":"Back","sessReadFailed":"Failed to read session","sessTruncated":" (truncated)","sessSearchPlaceholder":"Search summary, project or id...","sessRefresh":"Refresh","sessCount":"{shown} of {total}","sessCopy":"Copy","sessCopied":"Copied","sessCopyAll":"Copy transcript","sessLoadMore":"Load more ({n})","sessLoadingDetail":"Loading session...","sessNoMatch":"No sessions match your search.","sessThinking":"Thinking","sessToolUse":"Tool: {name}","sessToolResult":"Tool result","sessNoMessages":"No messages in this session.","fetchModels":"Fetch","fetchModelsTitle":"Fetch models from service","modelsFetching":"Fetching models...","modelsNoMatch":"No matching models","modelsError":"Failed:","modelsEmpty":"No models returned","modelsAutoFetched":"Models fetched","modelsFetchHint":"Enter URL and key, then click Fetch","testModels":"Test availability","testUnsupportedForm":"Real-request availability testing supports the OpenAI-compatible and Responses forms only.","tabSettings":"Settings Preview","settingsTitle":"settings.json (Read-only)","settingsIntro":"Preview Pi settings file. Default location: ","settingsReadonly":" · Read-only","settingsWarning":"Read-only preview. Change values in Providers or Runtime.","settingsContent":"Content","settingsEmpty":"File does not exist or is empty.","settingsSizeHint":"","settingsLoadFailed":"Failed to load settings","settingsNotJson":"File exists but is not valid JSON.","settingsSizeBytes":" bytes","sessDeleteAll":"Delete all","sessDeleteAllConfirm":"Delete ALL session history? This cannot be undone.","sessDeleteAllFailed":"Failed to delete all sessions","sessDeletedAll":"Deleted {n} sessions","modalCancel":"Cancel","modalConfirm":"Delete","showDiff":"Show Diff","hideDiff":"Hide Diff","diffLoading":"Computing diff...","diffNoChanges":"No changes","diffError":"Failed to compute diff","sessSelectAll":"Select all","sessClearSelection":"Clear selection","sessSelCount":"{n} selected","sessDeleteSelected":"Delete selected ({n})","sessDeleteSelectedZero":"Delete selected","sessDeleteBatchConfirm":"Delete {n} selected sessions? This cannot be undone.","sessDeletedBatch":"Deleted {n} sessions","sessDeleteBatchFailed":"{n} failed","exportSessionsHint":"Export includes {n} selected session(s)","importSessionsOk":"sessions: {a} added / {r} replaced / {s} skipped","importSessionsFailed":"{n} sessions failed","tabHistory":"Prompt History","historyTitle":"Prompt History","historyDesc":"Manage the prompt input history Pi saves for the up-arrow editor history. Duplicates are collapsed automatically.","histSearchPlaceholder":"Search prompts or projects...","historyChars":"characters","historyLoading":"Loading prompt history...","historyLoadFailed":"Failed to load prompt history","historyEmpty":"No prompt history found.","historyNoMatch":"No prompts match your search.","histDeleteAll":"Delete all","histDeleteConfirm":"Delete this prompt from history? This cannot be undone.","historyDeleteFailed":"Failed to delete prompt","histDeleted":"Prompt deleted.","histDeletedBatch":"Deleted {n} prompts","histDeleteBatchFailed":"{n} failed","histDeleteBatchConfirm":"Delete {n} selected prompts? This cannot be undone.","histDeleteAllConfirm":"Delete ALL prompt history? This cannot be undone.","histDeleteAllFailed":"Failed to delete all prompt history","histDeletedAll":"Deleted {n} prompts","histDupBadge":"{n} duplicates collapsed","importPromptHistoryOk":"prompt history: {a} added / {r} replaced / {s} skipped","histSelectProject":"Select all","histUnselectProject":"Unselect all","workspaceCaption":"Agent workspace","workspaceLabel":"Workspace","localWorkspace":"Local workspace","languageLabel":"Language","themeLabel":"Appearance","themeSystem":"System","themeLight":"Light","themeDark":"Dark","providerDescription":"Connect providers, choose models and set your workspace default.","promptDescription":"Give your agent the instructions it needs for this workspace.","retryDescription":"Control retries, steering and temporary commands.","sessionsDescription":"Browse, search and manage your conversations.","historyDescription":"Find and reuse previous prompts across your projects.","settingsDescription":"Inspect your current configuration in a read-only view.","connectionTitle":"Connection","connectionDescription":"Choose a preset or enter a compatible API endpoint.","modelsTitle":"Models","modelsDescription":"Add models, then choose the default and reasoning level.","preferencesTitle":"Preferences","addModelLabel":"Add model","commandLifecycle":"Command lifecycle","retainCommandsLabel":"Retain temporary commands after completion","retainCommandsHint":"Keep /blueprint, /spawn and /scout available after agents finish. Turn this off to remove them automatically.","saveCommandsLabel":"Save command settings","commandsSaved":"Command settings saved.","commandsFailed":"Could not save command settings.","providersEmpty":"No providers yet. Add your first connection below."},"ja":{"fastMode":"Fast サービス階層","fastModeHint":"Web チャット：これらの OpenAI モデルに service_tier: fast を送信。初期値はオフ。","compatOnly":"OpenAI 互換のみ","addProviderTitle":"モデルプロバイダーを追加","setupDesc":"プロバイダーまたはシステムプロンプトを設定します。","tabProvider":"プロバイダー","tabPrompt":"システムプロンプト","tabRetry":"実行設定","serviceUrl":"サービス URL","serviceUrlPlaceholder":"https://api.example.com/v1","apiKey":"API キー","toggleKey":"API キー表示切替","apiKeyNote":"API キーはローカル設定ファイルに保存されます。","model":"モデル","providerName":"プロバイダー名","providerNamePlaceholder":"自動生成、任意","autoGenHint":"空欄で自動生成します。","maxOutputTokens":"最大出力トークン","maxTokensHint":"自動保存され、実行中の code セッションの次のリクエストから適用されます。","providerTokensSaved":"出力上限を保存しました。次のリクエストから適用されます。","reasoningStrength":"推理強度","reasoningOff":"オフ","reasoningMinimal":"最小","reasoningLow":"低","reasoningMedium":"中","reasoningHigh":"高","reasoningXhigh":"超高","reasoningMax":"最高","exportProviders":"プロバイダーをエクスポート","importProviders":"プロバイダーをインポート","savedProviders":"保存済みプロバイダー","presetLabel":"プリセット","presetAnthropic":"Anthropic","presetOpenAIChat":"OpenAI Chat","presetOpenAIResponses":"OpenAI Responses","presetApplied":"プリセットを適用しました — API キーを入力し、モデルを選択してください","apiShapeLabel":"API 形式","apiShapeOpenAI":"OpenAI 互換","apiShapeAnthropic":"Anthropic Messages（ネイティブ）","apiShapeOpenAIResponses":"OpenAI Responses","apiShapeNoFetch":"この API 形式にはモデル一覧エンドポイントがありません — プリセット候補から選ぶか、モデル ID を直接入力してください。","provNew":"新規プロバイダー","provClone":"複製","cloneFailed":"プロバイダーの複製に失敗しました","providerCloned":"{name} として複製しました — 編集して保存してください","newProviderHint":"新規入力フォーム：URL・キー・モデルを入力して保存してください。","provSetDefault":"デフォルトに設定","provDelete":"削除","provDeleteConfirm":"プロバイダー {name} を削除しますか？ models.json から削除されます。","providerDeleted":"プロバイダー {name} を削除しました。","defaultSetOk":"デフォルトプロバイダーを更新しました。","defaultSetFailed":"デフォルトプロバイダーの更新に失敗しました。","deleteFailed":"プロバイダーの削除に失敗しました。","modelsCount":"モデル","saveAsDefault":"デフォルト設定として保存","systemPromptTitle":"システムプロンプト","promptEditDesc":"Pi プロンプトファイルを編集します。デフォルト：","scope":"スコープ","scopeGlobal":"グローバル (~/.pi/agent)","scopeProject":"プロジェクト (./.pi)","file":"ファイル","modeAppend":"APPEND_SYSTEM.md（追記、推奨）","modeSystem":"SYSTEM.md（デフォルトプロンプト置換）","modePlan":"plan-prompt.md（/plan テンプレート）","editPlan":"plan-prompt.md を編集：/plan コマンドテンプレート","planHint":"/plan テンプレートには {{requirement}} プレースホルダーが必須です。ファイルがない場合は内蔵テンプレートに戻ります。","planReset":"内蔵テンプレートに戻す","planResetConfirm":"plan-prompt.md を削除して内蔵 /plan テンプレートに戻しますか？","planResetDone":"内蔵テンプレートに戻しました。","planResetFailed":"内蔵テンプレートへの復元に失敗しました","loadingPrompt":"読み込み待機中","content":"内容","contentPlaceholder":"追記または置換するシステムプロンプトを入力...","promptHint":"SYSTEM.md は置換、APPEND_SYSTEM.md は追記。","savePrompt":"プロンプトファイルを保存","retryTitle":"リクエストリトライ","retryDesc":"Pi API リクエストのリトライ戦略を設定します。","retryDestSuffix":" に保存されます。","retryEnabled":"リトライ有効化","retryEnabledDesc":"有効化するとリクエスト失敗時に自動リトライします","maxRetryCount":"最大リトライ回数","retryMaxHint":"デフォルト 3。","baseDelay":"基底バックオフ遅延 (ms)","retryDelayHint":"デフォルト 2000。","fixedDelay":"固定リトライ遅延 (ms)","retryFixedDelayHint":"デフォルト 3000。429 または接続リトライの固定間隔。","saveRetry":"リトライ設定を保存","status":"ステータス","step1":"URL とキーを入力","step2":"モデル取得","step3":"保存","footer":"変更はローカル環境に保存されます。","providerLoaded":"プロバイダー読み込み済み","modelsLoaded":"モデル読み込み済み","saveOrEdit":"保存または編集可能","configLoaded":"設定を読み込みました。","configLoadFailed":"設定読み込みに失敗","promptLoadFailed":"プロンプト読み込みに失敗","existingFile":"既存ファイル: ","newFile":"新規ファイル: ","editSystem":"SYSTEM.md を編集：デフォルトプロンプト置換","editAppend":"APPEND_SYSTEM.md を編集：プロンプト追記","promptEmpty":"システムプロンプトは空にできません","promptSaveFailed":"プロンプト保存に失敗","savedAs":"保存済み: ","promptSaved":"プロンプトを保存しました。","retryLoadFailed":"リトライ設定読み込みに失敗","retryOn":"リトライ有効","retryOff":"リトライ無効","retrySaveFailed":"リトライ設定保存に失敗","retrySavedOn":"リトライを有効化して保存しました","retrySavedOff":"リトライを無効化して保存しました","steeringTitle":"Steering mode","steeringDesc":"Agent 実行中に入力が届いたときの処理方法を設定します。","steeringDestSuffix":" に保存されます。","steeringMode":"Steering mode","steeringOneAtATime":"One at a time","steeringAll":"All","steeringHint":"one-at-a-time: 実行中トークに各メッセージを 1 件ずつ割り込ませる。all: 実行中トークに全 Steering メッセージをまとめて割り込ませる。次回 Pi セッション開始時に反映されます。","saveSteering":"Steering 設定を保存","modelsUpdated":"モデルを更新しました","exportFailed":"エクスポートに失敗","exported":"プロバイダーをエクスポートしました","importFailed":"インポートに失敗","importOkPrefix":"インポート完了: 追加 ","importOkMid":" / 置換 ","importOkMid2":" / スキップ ","importOkSuffix":" / 合計 ","importOkRejected":" / 拒否 ","importOkDefault":" ・デフォルトプロバイダーを復元しました","modelInputPlaceholder":"モデル名を入力または選択","modelRequired":"モデルを選択または手動入力してください","apiKeyRequired":"キーは必須です","saveFailed":"保存に失敗","saveAsDefaultDone":"デフォルト設定として保存済み","promptSavedOk":"保存しました。","tabSessions":"セッション","sessionsTitle":"セッション","sessionsDesc":"Pi の会話履歴を管理します。","sessionsLoading":"セッション読み込み中...","sessionsLoadFailed":"セッションの読み込みに失敗","sessionsEmpty":"セッションがありません。","sessMsgs":"件","sessRead":"開く","sessDel":"削除","sessDeleteConfirm":"このセッションを削除しますか？","sessDeleteFailed":"セッションの削除に失敗","sessDeleted":"セッションを削除しました。","sessBack":"戻る","sessReadFailed":"セッションの読み込みに失敗","sessTruncated":"（省略）","sessSearchPlaceholder":"要約・プロジェクト・ID で検索...","sessRefresh":"更新","sessCount":"{total} 件中 {shown} 件","sessCopy":"コピー","sessCopied":"コピーしました","sessCopyAll":"会話をコピー","sessLoadMore":"もっと読み込む ({n})","sessLoadingDetail":"セッションを読み込み中...","sessNoMatch":"検索に一致するセッションはありません。","sessThinking":"思考","sessToolUse":"ツール: {name}","sessToolResult":"ツール結果","sessNoMessages":"このセッションにメッセージはありません。","fetchModels":"取得","fetchModelsTitle":"サービスからモデルを取得","modelsFetching":"モデル取得中...","modelsNoMatch":"一致するモデルなし","modelsError":"失敗:","modelsEmpty":"モデルが返されませんでした","modelsAutoFetched":"モデルを取得しました","modelsFetchHint":"URLとキーを入力し取得をクリック","testModels":"モデル可用性テスト","testUnsupportedForm":"実リクエストによる可用性テストは OpenAI 互換 / Responses 形式のみ対応しています。","tabSettings":"設定プレビュー","settingsTitle":"settings.json（読み取り専用）","settingsIntro":"Pi 設定ファイルをプレビュー。デフォルト: ","settingsReadonly":" · 読み取り専用","settingsWarning":"読み取り専用です。プロバイダーまたは実行設定で変更してください。","settingsContent":"内容","settingsEmpty":"ファイルが存在しないか空です。","settingsSizeHint":"","settingsLoadFailed":"設定の読み込みに失敗","settingsNotJson":"ファイルは存在しますが有効な JSON ではありません。","settingsSizeBytes":" バイト","sessDeleteAll":"すべて削除","sessDeleteAllConfirm":"すべてのセッション履歴を削除しますか？この操作は元に戻せません。","sessDeleteAllFailed":"全セッションの削除に失敗","sessDeletedAll":"{n}件のセッションを削除","modalCancel":"キャンセル","modalConfirm":"削除","showDiff":"差分を表示","hideDiff":"差分を非表示","diffLoading":"差分を計算中...","diffNoChanges":"変更なし","diffError":"差分の計算に失敗","sessSelectAll":"すべて選択","sessClearSelection":"選択解除","sessSelCount":"{n} 件選択中","sessDeleteSelected":"選択を削除 ({n})","sessDeleteSelectedZero":"選択を削除","sessDeleteBatchConfirm":"選択した {n} 件のセッションを削除しますか？この操作は元に戻せません。","sessDeletedBatch":"{n} 件のセッションを削除しました","sessDeleteBatchFailed":"{n} 件失敗","exportSessionsHint":"エクスポートに選択セッション {n} 件を含みます","importSessionsOk":"セッション: 追加 {a} / 置換 {r} / スキップ {s}","importSessionsFailed":"{n} 件のセッションが失敗","tabHistory":"プロンプト履歴","historyTitle":"プロンプト履歴","historyDesc":"Pi が上矢印のエディタ履歴として保存するプロンプト入力履歴を管理します。重複は自動的に整理されます。","histSearchPlaceholder":"プロンプトやプロジェクトを検索...","historyChars":"文字","historyLoading":"プロンプト履歴を読み込み中...","historyLoadFailed":"プロンプト履歴の読み込みに失敗しました","historyEmpty":"プロンプト履歴がありません。","historyNoMatch":"検索に一致するプロンプトはありません。","histDeleteAll":"すべて削除","histDeleteConfirm":"このプロンプトを履歴から削除しますか？この操作は元に戻せません。","historyDeleteFailed":"プロンプトの削除に失敗しました","histDeleted":"プロンプトを削除しました。","histDeletedBatch":"{n} 件のプロンプトを削除しました","histDeleteBatchFailed":"{n} 件失敗","histDeleteBatchConfirm":"選択した {n} 件のプロンプトを削除しますか？この操作は元に戻せません。","histDeleteAllConfirm":"すべてのプロンプト履歴を削除しますか？この操作は元に戻せません。","histDeleteAllFailed":"プロンプト履歴の全削除に失敗しました","histDeletedAll":"{n} 件のプロンプトを削除しました","histDupBadge":"{n} 件の重複を整理済み","importPromptHistoryOk":"プロンプト履歴: 追加 {a} / 置換 {r} / スキップ {s}","histSelectProject":"すべて選択","histUnselectProject":"選択解除","workspaceCaption":"エージェントワークスペース","workspaceLabel":"ワークスペース","localWorkspace":"ローカル環境","languageLabel":"言語","themeLabel":"外観","themeSystem":"システム","themeLight":"ライト","themeDark":"ダーク","providerDescription":"プロバイダーを接続し、モデルと既定値を管理します。","promptDescription":"エージェントの動作を定義する指示を編集します。","retryDescription":"リトライ、入力制御、一時コマンドを設定します。","sessionsDescription":"プロジェクトの会話を検索して管理します。","historyDescription":"過去のプロンプトを検索して再利用します。","settingsDescription":"現在の設定を読み取り専用で確認します。","connectionTitle":"接続設定","connectionDescription":"プリセットを選択するか、互換 API の URL を入力します。","modelsTitle":"モデル設定","modelsDescription":"モデルを追加して既定モデルと思考レベルを選択します。","preferencesTitle":"環境設定","addModelLabel":"モデルを追加","commandLifecycle":"コマンドのライフサイクル","retainCommandsLabel":"完了後も一時コマンドを保持","retainCommandsHint":"/blueprint、/spawn、/scout を保持します。オフにするとエージェント完了時に自動削除します。","saveCommandsLabel":"コマンド設定を保存","commandsSaved":"コマンド設定を保存しました。","commandsFailed":"コマンド設定を保存できませんでした。","providersEmpty":"プロバイダーがありません。下で接続を追加してください。"},"zh":{"fastMode":"Fast 服务档位","fastModeHint":"Web 聊天：为这些 OpenAI 模型发送 service_tier: fast。默认关闭。","compatOnly":"仅 OpenAI 兼容","addProviderTitle":"添加模型提供商","setupDesc":"配置提供商或系统提示词。","tabProvider":"提供商","tabPrompt":"系统提示词","tabRetry":"运行策略","serviceUrl":"服务 URL","serviceUrlPlaceholder":"https://api.example.com/v1","apiKey":"API 密钥","toggleKey":"切换 API 密钥显示","apiKeyNote":"API 密钥存储在本地配置文件中。","model":"模型","providerName":"提供商名称","providerNamePlaceholder":"自动生成，可选","autoGenHint":"留空则自动生成。","maxOutputTokens":"最大输出 token","maxTokensHint":"自动保存，运行中的 code 会话从下一次请求起生效。","providerTokensSaved":"输出上限已保存，从下一次请求起生效。","reasoningStrength":"推理强度","reasoningOff":"关闭","reasoningMinimal":"最小","reasoningLow":"低","reasoningMedium":"中","reasoningHigh":"高","reasoningXhigh":"超高","reasoningMax":"最高","exportProviders":"导出提供商","importProviders":"导入提供商","savedProviders":"已保存提供商","presetLabel":"参考预设","presetAnthropic":"Anthropic","presetOpenAIChat":"OpenAI Chat","presetOpenAIResponses":"OpenAI Responses","presetApplied":"已套用预设 — 请填写 API Key 并选择模型","apiShapeLabel":"API 协议","apiShapeOpenAI":"OpenAI 兼容","apiShapeAnthropic":"Anthropic Messages（原生）","apiShapeOpenAIResponses":"OpenAI Responses","apiShapeNoFetch":"此协议形态没有模型列表端点 —— 请从预设候选选择或手动输入模型 ID。","provNew":"新建提供商","provClone":"克隆","cloneFailed":"克隆提供商失败","providerCloned":"已克隆为 {name}，可编辑后保存","newProviderHint":"已清空表单：填写 URL、密钥与模型后保存。","provSetDefault":"设为默认","provDelete":"删除","provDeleteConfirm":"删除提供商 {name}？记录将从 models.json 中移除。","providerDeleted":"已删除提供商 {name}。","defaultSetOk":"默认提供商已更新。","defaultSetFailed":"更新默认提供商失败。","deleteFailed":"删除提供商失败。","modelsCount":"个模型","saveAsDefault":"保存为默认","systemPromptTitle":"系统提示词","promptEditDesc":"编辑 Pi 提示词文件。默认：","scope":"范围","scopeGlobal":"全局 (~/.pi/agent)","scopeProject":"项目 (./.pi)","file":"文件","modeAppend":"APPEND_SYSTEM.md（追加，推荐）","modeSystem":"SYSTEM.md（替换默认提示词）","modePlan":"plan-prompt.md（/plan 模板）","editPlan":"正在编辑 plan-prompt.md：/plan 命令模板","planHint":"/plan 模板必须包含 {{requirement}} 占位符。文件不存在时回退内置模板。","planReset":"恢复内置模板","planResetConfirm":"删除 plan-prompt.md 以恢复内置 /plan 模板？","planResetDone":"已恢复内置模板。","planResetFailed":"恢复内置模板失败","loadingPrompt":"等待加载中...","content":"内容","contentPlaceholder":"输入要追加或替换的系统提示词...","promptHint":"SYSTEM.md 为替换，APPEND_SYSTEM.md 为追加。","savePrompt":"保存提示词文件","retryTitle":"请求重试","retryDesc":"配置 Pi API 请求的重试策略。","retryDestSuffix":" 中。","retryEnabled":"启用重试","retryEnabledDesc":"启用后在请求失败时自动重试","maxRetryCount":"最大重试次数","retryMaxHint":"默认 3。","baseDelay":"基础退避延迟 (ms)","retryDelayHint":"默认 2000。","fixedDelay":"固定重试延迟 (ms)","retryFixedDelayHint":"默认 3000。429 限流与连接重试的固定间隔。","saveRetry":"保存重试设置","status":"状态","step1":"输入 URL 和密钥","step2":"获取模型","step3":"保存","footer":"修改将保存到本地工作区。","providerLoaded":"提供商已加载","modelsLoaded":"模型已加载","saveOrEdit":"可保存或编辑","configLoaded":"配置已加载。","configLoadFailed":"加载配置失败","promptLoadFailed":"加载提示词失败","existingFile":"现有文件：","newFile":"新文件：","editSystem":"正在编辑 SYSTEM.md：替换默认提示词","editAppend":"正在编辑 APPEND_SYSTEM.md：追加提示词","promptEmpty":"系统提示词不能为空","promptSaveFailed":"保存提示词失败","savedAs":"已保存：","promptSaved":"提示词已保存。","retryLoadFailed":"加载重试设置失败","retryOn":"重试已启用","retryOff":"重试已禁用","retrySaveFailed":"保存重试设置失败","retrySavedOn":"重试已启用并保存。","retrySavedOff":"重试已禁用并保存。","steeringTitle":"转向模式","steeringDesc":"在 agent 运行中输入到达时的处理方式。","steeringDestSuffix":" 中。","steeringMode":"转向模式","steeringOneAtATime":"逐条处理","steeringAll":"全部处理","steeringHint":"one-at-a-time：逐条打断正在运行的轮次。all：将排队的转向消息一次性全部发送。下次启动 Pi 会话时生效。","saveSteering":"保存转向设置","modelsUpdated":"模型已更新。","exportFailed":"导出失败","exported":"提供商已导出。","importFailed":"导入失败","importOkPrefix":"导入完成：添加 ","importOkMid":" / 替换 ","importOkMid2":" / 跳过 ","importOkSuffix":" / 总计 ","importOkRejected":" / 拒绝 ","importOkDefault":" · 已恢复默认提供商","modelInputPlaceholder":"输入或选择模型","modelRequired":"请选择或手动输入模型","apiKeyRequired":"需要 API 密钥","saveFailed":"保存失败","saveAsDefaultDone":"已保存为默认","promptSavedOk":"已保存。","tabSessions":"会话","sessionsTitle":"会话记录","sessionsDesc":"管理 Pi 对话历史。","sessionsLoading":"加载会话中...","sessionsLoadFailed":"加载会话失败","sessionsEmpty":"暂无会话记录。","sessMsgs":"条消息","sessRead":"查看","sessDel":"删除","sessDeleteConfirm":"删除此会话记录？","sessDeleteFailed":"删除会话失败","sessDeleted":"会话已删除。","sessBack":"返回","sessReadFailed":"读取会话失败","sessTruncated":"（截断）","sessSearchPlaceholder":"搜索摘要、项目或 ID…","sessRefresh":"刷新","sessCount":"{total} 条中的 {shown} 条","sessCopy":"复制","sessCopied":"已复制","sessCopyAll":"复制完整记录","sessLoadMore":"加载更多（{n}）","sessLoadingDetail":"正在加载会话…","sessNoMatch":"没有匹配的会话记录。","sessThinking":"思考过程","sessToolUse":"工具调用：{name}","sessToolResult":"工具结果","sessNoMessages":"此会话暂无消息。","fetchModels":"获取","fetchModelsTitle":"从服务获取模型列表","modelsFetching":"正在获取模型...","modelsNoMatch":"无匹配模型","modelsError":"失败:","modelsEmpty":"服务未返回任何模型","modelsAutoFetched":"已获取模型列表","modelsFetchHint":"输入 URL 和密钥后点击获取","testModels":"测试可用性","testUnsupportedForm":"真实请求可用性测试目前仅支持 OpenAI 兼容 / Responses 形态。","tabSettings":"配置预览","settingsTitle":"settings.json（只读）","settingsIntro":"预览 Pi 配置文件。默认位置：","settingsReadonly":" · 只读","settingsWarning":"当前为只读预览。请在“提供商”或“运行策略”中修改配置。","settingsContent":"内容","settingsEmpty":"文件不存在或为空。","settingsSizeHint":"","settingsLoadFailed":"加载配置失败","settingsNotJson":"文件存在但不是有效的 JSON。","settingsSizeBytes":" 字节","sessDeleteAll":"全部删除","sessDeleteAllConfirm":"删除全部会话记录？此操作不可撤销。","sessDeleteAllFailed":"删除全部会话失败","sessDeletedAll":"已删除 {n} 条会话","modalCancel":"取消","modalConfirm":"删除","showDiff":"显示差异","hideDiff":"隐藏差异","diffLoading":"正在计算差异...","diffNoChanges":"无更改","diffError":"计算差异失败","sessSelectAll":"全选","sessClearSelection":"清除选择","sessSelCount":"已选 {n} 条","sessDeleteSelected":"删除所选 ({n})","sessDeleteSelectedZero":"删除所选","sessDeleteBatchConfirm":"删除 {n} 条所选会话？此操作不可撤销。","sessDeletedBatch":"已删除 {n} 条会话","sessDeleteBatchFailed":"{n} 条失败","exportSessionsHint":"导出包含 {n} 条所选会话","importSessionsOk":"会话：新增 {a} / 替换 {r} / 跳过 {s}","importSessionsFailed":"{n} 条会话失败","tabHistory":"提示词历史","historyTitle":"提示词历史","historyDesc":"管理 Pi 为上箭头编辑器历史保存的提示词输入记录，重复条目会自动合并。","histSearchPlaceholder":"搜索提示词或项目…","historyChars":"字符","historyLoading":"正在加载提示词历史…","historyLoadFailed":"加载提示词历史失败","historyEmpty":"暂无提示词历史。","historyNoMatch":"没有匹配的提示词记录。","histDeleteAll":"全部删除","histDeleteConfirm":"从历史中删除此提示词？此操作不可撤销。","historyDeleteFailed":"删除提示词失败","histDeleted":"提示词已删除。","histDeletedBatch":"已删除 {n} 条提示词","histDeleteBatchFailed":"{n} 条失败","histDeleteBatchConfirm":"删除 {n} 条所选提示词？此操作不可撤销。","histDeleteAllConfirm":"删除全部提示词历史？此操作不可撤销。","histDeleteAllFailed":"删除全部提示词历史失败","histDeletedAll":"已删除 {n} 条提示词","histDupBadge":"已合并 {n} 条重复","importPromptHistoryOk":"提示词历史：新增 {a} / 替换 {r} / 跳过 {s}","histSelectProject":"全选","histUnselectProject":"取消全选","workspaceCaption":"智能体工作区","workspaceLabel":"工作区","localWorkspace":"本地工作区","languageLabel":"语言","themeLabel":"外观","themeSystem":"跟随系统","themeLight":"浅色","themeDark":"深色","providerDescription":"连接提供商，管理模型，设置工作区默认值。","promptDescription":"编写系统提示词，定义智能体的工作方式。","retryDescription":"设置请求重试、输入调度与临时命令。","sessionsDescription":"浏览、搜索和管理项目对话。","historyDescription":"查找并复用各项目的历史提示词。","settingsDescription":"只读查看当前工作区配置。","connectionTitle":"连接设置","connectionDescription":"选择预设，或填写兼容的 API 地址。","modelsTitle":"模型设置","modelsDescription":"添加模型，选择默认模型与各自的思考强度。","preferencesTitle":"偏好设置","addModelLabel":"添加模型","commandLifecycle":"命令生命周期","retainCommandsLabel":"任务完成后保留临时命令","retainCommandsHint":"保留 /blueprint、/spawn 和 /scout。关闭后，智能体完成任务时自动移除这些命令。","saveCommandsLabel":"保存命令设置","commandsSaved":"命令设置已保存。","commandsFailed":"命令设置保存失败。","providersEmpty":"尚未添加提供商。请在下方建立第一个连接。"}}; const T=k=>I18N[currentLang][k]||k;const $=id=>document.getElementById(id);let promptBaseHash="";let promptLoaded=false;let providerLoaded=false;let retryLoaded=false;let sessionsLoaded=false;let settingsLoaded=false;let loadedProvider=null;const providerDefaults={...DEFAULTS,reasoningEffort:"high"};const providerLastValid={...providerDefaults};function currentApiForm(){return $('apiShape').value}function setApiForm(api){const sel=$('apiShape');const v=String(api||'').trim()||DEFAULT_API_FORM;let custom=sel.querySelector('option[data-custom]');if(API_FORMS.some(function(f){return f.id===v})){if(custom)custom.remove()}else{if(!custom){custom=document.createElement('option');custom.setAttribute('data-custom','1');sel.appendChild(custom)}custom.value=v;custom.textContent=v}sel.value=v;updateApiFormUi()}function updateApiFormUi(){const fast=$('fastMode');if(fast){fast.disabled=!['openai-completions','openai-responses'].includes($('apiShape').value);if(fast.disabled)fast.checked=false}const form=API_FORMS.find(function(f){return f.id===$('apiShape').value});const fetchable=form?form.fetchable:false;const btn=$('testModels');if(btn)btn.disabled=!fetchable;const hint=$('apiShapeHint');if(hint)hint.textContent=fetchable?'':T('apiShapeNoFetch')+' '+T('testUnsupportedForm')}$('apiShape').addEventListener('change',updateApiFormUi);function applyI18n(){document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=T(el.getAttribute('data-i18n')));document.querySelectorAll('[data-i18n-ph]').forEach(el=>el.placeholder=T(el.getAttribute('data-i18n-ph')));document.querySelectorAll('[data-i18n-aria]').forEach(el=>el.setAttribute('aria-label',T(el.getAttribute('data-i18n-aria'))));document.documentElement.lang=currentLang==='zh'?'zh-CN':currentLang;renderModelList();renderProviderList();updatePageHeading()}function esc(v){return String(v).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')}const _statusTimers={};let comboModels=[];let comboActiveIndex=-1;let currentModels=[];let currentDefaultId='';let currentModelEfforts=new Map();function renderComboDropdown(){const dd=$('modelDropdown');const q=$('model').value.trim().toLowerCase();if(!comboModels.length){dd.hidden=false;dd.className='combo-dropdown';dd.innerHTML='<div class="combo-nomatch">'+esc(T('modelsFetchHint'))+'</div>';comboActiveIndex=-1;return}let filtered=comboModels;if(q){filtered=comboModels.filter(m=>m.toLowerCase().includes(q))}if(!filtered.length){dd.hidden=false;dd.innerHTML='<div class="combo-nomatch">'+esc(T('modelsNoMatch'))+'</div>';comboActiveIndex=-1;return}dd.hidden=false;dd.innerHTML=filtered.map((m,i)=>{const cls=i===comboActiveIndex?'combo-item active':'combo-item';let label;if(q){const pos=m.toLowerCase().indexOf(q);if(pos>=0){label=esc(m.slice(0,pos))+'<mark>'+esc(m.slice(pos,pos+q.length))+'</mark>'+esc(m.slice(pos+q.length))}else{label=esc(m)}}else{label=esc(m)}return '<div class="'+cls+'" role="option" data-val="'+esc(m)+'">'+label+'</div>'}).join('')}function setComboModels(models){comboModels=Array.isArray(models)?models.slice():[];comboActiveIndex=-1}function renderModelList(){var el=$('modelList');if(!el)return;if(!currentModels.length){el.innerHTML='';return}el.innerHTML=currentModels.map(function(id){var def=id===currentDefaultId;return '<div class="model-item"><input type="radio" name="modelDefault" '+(def?'checked':'')+' data-setdef="'+esc(id)+'" style="width:auto;height:auto;margin:0;cursor:pointer"><span class="m-id">'+esc(id)+(def?' <span class="m-default">★</span>':'')+'</span><select data-effort="'+esc(id)+'" aria-label="'+esc(id+' '+T('reasoningStrength'))+'" style="width:auto;max-width:40%;height:44px">'+[['off','reasoningOff'],['minimal','reasoningMinimal'],['low','reasoningLow'],['medium','reasoningMedium'],['high','reasoningHigh'],['xhigh','reasoningXhigh'],['max','reasoningMax']].map(function(o){return '<option value="'+o[0]+'"'+(o[0]===currentModelEfforts.get(id)?' selected':'')+'>'+esc(T(o[1]))+'</option>'}).join('')+'</select><button class="m-del" type="button" data-del="'+esc(id)+'">✕</button></div>'}).join('');el.querySelectorAll('input[data-setdef]').forEach(function(r){r.onchange=function(){currentDefaultId=r.getAttribute('data-setdef');renderModelList()}});el.querySelectorAll('select[data-effort]').forEach(function(sel){sel.onchange=function(){var id=sel.getAttribute('data-effort');currentModelEfforts.set(id,sel.value)}});el.querySelectorAll('.m-del').forEach(function(b){b.onclick=function(){removeModel(b.getAttribute('data-del'))}})}function addModel(id){var v=String(id||'').trim();if(!v)return;if(currentModels.indexOf(v)<0){currentModels.push(v);currentModelEfforts.set(v,providerLastValid.reasoningEffort)}if(!currentDefaultId)currentDefaultId=v;renderModelList();$('model').value=''}function removeModel(id){currentModelEfforts.delete(id);currentModels=currentModels.filter(function(m){return m!==id});if(currentDefaultId===id)currentDefaultId=currentModels[0]||'';renderModelList()}function openComboDropdown(){$('model').setAttribute('aria-expanded','true');renderComboDropdown()}function closeComboDropdown(){const dd=$('modelDropdown');dd.hidden=true;comboActiveIndex=-1;$('model').setAttribute('aria-expanded','false')}async function fetchModelsAction(){const baseUrl=$('baseUrl').value.trim();const apiKey=$('apiKey').value.trim();if(!baseUrl){setStatus('err',T('modelsError')+' '+T('serviceUrl'));return}if(!apiKey){setStatus('err',T('modelsError')+' '+T('apiKeyRequired'));return}try{const r=await apiFetch('/api/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl,apiKey})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Error');setComboModels(j.models||[]);step('s2','done',T('modelsAutoFetched'));setStatus('ok',T('modelsAutoFetched'));openComboDropdown()}catch(e){step('s2','err',T('modelsError'));setStatus('err',T('modelsError')+' '+e.message);const dd=$('modelDropdown');dd.hidden=false;dd.innerHTML='<div class="combo-error">'+esc(T('modelsError')+' '+e.message)+'</div>'}}function renderTestList(rows){const el=$('modelTestList');el.innerHTML=rows.map(function(r){let badge='<span class="t-badge polling"></span>';if(r.state==='done'){badge=r.ok?'<span class="t-badge ok">✓ '+r.ms+'ms</span>':'<span class="t-badge err" title="'+esc(r.detail||'')+'">✗</span>'}return '<div class="test-item"><span class="t-name">'+esc(r.model)+'</span>'+badge+'</div>'}).join('')}async function testModelsAction(){const baseUrl=$('baseUrl').value.trim();const apiKey=$('apiKey').value.trim();const list=comboModels.slice();if(!baseUrl){setStatus('err',T('modelsError')+' '+T('serviceUrl'));return}if(!apiKey){setStatus('err',T('modelsError')+' '+T('apiKeyRequired'));return}if(!list.length){setStatus('err',T('modelsError')+' '+T('modelsEmpty'));return}const btn=$('testModels');btn.disabled=true;const sum=$('modelTestHint');sum.textContent=T('modelsFetching');renderTestList(list.map(function(m){return {model:m,state:'pending'}}));try{const r=await apiFetch('/api/models/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({baseUrl,apiKey,models:list})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Error');const rows=(j.results||[]).map(function(res){return {model:res.model,state:'done',ok:Boolean(res.ok),ms:res.latency,detail:res.detail||''}});renderTestList(rows);const okCount=rows.filter(function(x){return x.ok}).length;sum.textContent=okCount+' / '+rows.length}catch(e){sum.textContent=T('modelsError')+' '+e.message}finally{btn.disabled=false}}function comboNavigate(dir){const dd=$('modelDropdown');if(dd.hidden){openComboDropdown();return}const q=$('model').value.trim().toLowerCase();const filtered=q?comboModels.filter(m=>m.toLowerCase().includes(q)):comboModels;if(!filtered.length)return;let cur=comboActiveIndex;if(dir>0)cur=(cur+1)%filtered.length;else cur=cur<=0?filtered.length-1:cur-1;comboActiveIndex=cur;renderComboDropdown()}function comboSelectCurrent(){const q=$('model').value.trim().toLowerCase();const filtered=q?comboModels.filter(m=>m.toLowerCase().includes(q)):comboModels;const idx=comboActiveIndex;if(idx<0||idx>=filtered.length)return;addModel(filtered[idx]);closeComboDropdown()}function initCombo(){const input=$('model');const dd=$('modelDropdown');let debounceTimer=null;input.addEventListener('input',()=>{clearTimeout(debounceTimer);debounceTimer=setTimeout(()=>{if(!dd.hidden)renderComboDropdown()},120)});input.addEventListener('focus',()=>{if(comboModels.length)openComboDropdown()});input.addEventListener('keydown',(e)=>{if(e.key==='ArrowDown'){e.preventDefault();comboNavigate(1)}else if(e.key==='ArrowUp'){e.preventDefault();comboNavigate(-1)}else if(e.key==='Enter'&&!dd.hidden&&comboActiveIndex>=0){e.preventDefault();comboSelectCurrent()}else if(e.key==='Escape'&&!dd.hidden){e.preventDefault();closeComboDropdown()}});dd.addEventListener('click',(e)=>{const item=e.target.closest('.combo-item');if(!item)return;const val=item.getAttribute('data-val');if(val){addModel(val);closeComboDropdown()}});document.addEventListener('click',(e)=>{if(!dd.hidden&&e.target!==input&&!e.target.closest('#modelCombo'))closeComboDropdown()})}function scheduleClear(el,timerKey){if(_statusTimers[timerKey])clearTimeout(_statusTimers[timerKey]);_statusTimers[timerKey]=setTimeout(()=>{el.className='status';el.textContent='';delete _statusTimers[timerKey]},750)}function setStatus(type,msg){const el=$('status');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'status')}function setPromptStatus(type,msg){const el=$('promptStatus');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'promptStatus')}function setRetryStatus(type,msg){const el=$('retryStatus');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'retryStatus')}function step(id,state,text){const el=$(id);el.className='step '+(state||'');el.querySelector('span').textContent=text}function selectedModel(){return $('model').value.trim()}function currentModelConfig(p,model){return (p.modelConfigs||[]).find(m=>m.id===model)||(p.modelConfigs||[])[0]||{}}function fillProvider(p,model,thinkingLevel){loadedProvider=p;$('fastMode').checked=p.fastMode===true;$('providerName').value=p.id;$('baseUrl').value=p.baseUrl||'';setComboModels(p.models||[]);currentModels=Array.isArray(p.models)?p.models.slice():[];currentDefaultId=p.id===allDefaultProvider&&currentModels.includes(model)?model:p.defaultModel||currentModels[0]||'';currentModelEfforts=new Map(currentModels.map(function(id){var cfg=currentModelConfig(p,id);return [id,cfg.reasoningEffort??(p.id===allDefaultProvider&&id===allDefaultModel?thinkingLevel:cfg.reasoning===false?'off':providerDefaults.reasoningEffort)]}));renderModelList();$('model').value='';$('apiKey').value=p.apiKey||'';$('apiKey').placeholder='sk-...';setApiForm(p.api||DEFAULT_API_FORM);providerLastValid.maxTokens=p.maxTokens??currentModelConfig(p,currentDefaultId).maxTokens??providerDefaults.maxTokens;providerLastValid.reasoningEffort=currentModelEfforts.get(currentDefaultId)??providerDefaults.reasoningEffort;step('s1','done',T('providerLoaded'));step('s2','done',T('modelsLoaded'));step('s3','',T('saveOrEdit'));setStatus('ok',T('configLoaded'))}function newProviderForm(){$('fastMode').checked=false;loadedProvider=null;providerLoaded=false;$('providerName').value='';$('baseUrl').value='';$('apiKey').value='';$('apiKey').placeholder='sk-...';setComboModels([]);currentModels=[];currentDefaultId='';currentModelEfforts=new Map();renderModelList();$('model').value='';providerLastValid.maxTokens=providerDefaults.maxTokens;providerLastValid.reasoningEffort=providerDefaults.reasoningEffort;setApiForm(DEFAULT_API_FORM);step('s1','',T('step1'));step('s2','',T('step2'));step('s3','',T('step3'));setStatus('ok',T('newProviderHint'))}let allProviders=[],allDefaultProvider='',allDefaultModel='',allDefaultThinkingLevel='';function renderProviderList(){var el=$('providersList');if(!el)return;if(!allProviders.length){el.innerHTML='<p class="hint">'+esc(T('providersEmpty'))+'</p>';return}el.innerHTML=allProviders.map(function(p){var def=p.id===allDefaultProvider;var modelCount=Array.isArray(p.models)?p.models.length:0;return '<div class="provider-item" data-pid="'+esc(p.id)+'"'+(def?' data-default="1"':'')+' role="button" tabindex="0">'+'<span class="p-id">'+esc(p.id)+(def?' <span class="m-default">★</span>':'')+'</span>'+'<span class="p-meta">'+esc(p.baseUrl||'')+' · '+modelCount+' '+T('modelsCount')+'</span>'+'<label class="p-tokens" style="display:flex;align-items:center;gap:8px;font-size:12px" title="'+esc(T('maxTokensHint'))+'">'+esc(T('maxOutputTokens'))+'<input data-provider-tokens="'+esc(p.id)+'" aria-label="'+esc(p.id+' '+T('maxOutputTokens'))+'" type="number" min="1" step="1" inputmode="numeric" value="'+esc(p.maxTokens??currentModelConfig(p,p.defaultModel).maxTokens??providerDefaults.maxTokens)+'" style="width:110px;min-height:44px;background:var(--inputBg);color:var(--inputText);border:1px solid var(--line);border-radius:8px;padding:0 8px"></label>'+'<div class="p-actions">'+'<button class="p-btn" data-clone="'+esc(p.id)+'" type="button">'+T('provClone')+'</button>'+'<button class="p-btn" data-setdef="'+esc(p.id)+'" type="button"'+(def?' disabled':'')+'>'+T('provSetDefault')+'</button>'+'<button class="p-btn danger" data-del="'+esc(p.id)+'" type="button">'+T('provDelete')+'</button>'+'</div></div>'}).join('');el.querySelectorAll('.provider-item').forEach(function(row){row.onkeydown=function(e){if(e.target!==row||!['Enter',' '].includes(e.key))return;e.preventDefault();row.click()};row.onclick=function(e){if(e.target.closest('.p-btn,.p-tokens'))return;var p=allProviders.find(function(x){return x.id===row.getAttribute('data-pid')});if(!p)return;fillProvider(p,p.defaultModel||(p.models&&p.models[0])||'',allDefaultThinkingLevel||providerDefaults.reasoningEffort);providerLoaded=true;if(p.baseUrl&&p.apiKey)fetchModelsAction();setStatus('ok',T('configLoaded'))}});el.querySelectorAll('[data-provider-tokens]').forEach(function(input){input.onchange=async function(){var id=input.getAttribute('data-provider-tokens');var p=allProviders.find(function(x){return x.id===id});if(!p)return;var previous=p.maxTokens??currentModelConfig(p,p.defaultModel).maxTokens??providerDefaults.maxTokens;input.disabled=true;try{const r=await apiFetch('/api/providers/max-tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:id,maxTokens:input.value})});const j=await r.json();if(!r.ok)throw new Error(j.error);p.maxTokens=j.maxTokens;(p.modelConfigs||[]).forEach(function(m){m.maxTokens=j.maxTokens});if(loadedProvider&&loadedProvider.id===id)loadedProvider=p;input.value=String(j.maxTokens);setStatus('ok',T('providerTokensSaved'))}catch(e){input.value=String(previous);setStatus('err',e.message)}finally{input.disabled=false}}});el.querySelectorAll('[data-clone]').forEach(function(b){b.onclick=function(){cloneProviderAction(b.getAttribute('data-clone'))}});el.querySelectorAll('[data-setdef]').forEach(function(b){b.onclick=function(){setDefaultProvider(b.getAttribute('data-setdef'))}});el.querySelectorAll('[data-del]').forEach(function(b){b.onclick=function(){deleteProviderAction(b.getAttribute('data-del'))}});}async function setDefaultProvider(id){if(!id)return;try{var p=allProviders.find(function(x){return x.id===id});if(!p)return;var model=p.defaultModel||(p.models&&p.models[0])||'';if(!model)throw new Error('Model is required');const r=await apiFetch('/api/providers/default',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:id,model:model,thinkingLevel:currentModelConfig(p,model).reasoningEffort??(currentModelConfig(p,model).reasoning===false?'off':providerDefaults.reasoningEffort)})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('defaultSetFailed'));setStatus('ok',T('defaultSetOk'));loadExisting()}catch(e){setStatus('err',e.message)}}async function deleteProviderAction(id){if(!id)return;const ok=await confirmDialog(T('provDelete'),T('provDeleteConfirm').replace('{name}',id),T('modalConfirm'));if(!ok)return;try{const r=await apiFetch('/api/providers/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('deleteFailed'));setStatus('ok',T('providerDeleted').replace('{name}',id));loadExisting()}catch(e){setStatus('err',e.message)}}async function cloneProviderAction(id){if(!id)return;try{const r=await apiFetch('/api/providers/clone',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:id})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('cloneFailed'));setStatus('ok',T('providerCloned').replace('{name}',j.name));await loadExisting();const p=allProviders.find(function(x){return x.id===j.name});if(p){fillProvider(p,p.defaultModel||(p.models&&p.models[0])||'',allDefaultThinkingLevel||providerDefaults.reasoningEffort);providerLoaded=true}}catch(e){setStatus('err',e.message)}}async function refreshProvidersList(){try{const r=await apiFetch('/api/config');const j=await r.json();if(!r.ok)throw new Error(j.error||T('configLoadFailed'));allProviders=j.providers||[];allDefaultProvider=j.defaultProvider||'';allDefaultModel=j.defaultModel||'';allDefaultThinkingLevel=j.defaultThinkingLevel||'';renderProviderList()}catch(e){setStatus('err',e.message)}}async function loadExisting(){await refreshProvidersList();const p=allProviders.find(x=>x.id===allDefaultProvider)||allProviders[0];if(p){fillProvider(p,allDefaultModel||p.models?.[0],allDefaultThinkingLevel||providerDefaults.reasoningEffort);providerLoaded=true;if(p.baseUrl&&p.apiKey){fetchModelsAction()}}}function promptQuery(){return 'scope='+encodeURIComponent($('promptScope').value)+'&mode='+encodeURIComponent($('promptMode').value)}function updatePlanUi(){const isPlan=$('promptMode').value==='plan';if(isPlan)$('promptScope').value='global';$('promptScope').disabled=isPlan;$('planReset').style.display=isPlan?'':'none';$('promptHint').textContent=isPlan?T('planHint'):T('promptHint')}$('planReset').onclick=async()=>{const ok=await confirmDialog(T('planReset'),T('planResetConfirm'),T('modalConfirm'));if(!ok)return;try{const r=await apiFetch('/api/system-prompt/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:'global',mode:'plan'})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('planResetFailed'));await loadSystemPrompt();setPromptStatus('ok',T('planResetDone'))}catch(e){setPromptStatus('err',e.message)}};async function loadSystemPrompt(){try{$('promptPath').textContent=T('loadingPrompt');if(diffVisible)hidePromptDiff();const r=await apiFetch('/api/system-prompt?'+promptQuery());const j=await r.json();if(!r.ok)throw new Error(j.error||T('promptLoadFailed'));promptLoaded=true;promptBaseHash=j.hash;$('promptPath').textContent=(j.exists?T('existingFile'):T('newFile'))+j.path;$('promptContent').value=j.content||'';setPromptStatus('ok',(j.mode==='plan'?T('editPlan'):(j.mode==='system'?T('editSystem'):T('editAppend'))));}catch(e){setPromptStatus('err',e.message)}}async function saveSystemPrompt(){try{if(!$('promptContent').value.trim()){setPromptStatus('err',T('promptEmpty'));return}const r=await apiFetch('/api/system-prompt/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:$('promptScope').value,mode:$('promptMode').value,content:$('promptContent').value,baseHash:promptBaseHash})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('promptSaveFailed'));promptLoaded=true;promptBaseHash=j.hash;$('promptPath').textContent=T('savedAs')+j.path;if(diffVisible)hidePromptDiff();setPromptStatus('ok',T('promptSaved'));}catch(e){setPromptStatus('err',e.message)}}function renderDiffText(text){const pre=$('promptDiffPre');if(!text){pre.textContent='';return}const lines=String(text).split('\\n');let html='';for(const line of lines){if(line.startsWith('+++')||line.startsWith('---')){html+='<span class="diff-meta">'+esc(line)+'</span>'}else if(line.startsWith('@@')){html+='<span class="diff-hunk">'+esc(line)+'</span>'}else if(line.startsWith('+')){html+='<span class="diff-add">'+esc(line)+'</span>'}else if(line.startsWith('-')){html+='<span class="diff-del">'+esc(line)+'</span>'}else{html+=esc(line)}html+='\\n'}pre.innerHTML=html}let diffVisible=false;async function loadPromptDiff(){const btn=$('diffToggle');const viewer=$('promptDiff');const pre=$('promptDiffPre');btn.disabled=true;const oldLabel=btn.textContent;btn.textContent=T('diffLoading');try{const r=await apiFetch('/api/system-prompt/diff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope:$('promptScope').value,mode:$('promptMode').value,content:$('promptContent').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('diffError'));const diffText=j.diff||'';if(diffText==='No changes\\n'){pre.textContent=T('diffNoChanges');viewer.classList.remove('diff-empty')}else{renderDiffText(diffText);viewer.classList.remove('diff-empty')}diffVisible=true;viewer.style.display='block';btn.textContent=T('hideDiff')}catch(e){setPromptStatus('err',T('diffError')+': '+e.message);btn.textContent=oldLabel}finally{btn.disabled=false}}function hidePromptDiff(){diffVisible=false;const viewer=$('promptDiff');viewer.style.display='none';$('promptDiffPre').textContent='';$('diffToggle').textContent=T('showDiff')}function togglePromptDiff(){if(diffVisible){hidePromptDiff()}else{loadPromptDiff()}}async function loadRetry(){try{const r=await apiFetch('/api/retry');const j=await r.json();if(!r.ok)throw new Error(j.error||T('retryLoadFailed'));retryLoaded=true;$('retryEnabled').checked=j.enabled;$('retryMax').value=String(j.maxRetries);$('retryDelay').value=String(j.baseDelayMs);$('retryFixedDelay').value=String(j.fixedDelayMs);setRetryStatus('ok',j.enabled?T('retryOn'):T('retryOff'));}catch(e){setRetryStatus('err',e.message)}}async function saveRetry(){try{const r=await apiFetch('/api/retry/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:$('retryEnabled').checked,maxRetries:Number($('retryMax').value),baseDelayMs:Number($('retryDelay').value),fixedDelayMs:Number($('retryFixedDelay').value)})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('retrySaveFailed'));retryLoaded=true;setRetryStatus('ok',j.retry.enabled?T('retrySavedOn'):T('retrySavedOff'));}catch(e){setRetryStatus('err',e.message)}}function setSteeringStatus(type,msg){const el=$('steeringStatus');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'steeringStatus')}async function loadSteering(){try{const r=await apiFetch('/api/steering');const j=await r.json();if(!r.ok)throw new Error(j.error||'Failed to load steering settings');$('steeringMode').value=j.available?.includes(j.mode)?j.mode:'one-at-a-time';setSteeringStatus('', '');}catch(e){setSteeringStatus('err',e.message)}}async function saveSteering(){try{const r=await apiFetch('/api/steering/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:$('steeringMode').value})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Failed to save steering settings');setSteeringStatus('ok',T('saveSteering')+': '+j.mode);}catch(e){setSteeringStatus('err',e.message)}}function updatePageHeading(name){
  const active=name||document.querySelector('.tab.active')?.id.replace(/Tab$/,'')||'provider';
  const titles={provider:'tabProvider',prompt:'tabPrompt',retry:'tabRetry',sessions:'tabSessions',history:'tabHistory',settings:'tabSettings'};
  for(const id of ['pageTitle','breadcrumbTitle']){const el=$(id);el.setAttribute('data-i18n',titles[active]);el.textContent=T(titles[active])}
  const description=$('pageDescription');description.setAttribute('data-i18n',active+'Description');description.textContent=T(active+'Description');
  document.title=T(titles[active])+' · Axum';
}
function activateTab(name){
  const names=['provider','prompt','retry','sessions','history','settings'];
  if(!names.includes(name))name='provider';
  try{localStorage.setItem('axumTab',name)}catch{}
  for(const key of names){
    const selected=key===name;const tab=$(key+'Tab');const panel=$(key+'Panel');
    tab.classList.toggle('active',selected);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
    panel.classList.toggle('active',selected);panel.hidden=!selected;
  }
  document.querySelector('.side').hidden=name!=='provider';updatePageHeading(name);
  if(name==='prompt')loadSystemPrompt();
  if(name==='retry'){loadRetry();loadSteering()}
  if(name==='sessions')loadSessions();
  if(name==='settings')loadSettings();
  if(name==='history')loadPromptHistory();
}
let initialTab='provider';try{initialTab=localStorage.getItem('axumTab')||'provider'}catch{}activateTab(initialTab);$('providerTab').onclick=()=>activateTab('provider');$('promptTab').onclick=()=>activateTab('prompt');$('retryTab').onclick=()=>activateTab('retry');$('sessionsTab').onclick=()=>activateTab('sessions');$('historyTab').onclick=()=>activateTab('history');$('settingsTab').onclick=()=>activateTab('settings');async function loadSettings(){const viewer=$('settingsContent');const pathEl=$('settingsPath');const hintEl=$('settingsHint');const introEl=document.querySelector('#settingsPanel .readonly-intro');viewer.classList.add('empty');viewer.textContent=T('loadingPrompt');pathEl.textContent=T('loadingPrompt');hintEl.textContent='';if(introEl)introEl.style.display='none';try{const r=await apiFetch('/api/settings');const j=await r.json();if(!r.ok)throw new Error(j.error||T('settingsLoadFailed'));settingsLoaded=true;pathEl.textContent=j.path;if(introEl&&j.parseError){introEl.style.display='block';introEl.textContent=T('settingsNotJson');viewer.classList.add('empty');viewer.textContent=T('settingsNotJson')}else if(!j.exists||!j.content||!j.content.trim()){viewer.classList.add('empty');viewer.textContent=T('settingsEmpty');if(introEl)introEl.style.display='none'}else{viewer.classList.remove('empty');viewer.textContent=j.content;const bytes=j.content.length;if(introEl)introEl.style.display='none';hintEl.textContent=bytes+' '+T('settingsSizeBytes')}}catch(e){viewer.classList.add('empty');viewer.textContent=T('settingsLoadFailed')+': '+e.message;pathEl.textContent='';if(introEl)introEl.style.display='none';hintEl.textContent=''}}
function applyPreset(p){if(!p)return;$('fastMode').checked=false;loadedProvider=null;providerLoaded=false;$('providerName').value=p.name||'';$('baseUrl').value=p.baseUrl||'';$('apiKey').value='';$('apiKey').placeholder='sk-...';setComboModels(p.suggestedModels||[]);currentModels=[];currentDefaultId='';currentModelEfforts=new Map();renderModelList();$('model').value='';providerLastValid.maxTokens=p.maxTokens??providerDefaults.maxTokens;setApiForm(p.api||DEFAULT_API_FORM);providerLastValid.reasoningEffort=p.reasoningEffort||'off';step('s1','',T('step1'));step('s2','',T('step2'));step('s3','',T('step3'));setStatus('ok',T('presetApplied'))}PRESETS.forEach(function(p){const b=$('preset-'+p.id);if(b)b.onclick=function(){applyPreset(p)};});
function setSessionsStatus(type,msg){const el=$('sessionsStatus');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'sessionsStatus')}let sessionsCache=[];let selectedSessionFile='';const selectedSessions=new Set();let detailMessages=[];let detailSkip=0;let detailTotal=0;async function loadSessions(){setSessionsStatus('',T('sessionsLoading'));try{const r=await apiFetch('/api/sessions');const j=await r.json();if(!r.ok)throw new Error(j.error||T('sessionsLoadFailed'));sessionsLoaded=true;sessionsCache=j.projects||[];if(selectedSessionFile&&!sessionsCache.some(p=>p.sessions.some(s=>s.file===selectedSessionFile))){selectedSessionFile='';hideSessionDetail()}renderSessionsTree()}catch(e){setSessionsStatus('err',e.message)}}function filterSessionsCache(){const q=($('sessSearch').value||'').trim().toLowerCase();if(!q)return sessionsCache;const out=[];for(const proj of sessionsCache){const ms=proj.sessions.filter(s=>String(s.summary||s.id||s.fileName||'').toLowerCase().includes(q)||String(proj.cwdHint||proj.dir||'').toLowerCase().includes(q));if(ms.length)out.push({dir:proj.dir,cwdHint:proj.cwdHint,count:ms.length,sessions:ms})}return out}function fmtSize(bytes){if(bytes<1024)return bytes+'B';if(bytes<1048576)return (bytes/1024).toFixed(1)+'KB';return (bytes/1048576).toFixed(1)+'MB'}function confirmDialog(title,body,confirmLabel,icon){const overlay=$('confirmModal');$('modalIcon').innerHTML=icon||'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>';$('modalTitle').textContent=title;$('modalBody').textContent=body;$('modalConfirm').textContent=confirmLabel||'';overlay.hidden=false;return new Promise(resolve=>{const cancel=$('modalCancel');const confirm=$('modalConfirm');const close=v=>{overlay.hidden=true;cancel.onclick=null;confirm.onclick=null;document.removeEventListener('keydown',onKey);resolve(v)};const onKey=e=>{if(e.key==='Escape'){e.preventDefault();close(false)}};cancel.onclick=()=>close(false);confirm.onclick=()=>close(true);document.addEventListener('keydown',onKey)})}function renderSessionsTree(){const projects=filterSessionsCache();const tree=$('sessionsTree');const delAllBtn=$('sessDeleteAll');const total=sessionsCache.reduce((n,p)=>n+p.sessions.length,0);const shown=projects.reduce((n,p)=>n+p.sessions.length,0);$('sessCount').textContent=total?T('sessCount').replace('{shown}',shown).replace('{total}',total):'';if(!total){tree.innerHTML='<div class="empty-state"><p>'+esc(T('sessionsEmpty'))+'</p></div>';if(delAllBtn)delAllBtn.style.display='none';setSessionsStatus('','');return}if(delAllBtn)delAllBtn.style.display='';if(!shown){tree.innerHTML='<p class="hint">'+esc(T('sessionsNoMatch'))+'</p>';return}let html='';for(const proj of projects){html+='<div class="sess-project">'+esc(proj.cwdHint||proj.dir)+'</div>';for(const sess of proj.sessions){const ts=sess.timestamp?new Date(sess.timestamp).toLocaleString():sess.mtime?new Date(sess.mtime).toLocaleString():'';html+='<div class="sess-item'+(sess.file===selectedSessionFile?' selected':'')+'" data-file="'+esc(sess.file)+'">';html+='<input class="sess-check" type="checkbox" aria-label="select" data-check="'+esc(sess.file)+'"'+(selectedSessions.has(sess.file)?' checked':'')+'>';html+='<div class="sess-summary">'+esc(sess.summary||sess.id||sess.fileName||'')+'</div>';html+='<div class="sess-meta">'+esc(ts)+' · '+sess.messageCount+' '+T('sessMsgs')+' · '+fmtSize(sess.size)+'</div>';html+='<button class="sess-del" data-del="'+esc(sess.file)+'" type="button">'+T('sessDel')+'</button>';html+='</div>'}}tree.innerHTML=html;tree.querySelectorAll('.sess-del').forEach(btn=>btn.onclick=async(e)=>{e.stopPropagation();const f=btn.getAttribute('data-del');const ok=await confirmDialog(T('sessDel'),T('sessDeleteConfirm'),T('modalConfirm'));if(!ok)return;try{const r=await apiFetch('/api/sessions/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({file:f})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('sessDeleteFailed'));setSessionsStatus('ok',T('sessDeleted'));loadSessions()}catch(err){setSessionsStatus('err',err.message)}});tree.querySelectorAll('.sess-check').forEach(cb=>cb.onclick=e=>{e.stopPropagation();const f=cb.getAttribute('data-check');if(cb.checked)selectedSessions.add(f);else selectedSessions.delete(f);updateSessionSelectionUI()});tree.querySelectorAll('.sess-item').forEach(item=>{item.tabIndex=0;item.setAttribute('role','button');item.onkeydown=e=>{if(e.target!==item||!['Enter',' '].includes(e.key))return;e.preventDefault();item.click()};item.onclick=()=>readSessionDetail(item.getAttribute('data-file'))});updateSessionSelectionUI()}function updateSessionSelectionUI(){const n=selectedSessions.size;const btn=$('sessDeleteSelected');btn.disabled=!n;btn.textContent=n?T('sessDeleteSelected').replace('{n}',n):T('sessDeleteSelectedZero');$('sessSelCount').textContent=n?T('sessSelCount').replace('{n}',n):'';const hint=$('exportSessionsHint');if(hint)hint.textContent=n?T('exportSessionsHint').replace('{n}',n):''}function shownSessionFiles(){const out=[];for(const proj of filterSessionsCache())for(const sess of proj.sessions)out.push(sess.file);return out}function deleteSelectedSessions(){const files=[...selectedSessions];if(!files.length)return;confirmDialog(T('sessDeleteSelected').replace('{n}',files.length),T('sessDeleteBatchConfirm').replace('{n}',files.length),T('modalConfirm'),'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>').then(ok=>{if(!ok)return;const delBtn=$('sessDeleteSelected');const delAllBtn=$('sessDeleteAll');delBtn.disabled=true;delAllBtn.disabled=true;apiFetch('/api/sessions/delete-batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({files})}).then(r=>r.json()).then(j=>{if(!j||j.error)throw new Error(j&&j.error?j.error:T('sessDeleteFailed'));for(const f of files)selectedSessions.delete(f);let msg=T('sessDeletedBatch').replace('{n}',j.deleted);if(j.failed&&j.failed.length){msg+=' / '+T('sessDeleteBatchFailed').replace('{n}',j.failed.length)+' ('+j.failed.slice(0,3).map(f=>f.file).join(', ')+(j.failed.length>3?'…':'')+')'}setSessionsStatus(j.failed&&j.failed.length?'err':'ok',msg);loadSessions()}).catch(err=>{setSessionsStatus('err',err.message)}).finally(()=>{updateSessionSelectionUI();delAllBtn.disabled=false})})}function showSessionDetail(){$('sessionsTree').style.display='none';$('sessionsDetail').style.display='block'}function hideSessionDetail(){$('sessionsDetail').style.display='none';$('sessionsTree').style.display='';selectedSessionFile='';const items=$('sessionsTree').querySelectorAll('.sess-item.selected');items.forEach(el=>el.classList.remove('selected'))}async function copySessionText(text){try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return true}}catch{}try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.top='-9999px';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();return ok}catch{return false}}function bindSessionCopyButtons(){const detail=$('sessionsDetail');detail.querySelectorAll('.sess-copy').forEach(btn=>btn.onclick=async()=>{const idx=Number(btn.getAttribute('data-copy'));const m=detailMessages[idx];if(!m)return;const ok=await copySessionText(m.text||m.thinking||m.toolInput||'');btn.textContent=ok?T('sessCopied'):T('sessCopy');if(ok)setTimeout(()=>{btn.textContent=T('sessCopy')},1200)})}function renderSessionMessage(msg,idx){const ts=msg.timestamp?new Date(msg.timestamp).toLocaleString():'';let html='<div class="sess-msg msg-'+esc(msg.role)+'"><div class="msg-head"><span class="role role-'+esc(msg.role)+'">'+esc(msg.role)+'</span>';if(ts)html+='<span class="msg-ts">'+esc(ts)+'</span>';html+='<button class="sess-copy" type="button" data-copy="'+idx+'">'+T('sessCopy')+'</button></div>';if(msg.thinking)html+='<details class="sess-thinking"><summary>'+esc(T('sessThinking'))+'</summary><div>'+esc(msg.thinking)+(msg.thinkingTruncated?T('sessTruncated'):'')+'</div></details>';if(msg.toolResult){html+='<details class="sess-tool"><summary>'+esc(T('sessToolResult'))+'</summary><div>'+esc(msg.text||'')+(msg.truncated?T('sessTruncated'):'')+'</div></details>'}else if(msg.text){html+='<div class="msg-text">'+esc(msg.text)+(msg.truncated?T('sessTruncated'):'')+'</div>'}if(msg.toolUse)html+='<details class="sess-tool"><summary>'+esc(T('sessToolUse').replace('{name}',msg.toolUse))+'</summary><div>'+esc(msg.toolInput)+(msg.toolInputTruncated?T('sessTruncated'):'')+'</div></details>';return html+'</div>'}function updateLoadMore(file){const more=$('sessMore');if(!more)return;const shown=detailMessages.length;if(detailTotal>shown){more.innerHTML='<div class="sess-load-more"><button type="button" id="sessLoadMore">'+T('sessLoadMore').replace('{n}',detailTotal-shown)+'</button></div>';$('sessLoadMore').onclick=()=>readSessionDetail(file,shown)}else{more.innerHTML=''}}async function readSessionDetail(file,skip){skip=skip||0;selectedSessionFile=file;const detail=$('sessionsDetail');if(skip===0){detailSkip=0;detailMessages=[];detailTotal=0;showSessionDetail();detail.innerHTML='<div class="sess-detail-head"><button class="sess-back" id="sessBack" type="button">'+T('sessBack')+'</button><button class="btn secondary sess-copy-all" id="sessCopyAll" type="button">'+T('sessCopyAll')+'</button></div><div class="sess-detail-meta" id="sessDetailMeta"></div><div id="sessMsgs"></div><div id="sessMore"></div>';$('sessBack').onclick=hideSessionDetail;$('sessCopyAll').onclick=async()=>{const text=detailMessages.map(m=>'['+m.role+'] '+(m.text||m.thinking||'')).join('\\n\\n');const ok=await copySessionText(text);setSessionsStatus(ok?'ok':'err',ok?T('sessCopied'):T('sessCopy'))}}const msgs=$('sessMsgs');if(!msgs)return;if(skip===0)msgs.innerHTML='<p class="hint">'+esc(T('sessLoadingDetail'))+'</p>';try{const r=await apiFetch('/api/sessions/read?file='+encodeURIComponent(file)+(skip?'&skip='+skip:''));const j=await r.json();if(!r.ok)throw new Error(j.error||T('sessReadFailed'));detailSkip=skip;detailTotal=j.total||j.messages.length;if(skip===0){detailMessages=j.messages.slice();msgs.innerHTML=j.messages.length?j.messages.map((m,i)=>renderSessionMessage(m,i)).join(''):'<p class="hint">'+esc(T('sessNoMessages'))+'</p>';if(j.session){$('sessDetailMeta').textContent=[j.session.cwd,j.session.id,j.timestamp?new Date(j.session.timestamp).toLocaleString():'',j.total+' '+T('sessMsgs')].filter(Boolean).join(' · ')}}else{const base=detailMessages.length;for(const m of j.messages)detailMessages.push(m);msgs.insertAdjacentHTML('beforeend',j.messages.map((m,i)=>renderSessionMessage(m,base+i)).join(''))}bindSessionCopyButtons();updateLoadMore(file);try{const it=$('sessionsTree').querySelector('.sess-item[data-file="'+CSS.escape(file)+'"]');if(it)it.classList.add('selected')}catch{}}catch(e){if(skip===0)msgs.innerHTML='<p class="hint" style="color:var(--err)">'+esc(e.message)+'</p>';setSessionsStatus('err',e.message)}}
const HISTORY_I18N={en:{globalTitle:'Global prompts',globalHint:'Shared across every project. Global prompts can only be removed one by one.',globalBadge:'Global',setGlobal:'Set global',setGlobalConfirm:'Move this prompt to global history? It will become available in every project.',setGlobalDone:'Prompt moved to global history.',globalDeleteConfirm:'Remove this global prompt? This cannot be undone.',deleteProjects:'Delete project history',deleteProjectsConfirm:'Delete ALL project prompt history? Global prompts will be kept.'},ja:{globalTitle:'グローバルプロンプト',globalHint:'すべてのプロジェクトで共有されます。グローバルプロンプトは一件ずつ削除できます。',globalBadge:'グローバル',setGlobal:'グローバルにする',setGlobalConfirm:'このプロンプトをグローバル履歴へ移動しますか？すべてのプロジェクトで利用できます。',setGlobalDone:'プロンプトをグローバル履歴へ移動しました。',globalDeleteConfirm:'このグローバルプロンプトを削除しますか？この操作は元に戻せません。',deleteProjects:'プロジェクト履歴を削除',deleteProjectsConfirm:'すべてのプロジェクトプロンプト履歴を削除しますか？グローバルプロンプトは保持されます。'},zh:{globalTitle:'全局提示词',globalHint:'在所有项目间共享。全局提示词只能逐条移除。',globalBadge:'全局',setGlobal:'设为全局',setGlobalConfirm:'将此提示词移入全局历史？之后可在所有项目中使用。',setGlobalDone:'提示词已移入全局历史。',globalDeleteConfirm:'移除此全局提示词？此操作不可撤销。',deleteProjects:'删除项目历史',deleteProjectsConfirm:'删除全部项目提示词历史？全局提示词将被保留。'}};
function TH(key){return HISTORY_I18N[currentLang]&&HISTORY_I18N[currentLang][key]||key}
const GLOBAL_HISTORY_DIR='__global__';
function isGlobalHistoryProject(project){return project&&(project.scope==='global'||project.dir===GLOBAL_HISTORY_DIR)}
function setHistoryStatus(type,msg){const el=$('historyStatus');el.className='status '+type;el.textContent=msg;if(type==='ok')scheduleClear(el,'historyStatus')}
let historyCache=[];
const selectedHistory=new Set();
function historyKey(project,index){return project+'::'+index}
function splitHistoryKey(key){const i=key.lastIndexOf('::');return[key.slice(0,i),key.slice(i+2)]}
function shownHistoryKeys(){const out=[];for(const proj of filterHistoryCache()){if(isGlobalHistoryProject(proj))continue;for(const e of proj.entries)out.push(historyKey(proj.dir,e.index))}return out}
async function loadPromptHistory(){setHistoryStatus('',T('historyLoading'));try{const r=await apiFetch('/api/prompt-history');const j=await r.json();if(!r.ok)throw new Error(j.error||T('historyLoadFailed'));historyCache=j.projects||[];const stale=[...selectedHistory].filter(k=>{const p=splitHistoryKey(k);const proj=historyCache.find(x=>x.dir===p[0]);return !proj||isGlobalHistoryProject(proj)||!proj.entries.some(e=>e.index===Number(p[1]))});stale.forEach(k=>selectedHistory.delete(k));renderHistoryTree()}catch(e){setHistoryStatus('err',e.message)}}
function filterHistoryCache(){const q=($('histSearch').value||'').trim().toLowerCase();if(!q)return historyCache;const out=[];for(const proj of historyCache){const ms=proj.entries.filter(e=>String(e.text||'').toLowerCase().includes(q)||String(proj.cwdHint||proj.dir||'').toLowerCase().includes(q));if(ms.length)out.push({dir:proj.dir,cwdHint:proj.cwdHint,scope:proj.scope,duplicates:proj.duplicates,total:proj.total,entries:ms})}return out}
function historyEntryMeta(entry,project){return entry.length+' '+T('historyChars')+(entry.truncated?T('sessTruncated'):'')+(project&&project.duplicates?' · '+T('histDupBadge').replace('{n}',project.duplicates):'')}
function renderHistoryTree(){const groups=filterHistoryCache();const tree=$('histTree');const delAllBtn=$('histDeleteAll');const globalGroups=groups.filter(isGlobalHistoryProject);const projectGroups=groups.filter(p=>!isGlobalHistoryProject(p));const total=historyCache.reduce((n,p)=>n+p.entries.length,0);const shown=groups.reduce((n,p)=>n+p.entries.length,0);const projectTotal=historyCache.filter(p=>!isGlobalHistoryProject(p)).reduce((n,p)=>n+p.entries.length,0);$('histCount').textContent=total?T('sessCount').replace('{shown}',shown).replace('{total}',total):'';if(delAllBtn){delAllBtn.textContent=TH('deleteProjects');delAllBtn.style.display=projectTotal?'':'none'}if(!total){tree.innerHTML='<div class="empty-state"><p>'+esc(T('historyEmpty'))+'</p></div>';setHistoryStatus('','');updateHistorySelectionUI();return}if(!shown){tree.innerHTML='<div class="empty-state"><p>'+esc(T('historyNoMatch'))+'</p></div>';updateHistorySelectionUI();return}let html='';for(const proj of globalGroups){html+='<div class="sess-project"><span class="sess-proj-name">'+esc(TH('globalTitle'))+'</span><span class="sess-meta">'+esc(TH('globalHint'))+'</span></div>';for(const e of proj.entries){html+='<div class="sess-item" data-global-index="'+e.index+'">';html+='<div class="sess-summary">'+esc(e.text||'')+'</div>';html+='<div class="sess-meta">'+esc(historyEntryMeta(e,proj))+' · '+esc(TH('globalBadge'))+'</div>';html+='<button class="sess-del" data-global-del="'+e.index+'" type="button">'+T('sessDel')+'</button>';html+='</div>'}}for(const proj of projectGroups){const pkeys=proj.entries.map(function(e){return historyKey(proj.dir,e.index)});const pAll=pkeys.length&&pkeys.every(function(k){return selectedHistory.has(k)});html+='<div class="sess-project"><span class="sess-proj-name">'+esc(proj.cwdHint||proj.dir)+'</span><button class="hist-proj-toggle" type="button" data-project="'+esc(proj.dir)+'">'+T(pAll?'histUnselectProject':'histSelectProject')+'</button></div>';for(const e of proj.entries){const k=historyKey(proj.dir,e.index);html+='<div class="sess-item" data-key="'+esc(k)+'">';html+='<input class="sess-check" type="checkbox" aria-label="select" data-check="'+esc(k)+'"'+(selectedHistory.has(k)?' checked':'')+'>';html+='<div class="sess-summary">'+esc(e.text||'')+'</div>';html+='<div class="sess-meta">'+esc(historyEntryMeta(e,proj))+'</div>';html+='<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px"><button class="hist-globalize" style="height:28px;border-radius:8px;border:1px solid var(--badgeLine);background:var(--badgeBg);color:var(--badgeText);font-size:11px;padding:0 9px;cursor:pointer" data-globalize="'+esc(k)+'" type="button">'+esc(TH('setGlobal'))+'</button><button class="sess-del" style="position:static;transform:none" data-del="'+esc(k)+'" type="button">'+T('sessDel')+'</button></div>';html+='</div>'}}tree.innerHTML=html;tree.querySelectorAll('.hist-globalize').forEach(btn=>btn.onclick=async(e)=>{e.stopPropagation();const key=btn.getAttribute('data-globalize');const ok=await confirmDialog(TH('setGlobal'),TH('setGlobalConfirm'),TH('setGlobal'));if(!ok)return;const p=splitHistoryKey(key);try{const r=await apiFetch('/api/prompt-history/global/promote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:p[0],index:Number(p[1])})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('historyDeleteFailed'));setHistoryStatus('ok',TH('setGlobalDone'));loadPromptHistory()}catch(err){setHistoryStatus('err',err.message)}});tree.querySelectorAll('.sess-del[data-global-del]').forEach(btn=>btn.onclick=async(e)=>{e.stopPropagation();const index=Number(btn.getAttribute('data-global-del'));const ok=await confirmDialog(TH('globalTitle'),TH('globalDeleteConfirm'),T('modalConfirm'));if(!ok)return;try{const r=await apiFetch('/api/prompt-history/global/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({index})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('historyDeleteFailed'));setHistoryStatus('ok',T('histDeleted'));loadPromptHistory()}catch(err){setHistoryStatus('err',err.message)}});tree.querySelectorAll('.sess-del[data-del]').forEach(btn=>btn.onclick=async(e)=>{e.stopPropagation();const key=btn.getAttribute('data-del');const ok=await confirmDialog(T('historyTitle'),T('histDeleteConfirm'),T('modalConfirm'));if(!ok)return;const p=splitHistoryKey(key);try{const r=await apiFetch('/api/prompt-history/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:p[0],index:Number(p[1])})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('historyDeleteFailed'));setHistoryStatus('ok',T('histDeleted'));loadPromptHistory()}catch(err){setHistoryStatus('err',err.message)}});tree.querySelectorAll('.hist-proj-toggle').forEach(btn=>btn.onclick=function(e){e.stopPropagation();const dir=btn.getAttribute('data-project');const keys=shownHistoryKeys().filter(function(k){return splitHistoryKey(k)[0]===dir});if(!keys.length)return;const all=keys.every(function(k){return selectedHistory.has(k)});if(all)keys.forEach(function(k){selectedHistory.delete(k)});else keys.forEach(function(k){selectedHistory.add(k)});renderHistoryTree()});tree.querySelectorAll('.sess-check').forEach(cb=>cb.onclick=e=>{e.stopPropagation();const key=cb.getAttribute('data-check');if(cb.checked)selectedHistory.add(key);else selectedHistory.delete(key);updateHistorySelectionUI()});tree.querySelectorAll('.sess-item[data-key]').forEach(item=>item.onclick=()=>{const cb=item.querySelector('.sess-check');if(!cb)return;cb.checked=!cb.checked;if(cb.checked)selectedHistory.add(cb.getAttribute('data-check'));else selectedHistory.delete(cb.getAttribute('data-check'));updateHistorySelectionUI()});updateHistorySelectionUI()}
function updateHistorySelectionUI(){const n=selectedHistory.size;const btn=$('histDeleteSelected');if(!btn)return;btn.disabled=!n;btn.textContent=n?T('sessDeleteSelected').replace('{n}',n):T('sessDeleteSelectedZero');$('histSelCount').textContent=n?T('sessSelCount').replace('{n}',n):'';const tree=$('histTree');if(tree)tree.querySelectorAll('.hist-proj-toggle').forEach(function(btn){const dir=btn.getAttribute('data-project');const keys=shownHistoryKeys().filter(function(k){return splitHistoryKey(k)[0]===dir});const all=keys.length&&keys.every(function(k){return selectedHistory.has(k)});btn.textContent=T(all?'histUnselectProject':'histSelectProject')})}
function deleteSelectedHistory(){const keys=[...selectedHistory];if(!keys.length)return;confirmDialog(T('sessDeleteSelected').replace('{n}',keys.length),T('histDeleteBatchConfirm').replace('{n}',keys.length),T('modalConfirm'),'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>').then(ok=>{if(!ok)return;const groups=new Map();for(const key of keys){const p=splitHistoryKey(key);if(!groups.has(p[0]))groups.set(p[0],[]);groups.get(p[0]).push(Number(p[1]))}const jobs=[...groups.entries()].map(entry=>apiFetch('/api/prompt-history/delete-batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({project:entry[0],indexes:entry[1]})}).then(r=>r.json().then(j=>{if(!r.ok)throw new Error(j.error||T('historyDeleteFailed'));return j})));const delBtn=$('histDeleteSelected');const delAllBtn=$('histDeleteAll');delBtn.disabled=true;delAllBtn.disabled=true;Promise.allSettled(jobs).then(settled=>{let deleted=0,failed=0;for(const s of settled){if(s.status==='fulfilled')deleted+=s.value.deleted;else failed+=1}let msg=T('histDeletedBatch').replace('{n}',deleted);if(failed)msg+=' / '+T('histDeleteBatchFailed').replace('{n}',failed);setHistoryStatus(failed?'err':'ok',msg);loadPromptHistory()}).catch(err=>{setHistoryStatus('err',err.message)}).finally(()=>{updateHistorySelectionUI();delAllBtn.disabled=false})})}
$('saveRetry').onclick=saveRetry;$('saveSteering').onclick=saveSteering;$('toggleKey').onclick=()=>{$('apiKey').type=$('apiKey').type==='password'?'text':'password';$('toggleKey').ariaPressed=String($('apiKey').type==='text')};$('baseUrl').addEventListener('change',()=>{try{const u=new URL($('baseUrl').value.trim()); if(!$('providerName').value) $('providerName').value=u.hostname.replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()}catch{}});providerLastValid.reasoningEffort=providerDefaults.reasoningEffort;$('addModel').onclick=function(){addModel($('model').value)};$('promptScope').onchange=loadSystemPrompt;$('promptMode').onchange=()=>{updatePlanUi();loadSystemPrompt()};$('savePrompt').onclick=saveSystemPrompt;$('diffToggle').onclick=togglePromptDiff;$('langSelect').onchange=async()=>{const nv=$('langSelect').value;try{await apiFetch('/api/language',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({language:nv})});currentLang=nv;applyI18n();updatePlanUi()}catch{}};$('exportProviders').onclick=async()=>{try{const files=[...selectedSessions];const r=await apiFetch('/api/providers/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(files.length?{files}:{})});if(!r.ok){const j=await r.json().catch(()=>null);throw new Error(j&&j.error?j.error:T('exportFailed'))}const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]||'axum-providers.json';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(a.href);setStatus('ok',T('exported'));}catch(e){setStatus('err',e.message)}};$('importProviders').onclick=()=>$('importFile').click();$('importFile').onchange=async(e)=>{const file=e.target.files[0];if(!file)return;try{const text=await file.text();const config=JSON.parse(text);if(!config||!config.providers)throw new Error('Invalid provider config: missing providers');const r=await apiFetch('/api/providers/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({config,overwrite:true})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('importFailed'));let importMsg=T('importOkPrefix')+j.added+T('importOkMid')+j.replaced+T('importOkMid2')+j.skipped+T('importOkSuffix')+j.total;if(j.rejected)importMsg+=T('importOkRejected')+j.rejected;if(j.defaultRestored)importMsg+=T('importOkDefault');if(j.sessions){importMsg+=' · '+T('importSessionsOk').replace('{a}',j.sessions.added).replace('{r}',j.sessions.replaced).replace('{s}',j.sessions.skipped);if(j.sessions.failed&&j.sessions.failed.length)importMsg+=' / '+T('importSessionsFailed').replace('{n}',j.sessions.failed.length)}if(j.promptHistory){importMsg+=' · '+T('importPromptHistoryOk').replace('{a}',j.promptHistory.added).replace('{r}',j.promptHistory.replaced).replace('{s}',j.promptHistory.skipped);if(j.promptHistory.failed&&j.promptHistory.failed.length)importMsg+=' / '+T('importSessionsFailed').replace('{n}',j.promptHistory.failed.length)}setStatus('ok',importMsg);if(typeof loadExisting==='function')loadExisting();if(j.sessions&&(j.sessions.added||j.sessions.replaced))loadSessions();if(j.promptHistory&&(j.promptHistory.added||j.promptHistory.replaced))loadPromptHistory();}catch(e){setStatus('err',e.message)}finally{e.target.value=''}};
$('histSearch').addEventListener('input',()=>renderHistoryTree());$('histRefresh').onclick=()=>loadPromptHistory();$('histSelectAll').onclick=()=>{shownHistoryKeys().forEach(k=>selectedHistory.add(k));renderHistoryTree()};$('histClearSelection').onclick=()=>{selectedHistory.clear();renderHistoryTree()};$('histDeleteSelected').onclick=deleteSelectedHistory;$('histDeleteAll').onclick=async()=>{const ok=await confirmDialog(TH('deleteProjects'),TH('deleteProjectsConfirm'),T('modalConfirm'),'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>');if(!ok)return;try{const r=await apiFetch('/api/prompt-history/delete-all',{method:'POST',headers:{'content-type':'application/json'}});const j=await r.json();if(!r.ok)throw new Error(j.error||T('histDeleteAllFailed'));setHistoryStatus('ok',T('histDeletedAll').replace('{n}',j.deleted));selectedHistory.clear();loadPromptHistory()}catch(err){setHistoryStatus('err',err.message)}};
$('newProvider').onclick=newProviderForm;$('save').onclick=async()=>{const models=currentModels.map(function(id){return {id:id,default:id===currentDefaultId,reasoningEffort:currentModelEfforts.get(id)??providerLastValid.reasoningEffort}});if(!models.length){setStatus('err',T('modelRequired'));return}if(!$('apiKey').value.trim()){setStatus('err',T('apiKeyRequired'));return}$('save').disabled=true;try{const r=await apiFetch('/api/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api:currentApiForm(),baseUrl:$('baseUrl').value,apiKey:$('apiKey').value.trim(),models:models,name:$('providerName').value,originalName:loadedProvider?loadedProvider.id:'',...(loadedProvider?{}:{maxTokens:providerLastValid.maxTokens}),fastMode:$('fastMode').checked,defaultModel:currentDefaultId})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('saveFailed'));step('s3','done',T('saveAsDefaultDone'));$('apiKey').type='password';$('toggleKey').ariaPressed='false';setStatus('ok',T('promptSavedOk'));await loadExisting()}catch(e){step('s3','err','保存に失敗');setStatus('err',e.message)}finally{$('save').disabled=false}};async function loadCommandSettings(){try{const r=await apiFetch('/api/commands');const j=await r.json();if(r.ok){$('retainCommands').checked=j.retainTemporaryCommands||false}}catch{}}function setCommandStatus(type,msg){const el=$('commandsStatus');el.className='status '+type;el.textContent=msg}
async function saveCommandSettings(){try{const r=await apiFetch('/api/commands/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({retainTemporaryCommands:$('retainCommands').checked})});const j=await r.json();if(!r.ok)throw new Error(j.error||T('commandsFailed'));setCommandStatus('ok',T('commandsSaved'))}catch(e){setCommandStatus('err',e.message)}}async function loadLang(){try{const r=await apiFetch('/api/language');const j=await r.json();if(r.ok&&j.language){currentLang=j.language;$('langSelect').value=currentLang;applyI18n()}}catch{}}initCombo();const _fetchDebounce=(ms,fn)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}};const _autoFetch=_fetchDebounce(350,async()=>await fetchModelsAction());$('baseUrl').addEventListener('change',()=>_autoFetch());$('apiKey').addEventListener('change',()=>_autoFetch());$('testModels').onclick=testModelsAction;$('sessDeleteAll').onclick=async()=>{const ok=await confirmDialog(T('sessDeleteAll'),T('sessDeleteAllConfirm'),T('modalConfirm'),'<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>');if(!ok)return;try{const r=await apiFetch('/api/sessions/delete-all',{method:'POST',headers:{'content-type':'application/json'}});const j=await r.json();if(!r.ok)throw new Error(j.error||T('sessDeleteAllFailed'));setSessionsStatus('ok',T('sessDeletedAll').replace('{n}',j.deleted)+' / '+j.total);loadSessions()}catch(err){setSessionsStatus('err',err.message)}};$('sessSearch').addEventListener('input',()=>renderSessionsTree());$('sessRefresh').onclick=()=>loadSessions();$('sessSelectAll').onclick=()=>{shownSessionFiles().forEach(f=>selectedSessions.add(f));renderSessionsTree()};$('sessClearSelection').onclick=()=>{selectedSessions.clear();renderSessionsTree()};$('sessDeleteSelected').onclick=deleteSelectedSessions;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('confirmModal').hidden&&$('sessionsPanel').classList.contains('active')&&$('sessionsDetail').style.display!=='none')hideSessionDetail()});
const savedTheme=(()=>{try{return localStorage.getItem('axumTheme')}catch{return null}})();
function applyTheme(value){if(value==='light'||value==='dark')document.documentElement.dataset.theme=value;else delete document.documentElement.dataset.theme}
applyTheme(savedTheme);$('themeSelect').value=['light','dark'].includes(savedTheme)?savedTheme:'system';
$('themeSelect').onchange=()=>{const value=$('themeSelect').value;applyTheme(value);try{localStorage.setItem('axumTheme',value)}catch{}};
const tablist=document.querySelector('[role="tablist"]');const compactNav=matchMedia('(max-width:760px)');
function syncTabOrientation(){tablist.setAttribute('aria-orientation',compactNav.matches?'horizontal':'vertical')}
syncTabOrientation();compactNav.addEventListener('change',syncTabOrientation);
tablist.addEventListener('keydown',event=>{
  const tab=event.target.closest('[role="tab"]');if(!tab)return;
  const tabs=Array.from(tablist.querySelectorAll('[role="tab"]'));const index=tabs.indexOf(tab);let next;
  if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;
  else if(event.key===(compactNav.matches?'ArrowRight':'ArrowDown'))next=(index+1)%tabs.length;
  else if(event.key===(compactNav.matches?'ArrowLeft':'ArrowUp'))next=(index+tabs.length-1)%tabs.length;else return;
  event.preventDefault();tabs[next].click();tabs[next].focus();tabs[next].scrollIntoView({block:'nearest',inline:'nearest'});
});
$('saveCommands').onclick=saveCommandSettings;
for(const id of ['save','savePrompt','saveRetry','saveSteering','saveCommands']){
  const button=$(id);const handler=button.onclick;
  button.onclick=async event=>{
    if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');
    try{await handler.call(button,event)}finally{button.disabled=false;button.setAttribute('aria-busy','false')}
  };
}

loadLang();loadExisting();loadCommandSettings();loadSystemPrompt();</script></body></html>`;
}

export async function startProviderWeb(options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 0);
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page(token));
        return;
      }
      if (req.headers["x-axum-token"] !== token) return json(res, 403, { error: "invalid token" });
      if (req.method === "GET" && url.pathname === "/api/commands") {
        const settings = getCommandRetentionSettings();
        return json(res, 200, settings);
      }
      if (req.method === "POST" && url.pathname === "/api/commands/save") {
        const body = await readJson(req);
        const result = saveCommandRetentionSettings(body.retainTemporaryCommands);
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const defaults = getDefaultProviderSelection() || {};
        const fastModels = readFastModels();
        const providers = listProviders(undefined, { includeSecrets: true }).map((p) => ({ ...p, fastMode: p.models.length > 0 && p.models.every((id) => fastModels[p.id]?.includes(id)) }));
        return json(res, 200, { providers, defaultProvider: defaults.provider, defaultModel: defaults.model, defaultThinkingLevel: defaults.thinkingLevel || DEFAULT_THINKING_LEVEL });
      }
      if (req.method === "POST" && url.pathname === "/api/providers/max-tokens") {
        const result = saveProviderMaxTokens(await readJson(req));
        return json(res, 200, { ok: true, ...result });
      }
      if (req.method === "POST" && url.pathname === "/api/providers/clone") {const body = await readJson(req);if (!body.name || !String(body.name).trim()) throw new Error("Provider name is required");const result = cloneProvider(String(body.name).trim());return json(res, 200, { ok: true, name: result.name, source: result.source, provider: result.provider });}
      if (req.method === "POST" && url.pathname === "/api/providers/delete") {const body = await readJson(req);if (!body.name || !String(body.name).trim()) throw new Error("Provider name is required");const result = deleteProvider(String(body.name).trim());return json(res, 200, { ok: true, name: result.name, deleted: result.deleted });}
      if (req.method === "POST" && url.pathname === "/api/providers/default") {const body = await readJson(req);if (!body.provider || !body.model) throw new Error("Provider and model are required");const result = saveDefaultProviderSelection({ provider: String(body.provider).trim(), model: String(body.model).trim(), thinkingLevel: body.thinkingLevel ?? listProviders().find((p) => p.id === body.provider)?.modelConfigs.find((m) => m.id === body.model)?.reasoningEffort ?? DEFAULT_THINKING_LEVEL });return json(res, 200, { ok: true, provider: result.config.defaultProvider, model: result.config.defaultModel, file: result.file });}
      if (req.method === "GET" && url.pathname === "/api/providers/export") {
        const config = exportProviders();
        config.promptHistory = exportPromptHistory({ env: process.env }).items;
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="axum-providers-${stamp}.json"` });
        res.end(JSON.stringify(config, null, 2));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/providers/export") {
        const body = await readJson(req);
        const config = exportProviders();
        const files = Array.isArray(body.files) ? body.files.map((f) => String(f)).filter(Boolean) : [];
        if (files.length) config.sessions = exportSessions({ files, env: process.env }).sessions;
        config.promptHistory = exportPromptHistory({ env: process.env }).items;
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="axum-providers-${stamp}.json"` });
        res.end(JSON.stringify(config, null, 2));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/providers/import") {
        const body = await readJson(req);
        const result = importProviders({ config: body.config, overwrite: Boolean(body.overwrite) });
        const sessions = Array.isArray(body.config?.sessions) ? body.config.sessions : [];
        if (sessions.length) result.sessions = importSessions({ sessions, env: process.env, overwrite: Boolean(body.overwrite) });
        const historyItems = Array.isArray(body.config?.promptHistory) ? body.config.promptHistory : [];
        if (historyItems.length) result.promptHistory = importPromptHistory({ items: historyItems, env: process.env, overwrite: Boolean(body.overwrite) });
        return json(res, 200, result);
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
      if (req.method === "POST" && url.pathname === "/api/system-prompt/delete") {
        const body = await readJson(req);
        const prompt = deleteSystemPromptFile({ scope: body.scope || "global", mode: body.mode || "append", cwd: options.cwd, env: process.env });
        return json(res, 200, prompt);
      }
      if (req.method === "GET" && url.pathname === "/api/retry") {
        return json(res, 200, getRetrySettings());
      }
      if (req.method === "GET" && url.pathname === "/api/settings") {
        const result = readSettingsRaw();
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/retry/save") {
        const body = await readJson(req);
        const result = saveRetrySettings({ enabled: body.enabled, maxRetries: body.maxRetries, baseDelayMs: body.baseDelayMs, fixedDelayMs: body.fixedDelayMs });
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/api/steering") {
        return json(res, 200, getSteeringMode());
      }
      if (req.method === "POST" && url.pathname === "/api/steering/save") {
        const body = await readJson(req);
        const result = saveSteeringMode(body.mode);
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/models") {
        const body = await readJson(req);
        if (!String(body.apiKey || "").trim()) throw new Error("API Key is required");
        const form = String(body.api || DEFAULT_API_FORM);
        if (form !== "openai-completions" && form !== "openai-responses") throw new Error("Model listing is only available for the OpenAI-compatible and Responses API forms");
        const models = await fetchOpenAICompatibleModels({ baseUrl: body.baseUrl, apiKey: body.apiKey });
        return json(res, 200, { models });
      }
      if (req.method === "POST" && url.pathname === "/api/models/test") {
        const body = await readJson(req);
        const list = Array.isArray(body.models) ? body.models.map((m) => String(m)).filter(Boolean) : [];
        if (!list.length) throw new Error("No models to test");
        const results = await testModelsBatch(list, body.baseUrl, body.apiKey);
        return json(res, 200, { results });
      }
      if (req.method === "GET" && url.pathname === "/api/language") {
        return json(res, 200, { language: getLanguagePreference() });
      }
      if (req.method === "POST" && url.pathname === "/api/language") {
        const body = await readJson(req);
        const result = saveLanguagePreference(body.language);
        return json(res, 200, { ok: true, language: result.language, file: result.file });
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        const body = await readJson(req);
        const rawModels = Array.isArray(body.models) ? body.models : (body.model ? [{ id: body.model, default: true }] : []);
        // The web form no longer ships a Context length field: when editing an
        // existing provider keep each model's on-disk contextWindow (e.g. values
        // set via /ctx); brand-new models fall back to the built-in default.
        const editedName = String(body.originalName || body.name || "").trim();
        const existingProvider = listProviders().find((item) => item.id === editedName);
        const providerMaxTokens = body.maxTokens ?? existingProvider?.maxTokens;
        const existingModels = new Map(
          (existingProvider?.modelConfigs || []).map((m) => [m.id, m]),
        );
        const models = rawModels.map((m) => ({
          id: String(m.id || m.model || "").trim(),
          default: Boolean(m.default),
          input: m.input,
          contextWindow: existingModels.get(String(m.id || m.model || "").trim())?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
          reasoningEffort: m.reasoningEffort ?? m.thinkingLevel ?? body.reasoningEffort ?? existingModels.get(String(m.id || m.model || "").trim())?.reasoningEffort ?? DEFAULT_THINKING_LEVEL,
          maxTokens: providerMaxTokens ?? existingModels.get(String(m.id || m.model || "").trim())?.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
        }));
        if (!models.length || !models[0].id) throw new Error("Model is required");
        const result = upsertProvider({ name: body.name || undefined, baseUrl: body.baseUrl, models, providerMaxTokens, apiKey: body.apiKey, api: body.api, reasoningEffort: body.reasoningEffort || DEFAULT_THINKING_LEVEL, originalName: body.originalName });
        saveFastModels(result.name, models.map((m) => m.id), body.fastMode === true && ["openai-completions", "openai-responses"].includes(result.provider.api), undefined, body.originalName);
        const defaultModel = models.find((m) => m.default)?.id || models[0].id;
        const defaults = saveDefaultProviderSelection({ provider: result.name, model: defaultModel, thinkingLevel: models.find((m) => m.id === defaultModel).reasoningEffort });
        return json(res, 200, { ok: true, provider: result.name, model: defaultModel, modelsPath: result.file, defaultsPath: defaults.file });
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const result = listSessions({ env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/api/sessions/read") {
        const file = url.searchParams.get("file") || "";
        const skip = Number(url.searchParams.get("skip")) || 0;
        const result = readSession({ file, skip, env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/delete") {
        const body = await readJson(req);
        const result = deleteSession({ file: body.file, env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/delete-batch") {
        const body = await readJson(req);
        if (!Array.isArray(body.files) || !body.files.length) throw new Error("files must be a non-empty array");
        const result = deleteSessions({ files: body.files, env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/delete-all") {
        const result = deleteAllSessions({ env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "GET" && url.pathname === "/api/prompt-history") {
        const result = listPromptHistory({ env: process.env });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/prompt-history/global/promote") {
        const body = await readJson(req);
        if (!body.project) throw new Error("project is required");
        const result = promotePromptHistoryEntry({ env: process.env, project: String(body.project), index: Number(body.index) });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/prompt-history/global/delete") {
        const body = await readJson(req);
        const result = deleteGlobalPromptHistoryEntry({ env: process.env, index: Number(body.index) });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/prompt-history/delete") {
        const body = await readJson(req);
        if (!body.project) throw new Error("project is required");
        const result = deletePromptHistoryEntries({ env: process.env, project: String(body.project), indexes: [Number(body.index)] });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/prompt-history/delete-batch") {
        const body = await readJson(req);
        if (!body.project) throw new Error("project is required");
        const indexes = Array.isArray(body.indexes) ? body.indexes.map((i) => Number(i)) : [];
        if (!indexes.length) throw new Error("indexes must be a non-empty array");
        const result = deletePromptHistoryEntries({ env: process.env, project: String(body.project), indexes });
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/prompt-history/delete-all") {
        const result = deleteAllPromptHistory({ env: process.env });
        return json(res, 200, result);
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
  const url = `http://${host}:${address.port}/`;
  const opened = options.openBrowser === false ? false : openBrowser(url, options);
  if (opened) console.log(`Axum provider setup opened in browser: ${url}`);
  else console.log(`Axum provider setup: ${url}`);
  console.log("Press Ctrl+C when finished.");
  return { server, url, opened };
}
