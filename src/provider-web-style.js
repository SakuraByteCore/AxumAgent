// Visual tokens follow Bowl42/agent-ui/src/index.css; no runtime UI dependency.
export const providerWebStyles = `
:root {
  color-scheme:light;
  --bg:oklch(1 0 0);--text:oklch(.205 0 0);--panel:var(--bg);
  --bg2:oklch(.985 0 0);--bg3:var(--bg);--panel2:oklch(.97 0 0);
  --muted:oklch(.49 0 0);--line:oklch(.92 0 0);--accent:var(--text);--accentText:var(--bg);
  --inputBg:var(--bg);--inputText:var(--text);--fieldLine:oklch(.8 0 0);
  --ok:oklch(.448 .119 151.328);--err:oklch(.505 .213 27.518);
  --warn:oklch(.525 .13 58);--warnBg:color-mix(in srgb,var(--warn) 8%,var(--bg));
  --badgeBg:var(--panel2);--badgeText:var(--text);--badgeLine:var(--line);
  --statusOkBg:color-mix(in srgb,var(--ok) 7%,var(--bg));--statusOkText:var(--ok);--statusOkLine:color-mix(in srgb,var(--ok) 25%,var(--bg));
  --statusErrBg:color-mix(in srgb,var(--err) 7%,var(--bg));--statusErrText:var(--err);--statusErrLine:color-mix(in srgb,var(--err) 25%,var(--bg));
  --shadow:rgb(0 0 0 / .12);--radius:10px;--ease:cubic-bezier(.2,0,0,1);
  --mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
}

:root[data-theme="dark"] {
  color-scheme:dark;--bg:oklch(.192 0 0);--text:oklch(.947 0 0);--bg2:oklch(.15 0 0);--panel2:oklch(.262 0 0);
  --muted:oklch(.72 0 0);--line:rgb(255 255 255 / .09);--fieldLine:rgb(255 255 255 / .24);
  --ok:oklch(.78 .17 151.711);--err:oklch(.76 .15 22.216);--warn:oklch(.8 .155 68);--shadow:rgb(0 0 0 / .5);
}

@media(prefers-color-scheme:dark) {
  :root:not([data-theme="light"]) {
    color-scheme:dark;--bg:oklch(.192 0 0);--text:oklch(.947 0 0);--bg2:oklch(.15 0 0);--panel2:oklch(.262 0 0);
    --muted:oklch(.72 0 0);--line:rgb(255 255 255 / .09);--fieldLine:rgb(255 255 255 / .24);
    --ok:oklch(.78 .17 151.711);--err:oklch(.76 .15 22.216);--warn:oklch(.8 .155 68);--shadow:rgb(0 0 0 / .5);
  }

}

*{box-sizing:border-box}
html{background:var(--bg);-webkit-font-smoothing:antialiased;text-size-adjust:100%;-webkit-tap-highlight-color:transparent}

body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 var(--sans)}

button,input,select,textarea{font:inherit;color:inherit}
button,a,summary{touch-action:manipulation}
button{cursor:pointer;user-select:none}

button,input,select,textarea,summary,[tabindex]{transition:background-color 150ms var(--ease),border-color 150ms var(--ease),color 150ms var(--ease)}

button:disabled{cursor:not-allowed;opacity:.45}
button:active:not(:disabled){filter:brightness(.9)}

:focus-visible{outline:2px solid var(--muted);outline-offset:3px}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline-offset:2px}

[hidden]{display:none!important}
a{color:inherit}
svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;flex:none}

h1,h2,h3,p{margin:0}
h1{font-size:22px;line-height:1.3;letter-spacing:-.025em;font-weight:600}
h2{font-size:15px;font-weight:600;letter-spacing:-.01em}
p{color:var(--muted)}
code{font:12px var(--mono);overflow-wrap:anywhere}

.shell{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100dvh}

.sidebar{position:sticky;top:0;height:100dvh;display:flex;flex-direction:column;gap:24px;background:var(--bg2);border-right:1px solid var(--line);padding:24px 16px;overflow-y:auto}

.brand{display:flex;align-items:center;gap:12px;text-decoration:none;padding:0 8px;min-height:44px}
.brand-mark{width:32px;height:32px;display:grid;place-items:center;border-radius:8px;background:var(--text);color:var(--bg)}
.brand-mark svg{width:20px;height:20px}

.brand-name{display:block;font-weight:650;font-size:16px;letter-spacing:-.025em}
.brand-caption{display:block;font-size:12px;color:var(--muted)}

.nav-label{color:var(--muted);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:0 12px;margin-bottom:8px}

.tabs{display:flex;flex-direction:column;gap:4px}
.tab{display:flex;align-items:center;gap:12px;min-height:44px;width:100%;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:var(--muted);text-align:left;font-size:13px;font-weight:500;white-space:nowrap}
.tab.active{background:var(--panel2);color:var(--text);font-weight:600}
.tab svg{width:16px;height:16px}

.sidebar-footer{margin-top:auto;display:grid;gap:12px;padding:16px 8px 0;border-top:1px solid var(--line)}
.sidebar-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sidebar-controls select{width:100%;min-width:0;min-height:44px;background:transparent;border:1px solid var(--line);border-radius:8px;padding:0 8px;font-size:12px}

.local-state{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.local-state:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--ok)}

.main{min-width:0}
.topbar{height:64px;padding:0 40px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}
.breadcrumb{display:flex;gap:12px;align-items:center}
.breadcrumb svg{width:14px;height:14px}
.breadcrumb strong{font-weight:500;color:var(--text)}

.content{max-width:1000px;margin:0 auto;padding:40px 40px 64px}
.page-heading{display:grid;gap:8px;margin-bottom:32px}
.page-heading p{font-size:13px;max-width:68ch}

.tab-panel{display:none}
.tab-panel.active{display:block;min-width:0}
.tab-panel>h2:first-child,.tab-panel>.sess-head>h2{display:none}
.tab-panel>p{margin:0 0 24px;max-width:72ch;font-size:13px}

.form-section{margin:0 0 32px;padding:0 0 28px;border-bottom:1px solid var(--line)}
.section-heading{margin-bottom:16px}
.section-heading p{margin-top:4px;font-size:13px}
.connection-grid,.prompt-row,.provider-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}
.connection-grid .full{grid-column:1/-1}

.field{display:grid;gap:8px;margin:16px 0;min-width:0}
.field label{font-size:13px;font-weight:500;color:var(--text)}
.field input:not([type="checkbox"]):not([type="radio"]),.field select,.sess-search{width:100%;min-width:0;height:44px;border-radius:8px;border:1px solid var(--fieldLine);background:var(--inputBg);color:var(--inputText);padding:0 12px;outline:none}
.field input:focus,.field select:focus,.sess-search:focus{border-color:var(--text);outline:2px solid var(--line);outline-offset:2px}

input[type="checkbox"],input[type="radio"]{accent-color:var(--text);width:18px;height:18px;flex:none}
label:has(input[type="checkbox"]){min-height:44px;align-content:center}
.hint,.secret-note,.test-sum{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.secret-note{line-height:1.5}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.secret-row{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:8px}

.btn,.eye,.combo-fetch,.preset-btn,.test-btn,.sess-refresh,.sess-back,.sess-copy,.sess-copy-all,.diff-toggle,.p-btn,.m-del,.sess-load-more button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:13px;font-weight:500;white-space:nowrap}

.btn,.btn.ok{background:var(--accent);color:var(--accentText);border-color:transparent}
.btn.secondary{background:var(--bg);color:var(--text);border-color:var(--fieldLine)}
.btn.danger,.p-btn.danger,.m-del{background:transparent;color:var(--err);border-color:var(--statusErrLine)}
.btn.danger:disabled{color:var(--muted);border-color:var(--line)}
.eye,.combo-fetch,.m-del{width:44px;padding:0}
.eye svg{width:18px}

.action-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-top:24px}
.action-bar .row{margin:0!important}
.action-bar>.btn{min-width:160px}
.divider{height:1px;background:var(--line);margin:28px 0}
.badge,.m-default{font-size:11px;color:var(--muted)}

.combo{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:8px}
.combo-dropdown{position:absolute;top:calc(100% + 8px);left:0;right:0;z-index:20;max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:4px;box-shadow:0 6px 20px var(--shadow)}
.combo-item{min-height:44px;padding:12px;border-radius:6px;cursor:pointer;font:13px var(--mono);overflow-wrap:anywhere}
.combo-item.active{background:var(--panel2)}
.combo-nomatch,.combo-loading,.combo-error{padding:16px;color:var(--muted);font-size:13px}
.combo-error{color:var(--err)}
.combo-fetch.loading{font-size:0}
.combo-fetch.loading:after{content:"";width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--text);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}
}

.provider-list-wrap{margin-bottom:32px}
.provider-list{display:grid;gap:8px}
.provider-item{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--bg);cursor:pointer}
.provider-item[data-default]{background:var(--bg2)}
.p-id{font-weight:600;font-size:13px;overflow-wrap:anywhere}
.p-meta{flex:1;min-width:120px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.p-actions{display:flex;gap:8px;flex-wrap:wrap}
.p-btn{padding:0 12px;font-size:12px}
.p-tokens{flex-wrap:wrap}
.preset-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 8px}
.preset-label{font-size:12px;color:var(--muted);margin-right:4px}
.preset-btn{font-size:12px;padding:0 12px}

.model-list,.test-list{display:grid;gap:8px;margin-top:8px}
.model-item,.test-item{display:flex;align-items:center;gap:12px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg2)}
.model-item .m-id{flex:1;min-width:0;font:13px var(--mono);overflow-wrap:anywhere}
.model-item select{max-width:38%!important;min-height:44px;border:1px solid var(--fieldLine);font-size:12px}
.m-del{border:0;background:transparent}
.test-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.test-list{max-height:300px;overflow:auto}
.test-item{justify-content:space-between}
.t-name{font:12px var(--mono);overflow-wrap:anywhere;min-width:0}
.t-badge{font-size:11px;white-space:nowrap}
.t-badge.ok{color:var(--ok)}
.t-badge.err{color:var(--err)}
.t-badge.polling{color:var(--muted)}

.status{display:none;margin-top:16px;padding:12px 16px;border:1px solid transparent;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.status.ok{display:block;color:var(--statusOkText);background:var(--statusOkBg);border-color:var(--statusOkLine)}
.status.err{display:block;color:var(--statusErrText);background:var(--statusErrBg);border-color:var(--statusErrLine)}

.side{padding:16px 8px 0;margin-top:8px;border-top:1px solid var(--line)}
.side h2{font-size:12px!important;color:var(--muted);font-weight:500}
.step{display:flex;align-items:center;gap:8px;margin:12px 0;color:var(--muted);font-size:12px}
.step i{width:20px;height:20px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;font-size:10px;font-style:normal}
.step.done i{border-color:var(--ok);color:var(--ok)}
.step.err i{border-color:var(--err);color:var(--err)}
.footer{font-size:11px;line-height:1.5;margin-top:16px;color:var(--muted)}

.prompt-editor,.readonly-viewer,.diff-viewer{width:100%;min-width:0;min-height:280px;max-height:640px;border:1px solid var(--fieldLine);border-radius:8px;background:var(--bg2);color:var(--text);padding:16px;font:13px/1.7 var(--mono);overflow:auto;resize:vertical;tab-size:2;outline-offset:2px}
.prompt-editor{min-height:360px}
.readonly-viewer{white-space:pre}
.readonly-viewer.empty{color:var(--muted)}
.path-box{padding:12px 0;font:12px/1.6 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.diff-viewer{min-height:0;max-height:400px;margin-top:20px;white-space:pre}
.diff-viewer:empty{display:none}
.diff-viewer pre{margin:0;font:inherit}
.diff-add{color:var(--ok)}
.diff-del{color:var(--err)}
.diff-hunk,.diff-meta{font-weight:600;color:var(--muted)}
.readonly-intro{color:var(--warn);background:var(--warnBg);border-radius:8px;padding:12px 16px;font-size:12px;margin:16px 0}

.sess-head{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.sess-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sess-search{flex:1;min-width:180px;max-width:100%}
.sess-refresh{font-size:12px;padding:0 12px}
.sess-count,.sess-sel-count{font-size:12px;color:var(--muted)}
.sess-count{margin-left:auto}
.sess-project{padding:20px 0 8px;font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.hist-proj-toggle{display:flex;align-items:center;gap:8px;width:100%;background:transparent;border:0;padding:0;color:inherit;text-align:left;min-height:44px}
.sess-proj-name{overflow-wrap:anywhere}

.sess-item{position:relative;border-bottom:1px solid var(--line);padding:16px 76px 16px 40px;min-height:80px;cursor:pointer;border-radius:8px}
.sess-item.selected{background:var(--panel2)}
.sess-summary{font-size:13px;font-weight:500;overflow-wrap:anywhere;white-space:pre-wrap}
.sess-meta{font-size:12px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}
.sess-check{position:absolute;left:8px;top:24px;margin:0}
.sess-del{position:absolute;right:0;top:16px;border:0;background:transparent;color:var(--err);min-width:64px;min-height:44px;font-size:12px}
.empty-state{padding:48px 24px;text-align:center;border-radius:10px;margin-top:24px;color:var(--muted)}
.empty-state svg{width:24px;height:24px;margin-bottom:12px}
.empty-state p{font-size:13px}

.sess-detail-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:20px 0 12px}
.sess-detail-meta{color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.sess-copy-all{margin-left:auto}
.sess-msg{padding:24px 0;border-bottom:1px solid var(--line)}
.msg-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.role{font-size:12px;font-weight:600}
.role-user{color:var(--text)}
.role-assistant{color:var(--text)}
.role-system{color:var(--muted)}
.msg-ts{font-size:11px;color:var(--muted)}
.msg-text{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.75 var(--sans)}
.sess-copy{margin-left:auto;min-width:44px;padding:0 12px;font-size:12px}
.sess-thinking,.sess-tool{margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--bg2);font-size:12px}
.sess-thinking summary,.sess-tool summary{min-height:44px;padding:12px;cursor:pointer;color:var(--muted);overflow-wrap:anywhere}
.sess-thinking>div,.sess-tool>div{padding:0 12px 12px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--mono)}
.sess-load-more{display:flex;justify-content:center;margin:24px 0}

.modal-overlay{position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:24px;background:rgb(0 0 0 / .45)}
.modal-card{width:min(420px,100%);padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 24px 64px var(--shadow)}
.modal-icon{color:var(--err);margin-bottom:16px}
.modal-icon svg{width:24px;height:24px}
.modal-title{font-size:17px;font-weight:600;margin-bottom:8px;overflow-wrap:anywhere}
.modal-body{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.modal-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:24px}
.manual{display:none}
.manual.show{display:block}

.hist-globalize{min-height:44px;height:auto!important;font:12px var(--sans)!important}
.commandsStatus{width:100%}

@media(hover:hover) and (pointer:fine){.tab:hover:not(.active),.preset-btn:hover,.combo-item:hover,.provider-item:hover,.sess-item:hover{background:var(--panel2)}
.btn.secondary:hover,.eye:hover,.test-btn:hover,.sess-refresh:hover,.sess-copy:hover,.sess-copy-all:hover,.diff-toggle:hover,.sess-back:hover,.p-btn:hover{background:var(--panel2);border-color:var(--fieldLine)}
.btn.ok:hover{opacity:.88}
.btn.danger:hover,.m-del:hover,.sess-del:hover,.p-btn.danger:hover{background:var(--statusErrBg)}
.hist-proj-toggle:hover{color:var(--text)}
}

@media(max-width:1100px){.shell{grid-template-columns:216px minmax(0,1fr)}
.content{padding:32px 28px 48px}
.topbar{padding:0 28px}
.provider-item{align-items:flex-start}
.p-meta{flex-basis:50%}
.p-actions{width:100%}
}

@media(max-width:760px){.shell{display:block}
.sidebar{position:relative;height:auto;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;padding:12px max(16px,env(safe-area-inset-left)) 0;border-right:0;border-bottom:1px solid var(--line);overflow:visible}
.brand{padding:0}
.brand-caption{font-size:11px}
.sidebar-nav{grid-column:1/-1;grid-row:2;min-width:0}
.nav-label,.side,.sidebar-footer>.local-state{display:none}
.tabs{flex-direction:row;overflow:auto;padding:0 0 12px;scrollbar-width:thin;scroll-padding:16px;gap:4px}
.tab{width:auto;flex:none;padding:10px 12px;font-size:12px;gap:8px}
.tab svg{width:14px;height:14px}
.sidebar-footer{grid-column:2;grid-row:1;margin:0;padding:0;border:0}
.sidebar-controls{gap:4px;grid-template-columns:76px 84px}
.sidebar-controls select{font-size:11px;padding:0 4px;min-height:44px}
.topbar{height:48px;padding:0 20px}
.topbar>.local-state{display:none}
.content{padding:28px max(20px,env(safe-area-inset-left)) max(40px,env(safe-area-inset-bottom))}
.page-heading{margin-bottom:28px}
.connection-grid,.prompt-row,.provider-row{grid-template-columns:minmax(0,1fr)}
.form-section{margin-bottom:24px;padding-bottom:20px}
.action-bar{align-items:stretch;gap:20px}
.action-bar>.btn{width:100%}
.p-actions{gap:4px}
.p-btn{padding:0 10px}
.p-meta{flex-basis:100%}
.provider-item{padding:12px;gap:8px}
.sess-search{flex-basis:100%}
.sess-head{justify-content:flex-start}
.sess-toolbar{gap:8px}
.sess-count{margin-left:0}
.sess-item{padding-right:64px}
.model-item{gap:8px;padding:8px}
.model-item .m-id{font-size:12px}
.model-item select{padding:0 4px;font-size:12px}
.prompt-editor{min-height:320px}
.readonly-viewer{max-height:60dvh}
.row>.btn{white-space:normal}
.modal-overlay{padding:20px}
.modal-card{padding:20px}
}

@media(max-width:380px){.brand-name{font-size:14px}
.brand-caption{display:none}
.sidebar-controls{grid-template-columns:68px 72px}
.sidebar{gap:12px}
.content{padding-left:16px;padding-right:16px}
.model-item{flex-wrap:wrap}
.model-item .m-id{flex-basis:calc(100% - 28px)}
.model-item select{max-width:none!important;flex:1}
.model-item .m-del{margin-left:auto}
.sess-refresh{padding:0 8px}
}

@media(pointer:coarse){input,select,textarea,.field select,.model-item select,.sidebar-controls select{font-size:16px}
.sidebar-controls{grid-template-columns:88px 96px}
.brand-caption{display:none}
.sess-check{width:24px;height:24px}
.sess-item{padding-left:44px}
.sidebar{padding-left:12px;padding-right:12px}
.brand{gap:8px}
}

@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
}

`;
