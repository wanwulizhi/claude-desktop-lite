'use strict';

console.log('[renderer] app.js loaded');

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const overlay = $('perm-overlay');

const E2E = new URLSearchParams(location.search).get('e2e') === '1';
const PERF = new URLSearchParams(location.search).get('perf') === '1';
let e2eDeltaCount = 0;
let perfSendAt = 0;
let perfFirstDeltaLogged = false;

function perfLog(label) {
  if (PERF) console.log(`[perf] ${label} +${Math.round(performance.now() - perfSendAt)}ms`);
}
if (E2E) console.log('[e2e] script start, cwd=', new URLSearchParams(location.search).get('cwd'));

let state = {
  sessionId: null,
  cwd: null,
  resumeId: null,
  running: false,
  model: null,
  pendingModel: null,
  models: [],
  permissionMode: localStorage.getItem('cds.permissionMode') || 'default',
  theme: localStorage.getItem('cds.theme') || 'system',
};

const PERMISSION_MODES = [
  { id: 'default', label: '标准', desc: '每次工具调用都询问' },
  { id: 'acceptEdits', label: '接受编辑', desc: '文件修改自动通过，命令仍需确认' },
  { id: 'plan', label: '计划', desc: '只读规划，不执行修改' },
  { id: 'bypassPermissions', label: 'YOLO', desc: '跳过所有权限确认（危险）', danger: true },
];

const THEME_MODES = [
  { id: 'system', label: '跟随系统', icon: 'i-contrast' },
  { id: 'light', label: '亮色', icon: 'i-sun' },
  { id: 'dark', label: '暗色', icon: 'i-moon' },
];
let permQueue = [];
let currentPerm = null;
let questionQueue = [];
let currentQuestion = null;
const toolCards = new Map();
let readGroup = null;

// 流式渲染状态
let streamState = null; // { id, text, el, raf }
let lastStreamed = null; // { id, text } —— 用于和完整 assistant 消息去重

// 附件与斜杠命令
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
let attachments = [];
let slashCommands = [];
let slashCwd = null;
let slashItems = [];
let slashActive = 0;

// 客户端命令：由 GUI 自己实现（CLI 内建命令在 stream-json 模式下不会生效）
const CLIENT_COMMANDS = [
  { name: 'model', scope: 'client', kind: 'client', description: '切换模型（会话内即时生效）' },
  { name: 'clear', scope: 'client', kind: 'client', description: '开始新对话（保留项目）' },
  { name: 'help', scope: 'client', kind: 'client', description: '查看可用命令' },
];

// 内置提示模板：选中后直接填入提示词（不依赖 CLI 的内建命令）
const BUILTIN_COMMANDS = [
  { name: 'summary', scope: 'builtin', description: '总结当前对话', prompt: '请用要点总结我们到目前为止的对话。' },
  { name: 'explain', scope: 'builtin', description: '说明项目结构和技术栈', prompt: '请简要说明这个项目的目录结构、技术栈和主要入口。' },
  { name: 'review', scope: 'builtin', description: '审查未提交的改动', prompt: '请审查当前工作区未提交的改动，指出潜在问题和改进点。' },
  { name: 'test', scope: 'builtin', description: '运行测试并分析失败', prompt: '运行这个项目的测试，并分析失败的用例。' },
];

function resetStream() {
  if (streamState?.renderTimer) clearTimeout(streamState.renderTimer);
  streamState = null;
  lastStreamed = null;
}

// ---------------------------------------------------------------- 工具函数

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GFM Markdown（marked + DOMPurify），代码高亮由 Prism 在 enhance 阶段完成
marked.setOptions({ gfm: true, breaks: true });

function renderMarkdown(text) {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
}

/** 给已插入的 Markdown 内容加：代码块外框/复制按钮、语法高亮、外链处理 */
function enhanceMarkdown(container) {
  // 点击交给 #messages 上的委托处理器，流式渲染（未 enhance）的链接也能生效
  container.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
  });

  container.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('code-block')) return;

    const langClass = [...code.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : 'text';

    const wrap = document.createElement('div');
    wrap.className = 'code-block';

    const head = document.createElement('div');
    head.className = 'code-head';
    head.innerHTML = `<span class="lang">${escapeHtml(lang)}</span>`;

    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1200);
      } catch { /* ignore */ }
    });
    head.appendChild(btn);

    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(head);
    wrap.appendChild(pre);

    if (window.Prism) {
      try { Prism.highlightElement(code); } catch { /* ignore */ }
    }
  });
}

/** 是否贴着底部（允许 80px 误差） */
function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function updateScrollButton() {
  const btn = $('scroll-bottom');
  if (btn) btn.hidden = nearBottom();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateScrollButton();
}

function clearMessages() {
  messagesEl.innerHTML = '';
  toolCards.clear();
  readGroup = null;
}

function showEmpty() {
  const tpl = $('empty-template');
  messagesEl.innerHTML = '';
  if (tpl) messagesEl.appendChild(tpl.content.cloneNode(true));
  bindEmptySuggestions();
}

/** 空状态里的快捷提示：填入输入框，不直接发送 */
function bindEmptySuggestions() {
  messagesEl.querySelectorAll('.suggest').forEach((btn) => {
    btn.addEventListener('click', () => {
      inputEl.value = btn.dataset.prompt || '';
      inputEl.focus();
      autoResize();
      updateSlashMenu();
    });
  });
}

function removeEmpty() {
  const empty = $('empty');
  if (empty) empty.remove();
}

function addMessage(kind, text) {
  readGroup = null;
  removeEmpty();
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.innerHTML = `<div class="who">${kind === 'user' ? '你' : 'Claude'}</div>
                   <div class="bubble">${renderMarkdown(text)}</div>`;
  enhanceMarkdown(div.querySelector('.bubble'));
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

function addSystem(text, isError = false) {
  readGroup = null;
  removeEmpty();
  const div = document.createElement('div');
  div.className = `msg system${isError ? ' error' : ''}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollBottom();
}

function addThinking(text) {
  readGroup = null;
  removeEmpty();
  const div = document.createElement('div');
  div.className = 'thinking';
  div.innerHTML = `<details><summary>思考过程</summary><pre>${escapeHtml(text)}</pre></details>`;
  messagesEl.appendChild(div);
  scrollBottom();
}

function summarizeTool(name, input) {
  if (!input) return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.path) return input.path;
  if (input.pattern) return input.pattern;
  if (input.url) return input.url;
  const s = JSON.stringify(input);
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

// ---------------------------------------------------------------- 工具卡片视图

const TOOL_ICONS = {
  Bash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M13 15h4"/></svg>',
  Read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
};
const STATUS_ICONS = {
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>',
  err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const CHECK_ICON = '<svg class="mi-check" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-check"></use></svg>';
const SPINNER = '<span class="tool-spinner"></span>';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Shell']);

function toolIcon(name) {
  if (SHELL_TOOLS.has(name)) return TOOL_ICONS.Bash;
  return TOOL_ICONS[name] || TOOL_ICONS.default;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 去掉终端 ANSI 颜色/光标控制码 */
function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function firstLine(text) {
  const line = String(text || '').split('\n')[0].trim();
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

function basenameOf(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
}

function displayPath(p) {
  if (!p) return '';
  const cwd = state.cwd;
  if (cwd) {
    const norm = String(cwd).replace(/[\\/]+$/, '');
    if (p.startsWith(norm + '\\') || p.startsWith(norm + '/')) {
      return p.slice(norm.length).replace(/^[\\/]+/, '') || p;
    }
  }
  return p;
}

function toolButton(label, onClick, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tool-btn';
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick(btn);
  });
  return btn;
}

async function copyWithFeedback(btn, text) {
  try {
    await navigator.clipboard.writeText(text || '');
    const old = btn.textContent;
    btn.textContent = '已复制';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch { /* ignore */ }
}

function createToolCard({ id, name, summary }) {
  removeEmpty();
  const card = document.createElement('div');
  card.className = 'tool-card';
  if (id) card.dataset.id = id;
  card.innerHTML = `
    <div class="tool-inner">
      <div class="tool-head" role="button" tabindex="0" aria-expanded="false">
        <span class="tool-icon">${toolIcon(name)}</span>
        <span class="tool-name">${escapeHtml(name)}</span>
        <span class="tool-summary">${escapeHtml(summary || '')}</span>
        <span class="tool-meta"></span>
        <span class="tool-status running" title="运行中">${SPINNER}</span>
        <span class="tool-chevron">${CHEVRON_ICON}</span>
      </div>
      <div class="tool-body" hidden></div>
    </div>`;

  const head = card.querySelector('.tool-head');
  const body = card.querySelector('.tool-body');
  const summaryEl = card.querySelector('.tool-summary');
  const metaEl = card.querySelector('.tool-meta');
  const statusEl = card.querySelector('.tool-status');
  let expanded = false;

  const view = {
    card,
    head,
    body,
    startedAt: performance.now(),
    setSummary(text) {
      summaryEl.textContent = text || '';
      summaryEl.title = text || '';
    },
    setMeta(text) {
      metaEl.textContent = text || '';
    },
    setStatus(status) {
      statusEl.className = `tool-status ${status}`;
      statusEl.innerHTML = status === 'running' ? SPINNER : (STATUS_ICONS[status] || '');
      statusEl.title = status === 'running' ? '运行中' : status === 'ok' ? '成功' : '失败';
      card.classList.toggle('ok', status === 'ok');
      card.classList.toggle('err', status === 'err');
    },
    setExpanded(open) {
      expanded = !!open;
      body.hidden = !expanded;
      card.classList.toggle('open', expanded);
      head.setAttribute('aria-expanded', String(expanded));
    },
    isExpanded() { return expanded; },
    toggle() { view.setExpanded(!expanded); },
    setResultDuration() {
      const ms = performance.now() - view.startedAt;
      if (ms >= 50) view.setMeta(formatDuration(ms));
    },
  };

  head.addEventListener('click', () => view.toggle());
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      view.toggle();
    }
  });

  messagesEl.appendChild(card);
  scrollBottom();
  return view;
}

function createBashView({ id, name, input }) {
  const command = typeof input?.command === 'string' ? input.command : '';
  const description = typeof input?.description === 'string' ? input.description : '';
  const isPowerShell = name === 'PowerShell';
  const shellLang = isPowerShell ? 'powershell' : 'bash';
  const prompt = isPowerShell ? '>' : '$';
  const view = createToolCard({ id, name, summary: description || firstLine(command) || name });

  view.body.innerHTML = `
    <div class="tool-command">
      <span class="tool-prompt">${prompt}</span>
      <pre><code class="language-${shellLang}"></code></pre>
      <span class="tool-command-actions"></span>
    </div>
    <div class="tool-output-wrap">
      <div class="tool-output-head">
        <span class="tool-output-label">输出</span>
        <span class="tool-cwd"></span>
        <span class="tool-output-meta"></span>
        <span class="tool-output-actions"></span>
      </div>
      <pre class="tool-output"><code class="tool-output-code tool-output-empty">运行中…</code></pre>
    </div>`;

  const commandCode = view.body.querySelector('.tool-command code');
  commandCode.textContent = command || '(无命令)';
  if (command && window.Prism) {
    try { Prism.highlightElement(commandCode); } catch { /* ignore */ }
  }

  const cwdEl = view.body.querySelector('.tool-cwd');
  if (state.cwd) {
    cwdEl.textContent = state.cwd;
    cwdEl.title = state.cwd;
  }

  const outputPre = view.body.querySelector('.tool-output');
  const outputCode = view.body.querySelector('.tool-output-code');
  const outputMeta = view.body.querySelector('.tool-output-meta');
  const outputActions = view.body.querySelector('.tool-output-actions');
  const commandActions = view.body.querySelector('.tool-command-actions');

  commandActions.appendChild(toolButton('复制命令', (b) => copyWithFeedback(b, command)));

  let cleanOutput = '';
  let outputExpanded = false;
  const copyOut = toolButton('复制输出', (b) => copyWithFeedback(b, cleanOutput));
  copyOut.hidden = true;
  const expandOut = toolButton('显示全部', () => {
    outputExpanded = !outputExpanded;
    outputPre.classList.toggle('expanded', outputExpanded);
    expandOut.textContent = outputExpanded ? '收起' : '显示全部';
  });
  expandOut.hidden = true;
  outputActions.append(copyOut, expandOut);

  view.setResult = ({ isError, text, truncated, totalLength }) => {
    cleanOutput = stripAnsi(text || '').replace(/\r\n/g, '\n');
    outputCode.textContent = cleanOutput || '(无输出)';
    outputCode.classList.toggle('tool-output-empty', !cleanOutput);
    const lines = cleanOutput ? cleanOutput.split('\n').length : 0;
    const bits = [];
    if (lines) bits.push(`${lines} 行`);
    if (truncated) bits.push(`已截断（共 ${totalLength} 字符）`);
    outputMeta.textContent = bits.join(' · ');
    copyOut.hidden = !cleanOutput;
    expandOut.hidden = lines <= 12;
    if (lines <= 12) {
      outputPre.classList.remove('expanded');
      outputExpanded = false;
      expandOut.textContent = '显示全部';
    }
    view.setStatus(isError ? 'err' : 'ok');
    view.setResultDuration();
    if (isError) view.setExpanded(true);
  };

  return view;
}

function createGenericView({ id, name, input }) {
  const view = createToolCard({ id, name, summary: summarizeTool(name, input) });
  view.body.innerHTML = `
    <div class="tool-generic">
      <div class="tool-generic-label">参数</div>
      <pre class="tool-input"></pre>
      <div class="tool-generic-label tool-result-label" hidden>结果</div>
      <pre class="tool-output tool-generic-output" hidden></pre>
    </div>`;
  view.body.querySelector('.tool-input').textContent = JSON.stringify(input ?? {}, null, 2);

  const outputEl = view.body.querySelector('.tool-generic-output');
  const resultLabel = view.body.querySelector('.tool-result-label');

  view.setResult = ({ isError, text }) => {
    const clean = stripAnsi(text || '');
    outputEl.textContent = clean || '(无输出)';
    outputEl.hidden = false;
    resultLabel.hidden = false;
    view.setStatus(isError ? 'err' : 'ok');
    view.setResultDuration();
    if (isError) view.setExpanded(true);
  };

  return view;
}

function readLanguage(path) {
  const ext = (String(path).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    json: 'json', md: 'markdown', markdown: 'markdown',
    py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
    ps1: 'powershell', yml: 'yaml', yaml: 'yaml', sql: 'sql',
    css: 'css', html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  };
  return map[ext] || 'text';
}

function readLanguageLabel(path) {
  const lang = readLanguage(path);
  return lang === 'text' ? 'Text' : lang[0].toUpperCase() + lang.slice(1);
}

/** CLI 的 Read 结果格式是 `行号\t内容`；匹配率足够高才按行号视图渲染 */
function parseNumberedText(text) {
  const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const lines = [];
  let matched = 0;
  for (const raw of rawLines) {
    const m = /^\s*(\d+)\t(.*)$/.exec(raw);
    if (m) {
      matched++;
      lines.push({ n: m[1], text: m[2] });
    } else {
      lines.push({ n: '', text: raw });
    }
  }
  if (matched < Math.max(1, Math.ceil(rawLines.length * 0.8))) return null;
  return { lines, code: lines.map((l) => l.text).join('\n') };
}

function updateReadSummary(group) {
  const names = [...group.entries.values()].map((e) => e.name).filter(Boolean);
  let summary = '';
  if (names.length <= 3) summary = names.join(', ');
  else summary = `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  group.card.setSummary(summary);
}

function getOrCreateReadGroup() {
  if (readGroup) return readGroup;
  const card = createToolCard({ name: 'Read', summary: '' });
  card.body.innerHTML = '<div class="read-files"></div>';
  readGroup = {
    card,
    filesEl: card.body.querySelector('.read-files'),
    entries: new Map(),
    pending: 0,
    hasError: false,
  };
  return readGroup;
}

function createReadEntry({ id, input }) {
  const group = getOrCreateReadGroup();
  const path = typeof input?.file_path === 'string'
    ? input.file_path
    : (typeof input?.path === 'string' ? input.path : '');
  const name = basenameOf(path) || '文件';

  const entry = document.createElement('div');
  entry.className = 'read-file';
  entry.dataset.id = id;
  entry.innerHTML = `
    <div class="read-file-head">
      <span class="read-file-icon">${TOOL_ICONS.Read}</span>
      <span class="read-path"></span>
      <span class="read-file-meta"></span>
      <span class="read-file-status running">${SPINNER}</span>
      <span class="read-file-actions"></span>
    </div>
    <div class="read-file-body">
      <div class="read-empty">等待读取…</div>
      <div class="read-code" hidden>
        <pre class="read-gutter" aria-hidden="true"></pre>
        <pre class="read-content"><code></code></pre>
      </div>
    </div>`;

  const pathEl = entry.querySelector('.read-path');
  pathEl.textContent = displayPath(path) || name;
  pathEl.title = path || name;

  const metaEl = entry.querySelector('.read-file-meta');
  const statusEl = entry.querySelector('.read-file-status');
  const emptyEl = entry.querySelector('.read-empty');
  const codeWrap = entry.querySelector('.read-code');
  const gutterEl = entry.querySelector('.read-gutter');
  const codeEl = entry.querySelector('.read-content code');
  const actionsEl = entry.querySelector('.read-file-actions');

  let codeText = '';
  let codeExpanded = false;

  const copyBtn = toolButton('复制', (b) => copyWithFeedback(b, codeText));
  copyBtn.hidden = true;
  const openBtn = toolButton('打开', () => {
    if (path) window.api.openPath(path).catch(() => {});
  }, '用默认程序打开');
  openBtn.hidden = !path;
  const folderBtn = toolButton('定位', () => {
    if (path) window.api.showInFolder(path).catch(() => {});
  }, '在资源管理器中显示');
  folderBtn.hidden = !path;
  const expandBtn = toolButton('显示全部', () => {
    codeExpanded = !codeExpanded;
    codeWrap.classList.toggle('expanded', codeExpanded);
    expandBtn.textContent = codeExpanded ? '收起' : '显示全部';
  });
  expandBtn.hidden = true;
  actionsEl.append(copyBtn, openBtn, folderBtn, expandBtn);

  const view = {
    card: group.card,
    group,
    name,
    path,
    setResult({ isError, text, truncated, totalLength }) {
      group.pending = Math.max(0, group.pending - 1);
      if (isError) group.hasError = true;

      statusEl.className = `read-file-status ${isError ? 'err' : 'ok'}`;
      statusEl.innerHTML = isError ? STATUS_ICONS.err : STATUS_ICONS.ok;
      entry.classList.toggle('err', isError);

      const raw = stripAnsi(text || '').replace(/\r\n/g, '\n');
      const parsed = parseNumberedText(raw);
      const lines = raw ? raw.split('\n').length : 0;
      codeText = parsed ? parsed.code : raw;

      if (isError) {
        emptyEl.hidden = false;
        emptyEl.textContent = raw || '读取失败';
        codeWrap.hidden = true;
      } else if (!raw) {
        emptyEl.hidden = false;
        emptyEl.textContent = '(空文件)';
        codeWrap.hidden = true;
      } else {
        emptyEl.hidden = true;
        codeWrap.hidden = false;
        gutterEl.textContent = parsed ? parsed.lines.map((l) => l.n).join('\n') : '';
        gutterEl.hidden = !parsed;
        codeEl.textContent = codeText;
        const lang = readLanguage(path);
        codeEl.className = lang === 'text' ? '' : `language-${lang}`;
        if (lang !== 'text' && window.Prism) {
          try { Prism.highlightElement(codeEl); } catch { /* ignore */ }
        }
      }

      const meta = [];
      if (lines) meta.push(`${lines} 行`);
      if (path) meta.push(readLanguageLabel(path));
      if (truncated) meta.push(`已截断（共 ${totalLength} 字符）`);
      metaEl.textContent = meta.join(' · ');

      copyBtn.hidden = !codeText;
      expandBtn.hidden = lines <= 20;
      if (lines <= 20) {
        codeWrap.classList.remove('expanded');
        codeExpanded = false;
        expandBtn.textContent = '显示全部';
      }

      group.card.setStatus(group.pending > 0 ? 'running' : (group.hasError ? 'err' : 'ok'));
      if (group.pending === 0 && !group.hasError) group.card.setResultDuration();
      if (isError) group.card.setExpanded(true);
    },
  };

  group.entries.set(id, view);
  group.filesEl.appendChild(entry);
  group.pending++;
  group.card.setStatus('running');
  updateReadSummary(group);
  toolCards.set(id, view);
  scrollBottom();
  return view;
}

function addToolUse({ id, name, input }) {
  if (name === 'Read') {
    createReadEntry({ id, input });
    return;
  }

  // 非 Read 工具会打断连续的 Read 分组
  readGroup = null;
  const view = SHELL_TOOLS.has(name)
    ? createBashView({ id, name, input })
    : createGenericView({ id, name, input });
  toolCards.set(id, view);
}

function addToolResult({ toolUseId, isError, text, truncated, totalLength }) {
  const view = toolCards.get(toolUseId);
  if (!view || typeof view.setResult !== 'function') return;
  view.setResult({ isError, text, truncated, totalLength });
}

function handleStream(ev) {
  if (ev.phase === 'start') {
    resetStream();
    streamState = { id: ev.messageId || null, text: '', el: null, renderTimer: null, lastRender: 0 };
    return;
  }

  if (ev.phase === 'delta') {
    hideWorking();
    if (PERF && !perfFirstDeltaLogged) {
      perfFirstDeltaLogged = true;
      perfLog('ui-first-delta');
    }
    if (E2E) e2eDeltaCount++;
    if (!streamState) streamState = { id: null, text: '', el: null, raf: null };
    streamState.text += ev.text;

    if (!streamState.el) {
      readGroup = null;
      removeEmpty();
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML = '<div class="who">Claude</div><div class="bubble"></div>';
      messagesEl.appendChild(div);
      streamState.el = div;
    }

    // 流式渲染节流到 ~20fps：长回复时不必每帧重新 marked + DOMPurify
    if (!streamState.renderTimer) {
      const wait = Math.max(0, 50 - (performance.now() - (streamState.lastRender || 0)));
      streamState.renderTimer = setTimeout(() => {
        if (!streamState) return;
        streamState.renderTimer = null;
        if (!streamState.el) return;
        // 用户上翻阅读时不要强行拽回底部
        const stick = nearBottom();
        streamState.el.querySelector('.bubble').innerHTML = renderMarkdown(streamState.text);
        streamState.lastRender = performance.now();
        if (stick) scrollBottom();
        else updateScrollButton();
      }, wait);
    }
    return;
  }

  if (ev.phase === 'stop' && streamState) {
    const stick = nearBottom();
    if (streamState.renderTimer) {
      clearTimeout(streamState.renderTimer);
      streamState.renderTimer = null;
    }
    if (streamState.el) {
      const bubble = streamState.el.querySelector('.bubble');
      bubble.innerHTML = renderMarkdown(streamState.text);
      enhanceMarkdown(bubble);
    }
    if (streamState.text.trim()) {
      lastStreamed = { id: streamState.id, text: streamState.text };
    }
    streamState = null;
    if (stick) scrollBottom();
    else updateScrollButton();
  }
}

/** 完整 assistant 消息是否已经由增量流渲染过 */
function isStreamedDuplicate(messageId, text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (streamState && (streamState.id === messageId || streamState.text.trim() === t)) return true;
  if (lastStreamed && (lastStreamed.id === messageId || lastStreamed.text.trim() === t)) return true;
  return false;
}

function addMeta(ev) {
  const bits = [];
  if (typeof ev.durationMs === 'number') bits.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
  if (typeof ev.numTurns === 'number') bits.push(`${ev.numTurns} 轮`);
  if (typeof ev.totalCostUsd === 'number' && ev.totalCostUsd > 0) {
    bits.push(`$${ev.totalCostUsd.toFixed(4)}`);
  }
  if (bits.length) addSystem(`— ${bits.join(' · ')} —`);
}

// ---------------------------------------------------------------- 附件

const attachmentsEl = $('attachments');
const slashMenuEl = $('slash-menu');

function isImagePath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return !!m && IMAGE_EXT.includes(m[1].toLowerCase());
}

/** 附件可能是磁盘路径字符串，也可能是 { dataUrl, name }（剪贴板/浏览器拖入） */
const attachmentCache = new Map();
function cacheAttachment(key, value) {
  attachmentCache.set(key, value);
  // 简单 LRU 上限，避免反复预览大图把内存撑爆
  if (attachmentCache.size > 12) {
    attachmentCache.delete(attachmentCache.keys().next().value);
  }
}
function clearAttachmentCache() {
  attachmentCache.clear();
}

async function attachmentSrc(item) {
  if (item && typeof item === 'object' && item.dataUrl) return item.dataUrl;
  if (attachmentCache.has(item)) return attachmentCache.get(item);
  const dataUrl = await window.api.toDataUrl(item);
  if (dataUrl) cacheAttachment(item, dataUrl);
  return dataUrl;
}

async function fileToDataUrl(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
  }
  return `data:${file.type || 'image/png'};base64,${btoa(binary)}`;
}

async function renderAttachments() {
  attachmentsEl.hidden = attachments.length === 0;
  attachmentsEl.innerHTML = '';

  for (let i = 0; i < attachments.length; i++) {
    const item = attachments[i];
    const el = document.createElement('div');
    el.className = 'attachment';

    const img = document.createElement('img');
    const dataUrl = await attachmentSrc(item);
    if (dataUrl) img.src = dataUrl;
    el.appendChild(img);

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', () => {
      const idx = attachments.indexOf(item);
      if (idx >= 0) attachments.splice(idx, 1);
      renderAttachments();
    });
    el.appendChild(rm);
    attachmentsEl.appendChild(el);
  }
}

async function addAttachment(filePath) {
  if (!filePath || !isImagePath(filePath)) return false;
  if (attachments.includes(filePath)) return false;
  if (attachments.length >= 6) {
    addSystem('最多同时附加 6 张图片。');
    return false;
  }
  attachments.push(filePath);
  await renderAttachments();
  return true;
}

/** 剪贴板图片 / 浏览器拖入的图片：没有磁盘路径，直接保存 data URL */
async function addAttachmentDataUrl(dataUrl, name) {
  if (!dataUrl || !dataUrl.startsWith('data:image/')) return false;
  if (attachments.some((a) => a && typeof a === 'object' && a.dataUrl === dataUrl)) return false;
  if (attachments.length >= 6) {
    addSystem('最多同时附加 6 张图片。');
    return false;
  }
  attachments.push({ dataUrl, name: name || '图片' });
  await renderAttachments();
  return true;
}

async function addUserMessage(text, images) {
  readGroup = null;
  removeEmpty();
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = '<div class="who">你</div><div class="bubble"></div>';
  const bubble = div.querySelector('.bubble');

  for (const p of images || []) {
    const dataUrl = await attachmentSrc(p);
    if (!dataUrl) continue;
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = dataUrl;
    bubble.appendChild(img);
  }

  if (text) {
    const body = document.createElement('div');
    body.innerHTML = renderMarkdown(text);
    enhanceMarkdown(body);
    bubble.appendChild(body);
  }

  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

function insertAtCursor(text) {
  const start = inputEl.selectionStart ?? inputEl.value.length;
  const end = inputEl.selectionEnd ?? inputEl.value.length;
  inputEl.value = inputEl.value.slice(0, start) + text + inputEl.value.slice(end);
  const pos = start + text.length;
  inputEl.setSelectionRange(pos, pos);
  inputEl.focus();
  autoResize();
  updateSlashMenu();
}

async function handleDroppedFiles(files) {
  for (const file of files) {
    const filePath = window.api.pathForFile(file);
    if (filePath) {
      if (isImagePath(filePath)) {
        await addAttachment(filePath);
      } else {
        // 非图片：作为 @ 文件引用插入文本
        insertAtCursor(`@${filePath} `);
      }
      continue;
    }
    // 浏览器拖入的图片没有本地路径：直接读成 data URL
    if ((file.type || '').startsWith('image/')) {
      if (file.size > 20 * 1024 * 1024) {
        addSystem('图片过大（单张上限 20MB）。');
        continue;
      }
      await addAttachmentDataUrl(await fileToDataUrl(file), file.name);
    }
  }
}

// ---------------------------------------------------------------- 斜杠命令

async function ensureCommands() {
  const cwd = state.cwd || '';
  if (cwd === slashCwd) return;
  slashCwd = cwd;
  try {
    const list = await window.api.listCommands(cwd);
    slashCommands = (list || []).map((c) => ({ ...c, kind: 'command' }));
  } catch {
    slashCommands = [];
  }
}

async function updateSlashMenu() {
  const m = /^\/([^\s]*)$/.exec(inputEl.value);
  if (!m) {
    hideSlash();
    return;
  }
  await ensureCommands();
  const q = m[1].toLowerCase();
  const all = [...CLIENT_COMMANDS, ...BUILTIN_COMMANDS, ...slashCommands];
  slashItems = all
    .filter((c) => c.name.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
    .slice(0, 30);
  slashActive = 0;
  renderSlash();
}

function renderSlash() {
  slashMenuEl.hidden = false;
  if (!slashItems.length) {
    slashMenuEl.innerHTML =
      '<div class="slash-empty">没有匹配的命令。自定义命令放在 ' +
      '<code>.claude/commands/</code> 或 <code>~/.claude/commands/</code> 下（.md 文件）。</div>';
    return;
  }
  slashMenuEl.innerHTML = '';
  slashItems.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = `slash-item${i === slashActive ? ' active' : ''}`;
    el.innerHTML =
      `<span class="sl-name">/${escapeHtml(c.name)}</span>` +
      `<span class="sl-desc">${escapeHtml(c.description || (c.scope === 'project' ? '项目命令' : '用户命令'))}</span>`;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseSlash(i);
    });
    slashMenuEl.appendChild(el);
  });
}

function hideSlash() {
  slashMenuEl.hidden = true;
  slashItems = [];
}

function chooseSlash(i) {
  const c = slashItems[i];
  if (!c) return;

  hideSlash();

  if (c.kind === 'client') {
    // 命令文本不能留在输入框，否则再按 Enter 会被当普通消息发出去
    inputEl.value = '';
    autoResize();
    runClientCommand(c.name);
    return;
  }

  if (c.kind === 'builtin') {
    inputEl.value = c.prompt;
  } else {
    inputEl.value = `/${c.name} `;
  }

  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  autoResize();
}

// ---------------------------------------------------------------- 客户端命令 / 模型

function modelLabel(id) {
  if (!id) return '默认模型';
  const list = state.models || [];
  const m = list.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  return m ? m.label : id;
}

function updateModelLabel() {
  const text = $('model-label-text');
  if (text) text.textContent = modelLabel(state.model);
  else $('model-label').textContent = modelLabel(state.model);
}

async function initModels() {
  try {
    const r = await window.api.listModels();
    state.models = r.models || [];
    state.model = r.current || null;
  } catch { /* ignore */ }
  updateModelLabel();
}

function renderModelMenu() {
  closeThemeMenu(); // /model 命令和按钮共用这个入口，不能和主题菜单叠在一起
  const menu = $('model-menu');
  menu.hidden = false;
  menu.innerHTML = '<div class="mm-title">切换模型</div>';

  if (!state.models || !state.models.length) {
    menu.innerHTML += '<div class="model-item"><span class="mi-label">未从 settings.json 读到模型</span></div>';
    return;
  }

  for (const m of state.models) {
    const el = document.createElement('div');
    const active = state.model && m.id.toLowerCase() === state.model.toLowerCase();
    el.className = `model-item${active ? ' active' : ''}`;
    el.innerHTML =
      `<span class="mi-label">${escapeHtml(m.label)}</span>` +
      `<span class="mi-slot">${escapeHtml(m.slot)}</span>` +
      (active ? CHECK_ICON : '');
    el.addEventListener('click', () => selectModel(m.id));
    menu.appendChild(el);
  }
}

function toggleModelMenu() {
  const menu = $('model-menu');
  if (menu.hidden) {
    closeThemeMenu(); // 两个菜单锚在同一位置，不能同时打开
    renderModelMenu();
  } else {
    menu.hidden = true;
  }
}

function closeModelMenu() {
  $('model-menu').hidden = true;
}

async function selectModel(id) {
  closeModelMenu();
  const res = await window.api.setModel(id);
  state.model = id;
  updateModelLabel();
  if (!res || !res.ok) {
    state.pendingModel = id;
    addSystem(`会话尚未启动，模型将在下一条消息生效：${modelLabel(id)}`);
  }
}

// ---------------------------------------------------------------- 权限模式

function currentPermissionMode() {
  return PERMISSION_MODES.find((m) => m.id === state.permissionMode) || PERMISSION_MODES[0];
}

function updateModeLabel() {
  const mode = currentPermissionMode();
  const btn = $('mode-btn');
  if (!btn) return;
  btn.textContent = mode.label;
  btn.classList.toggle('danger', !!mode.danger);
}

function renderModeMenu() {
  const menu = $('mode-menu');
  menu.hidden = false;
  menu.innerHTML = '';

  for (const mode of PERMISSION_MODES) {
    const el = document.createElement('div');
    const active = mode.id === state.permissionMode;
    el.className = `slash-item${active ? ' active' : ''}`;
    el.innerHTML =
      `<span class="sl-name">${escapeHtml(mode.label)}</span>` +
      `<span class="sl-desc">${escapeHtml(mode.desc)}</span>` +
      (active ? CHECK_ICON : '');
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectPermissionMode(mode.id);
    });
    menu.appendChild(el);
  }
}

function toggleModeMenu() {
  const menu = $('mode-menu');
  if (menu.hidden) renderModeMenu();
  else menu.hidden = true;
}

function closeModeMenu() {
  $('mode-menu').hidden = true;
}

async function selectPermissionMode(mode) {
  closeModeMenu();

  // YOLO 需要重启进程，回复进行中切换会中断当前请求
  if (mode === 'bypassPermissions' && state.running) {
    addSystem('当前回复进行中，请等结束后再切换到 YOLO 模式。');
    return;
  }

  state.permissionMode = mode;
  localStorage.setItem('cds.permissionMode', mode);
  updateModeLabel();

  if (mode === 'bypassPermissions') {
    addSystem('⚠️ YOLO 模式：工具调用将不再询问权限。');
  }

  const res = await window.api.setPermissionMode(mode);
  if (res && res.ok) {
    if (res.restarted) addSystem('已重启会话以应用权限模式。');
    return;
  }
  // 会话还没启动时不算错误，下一条消息会带上该模式
  if (res && res.error && res.error !== '会话尚未启动') {
    addSystem(`权限模式切换失败：${res.error}`, true);
  }
}

// ---------------------------------------------------------------- 主题

function renderThemeMenu() {
  closeModelMenu();
  const menu = $('theme-menu');
  menu.hidden = false;
  menu.innerHTML = '<div class="mm-title">主题</div>';

  for (const theme of THEME_MODES) {
    const el = document.createElement('div');
    const active = theme.id === state.theme;
    el.className = `model-item${active ? ' active' : ''}`;
    el.innerHTML =
      `<span class="mi-icon"><svg class="icon"><use href="#${theme.icon}"></use></svg></span>` +
      `<span class="mi-label">${escapeHtml(theme.label)}</span>` +
      (active ? CHECK_ICON : '');
    el.addEventListener('click', () => selectTheme(theme.id));
    menu.appendChild(el);
  }
}

/** 主题按钮图标跟随当前模式：跟随系统 / 太阳 / 月亮 */
function updateThemeIcon() {
  const mode = THEME_MODES.find((t) => t.id === state.theme) || THEME_MODES[0];
  const use = $('theme-icon');
  if (use) use.setAttribute('href', `#${mode.icon}`);
  const btn = $('theme-btn');
  if (btn) {
    btn.title = `主题：${mode.label}`;
    btn.setAttribute('aria-label', `主题：${mode.label}`);
  }
}

function toggleThemeMenu() {
  const menu = $('theme-menu');
  if (menu.hidden) {
    closeModelMenu(); // 两个菜单锚在同一位置，不能同时打开
    renderThemeMenu();
  } else {
    menu.hidden = true;
  }
}

function closeThemeMenu() {
  $('theme-menu').hidden = true;
}

async function selectTheme(mode) {
  closeThemeMenu();
  state.theme = mode;
  localStorage.setItem('cds.theme', mode);
  updateThemeIcon();
  await window.api.setTheme(mode);
}

async function initTheme() {
  updateThemeIcon();
  await window.api.setTheme(state.theme);
}

function clearConversation() {
  window.api.stop();
  permQueue = [];
  hidePermission();
  questionQueue = [];
  hideQuestion();
  setRunning(false);
  resetStream();
  clearMessages();
  showEmpty();
  state.sessionId = null;
  state.resumeId = null;
  state.pendingModel = null;
  attachments = [];
  clearAttachmentCache();
  renderAttachments();
  setActive(null);
  $('title').textContent = '新会话';
  hideWorking();
  addSystem('已开始新对话（项目保持不变）。');
  prewarm();
}

function runClientCommand(name) {
  if (name === 'model') {
    renderModelMenu();
    return;
  }
  if (name === 'clear') {
    clearConversation();
    return;
  }
  if (name === 'help') {
    addSystem(
      '可用命令：/model 切换模型 · /clear 新对话 · /help 帮助；' +
      '内置模板：/summary /explain /review /test；自定义命令来自 .claude/commands。'
    );
  }
}

// ---------------------------------------------------------------- 状态

const STATUS_TEXT = {
  idle: '就绪',
  starting: '启动中…',
  ready: '就绪',
  running: 'Claude 正在工作…',
  'waiting-permission': '等待授权',
};

function showWorking(text) {
  const el = $('working');
  if (!el) return;
  $('working-text').textContent = text;
  el.hidden = false;
}

function hideWorking() {
  const el = $('working');
  if (el) el.hidden = true;
}

function setStatus(s) {
  const el = $('status');
  el.textContent = STATUS_TEXT[s] || s;
  el.className = `status ${s === 'running' || s === 'starting' ? 'working' : 'idle'}`;
}

function setRunning(running) {
  state.running = running;
  $('send').disabled = running;
  $('stop').hidden = !running;
}

function updateCwd() {
  $('cwd-label').textContent = state.cwd || '未选择项目';
  $('cwd-label').title = state.cwd || '';
}

// ---------------------------------------------------------------- 会话列表

function timeLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n) => String(n).padStart(2, '0');
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}-${pad(d.getDate())}`;
}

function baseName(p) {
  if (!p) return '未知项目';
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

async function loadSessions() {
  let sessions;
  try {
    sessions = await window.api.listSessions();
  } catch (err) {
    console.error('[sessions] list failed', err);
    return;
  }
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).push(s);
  }

  const container = $('sessions');
  container.innerHTML = '';
  const sorted = [...groups.entries()].sort((a, b) => b[1][0].mtime - a[1][0].mtime);

  for (const [cwd, list] of sorted) {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.innerHTML =
      `<span class="group-name">${escapeHtml(baseName(cwd))}</span>` +
      `<span class="group-count">${list.length}</span>`;
    label.title = cwd;
    container.appendChild(label);

    for (const s of list.slice(0, 30)) {
      const el = document.createElement('div');
      el.className = 'session';
      if (state.sessionId === s.id) el.classList.add('active');
      el.dataset.id = s.id;
      el.innerHTML = `<div class="title-text">${escapeHtml(s.title)}</div><div class="time">${timeLabel(s.mtime)}</div>`;
      el.addEventListener('click', () => openSession(s));
      container.appendChild(el);
    }
  }

  if (!sessions.length) {
    container.innerHTML = '<div class="side-empty">还没有历史会话</div>';
  }
}

function setActive(id) {
  document.querySelectorAll('.session').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

/** 提前拉起 CLI，隐藏约 1.3s 的冷启动时间 */
async function prewarm() {
  if (!state.cwd) return;
  try {
    await window.api.start({
      cwd: state.cwd,
      resumeId: state.resumeId,
      permissionMode: state.permissionMode,
    });
  } catch { /* 预热失败不打扰用户，真正发送时会再试 */ }
}

async function openSession(s) {
  window.api.stop();
  setRunning(false);
  hideWorking();
  hidePermission();
  permQueue = [];
  hideQuestion();
  questionQueue = [];

  state = {
    ...state,
    sessionId: s.id,
    cwd: s.cwd,
    resumeId: s.id,
    running: false,
    model: null,
    pendingModel: null,
  };
  $('title').textContent = s.title || '会话';
  updateModelLabel();
  resetStream();
  clearMessages();
  attachments = [];
  clearAttachmentCache();
  renderAttachments();
  hideSlash();
  slashCwd = null;
  updateCwd();
  setActive(s.id);

  let h;
  try {
    h = await window.api.history(s.id);
  } catch (err) {
    console.error('[history] load failed', err);
    addSystem('读取会话历史失败。', true);
    prewarm();
    return;
  }
  if (!state.cwd && h.cwd) state.cwd = h.cwd;
  updateCwd();

  if (!h.items.length) {
    addSystem('这个会话没有可显示的消息。');
  } else {
    for (const it of h.items) {
      if (it.kind === 'user') addMessage('user', it.text);
      else if (it.kind === 'assistant') addMessage('assistant', it.text);
      else if (it.kind === 'tool_use') addToolUse(it);
      else if (it.kind === 'tool_result') addToolResult(it);
    }
  }

  prewarm();
}

async function newChat() {
  window.api.stop();
  setRunning(false);
  hideWorking();
  hidePermission();
  permQueue = [];
  hideQuestion();
  questionQueue = [];
  const prevCwd = state.cwd; // 取消选择文件夹时继续沿用当前项目
  state = {
    ...state,
    sessionId: null,
    cwd: prevCwd,
    resumeId: null,
    running: false,
    model: null,
    pendingModel: null,
  };
  $('title').textContent = '新会话';
  updateModelLabel();
  resetStream();
  clearMessages();
  attachments = [];
  clearAttachmentCache();
  renderAttachments();
  hideSlash();
  slashCwd = null;
  showEmpty();
  updateCwd();
  setActive(null);

  const folder = await window.api.pickFolder();
  if (folder) state.cwd = folder;
  updateCwd();
  inputEl.focus();
  if (state.cwd) prewarm(); // 取消选择时沿用原项目，仍可预热
}

// ---------------------------------------------------------------- 权限

function enqueuePermission(req) {
  permQueue.push(req);
  if (!currentPerm) showNextPermission();
}

function showNextPermission() {
  const req = permQueue.shift();
  if (!req) {
    overlay.hidden = true;
    currentPerm = null;
    return;
  }
  currentPerm = req;
  $('perm-tool').textContent = req.toolName;
  $('perm-reason').textContent = req.decisionReason || '';
  $('perm-input').textContent = JSON.stringify(req.input, null, 2);
  $('perm-always').hidden = !(req.suggestions && req.suggestions.length);
  overlay.hidden = false;
}

function hidePermission() {
  overlay.hidden = true;
  currentPerm = null;
}

function respondPermission(approved, always) {
  const req = currentPerm;
  if (!req) return;
  hidePermission();
  window.api.permission({
    requestId: req.requestId,
    approved,
    always,
    toolUseId: req.toolUseId,
    suggestions: req.suggestions,
    input: req.input,
  });
  showNextPermission();
}

// ---------------------------------------------------------------- 用户提问（AskUserQuestion）

function enqueueQuestion(req) {
  questionQueue.push(req);
  if (!currentQuestion) showNextQuestion();
}

function showNextQuestion() {
  const req = questionQueue.shift();
  if (!req) {
    $('question-overlay').hidden = true;
    currentQuestion = null;
    return;
  }
  currentQuestion = req;
  renderQuestion(req);
  $('question-overlay').hidden = false;
  const first = $('q-body').querySelector('.q-option, .q-input');
  if (first) first.focus();
}

function hideQuestion() {
  $('question-overlay').hidden = true;
  currentQuestion = null;
}

function renderQuestion(req) {
  const body = $('q-body');
  body.innerHTML = '';
  $('q-title').textContent = (req.input && req.input.title) || 'Claude 想问你';

  const questions = Array.isArray(req.questions) ? req.questions : [];
  req.__fields = [];

  questions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'q-block';

    const head = document.createElement('div');
    head.className = 'q-head';
    if (q.header) {
      const chip = document.createElement('span');
      chip.className = 'q-chip';
      chip.textContent = String(q.header).slice(0, 20);
      head.appendChild(chip);
    }
    const text = document.createElement('div');
    text.className = 'q-text';
    text.textContent = q.question || `问题 ${qi + 1}`;
    head.appendChild(text);
    block.appendChild(head);

    const kind = q.kind || 'choice';

    // 开放式问题（text/number）直接输入；没有选项的 choice 也按文本处理
    if (kind === 'text' || kind === 'number' || !Array.isArray(q.options) || q.options.length === 0) {
      const input = document.createElement('input');
      input.className = 'q-input';
      if (kind === 'number') {
        input.type = 'number';
        if (Number.isFinite(q.min)) input.min = String(q.min);
        if (Number.isFinite(q.max)) input.max = String(q.max);
        if (Number.isFinite(q.step)) input.step = String(q.step);
        if (Number.isFinite(q.defaultValue)) input.value = String(q.defaultValue);
      } else {
        input.type = 'text';
        if (q.placeholder) input.placeholder = String(q.placeholder);
      }
      block.appendChild(input);
      req.__fields.push({ question: q.question, type: 'text', input });
    } else {
      const multi = q.multiSelect === true;
      const optionsEl = document.createElement('div');
      optionsEl.className = 'q-options';
      const buttons = [];

      for (const opt of q.options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'q-option';
        btn.dataset.label = String(opt.label || '');

        const labelEl = document.createElement('span');
        labelEl.className = 'q-option-label';
        labelEl.textContent = String(opt.label || '');
        btn.appendChild(labelEl);

        if (opt.description) {
          const descEl = document.createElement('span');
          descEl.className = 'q-option-desc';
          descEl.textContent = String(opt.description);
          btn.appendChild(descEl);
        }

        btn.addEventListener('click', () => {
          if (multi) {
            btn.classList.toggle('selected');
          } else {
            for (const b of buttons) b.classList.remove('selected');
            btn.classList.add('selected');
          }
        });
        buttons.push(btn);
        optionsEl.appendChild(btn);
      }
      block.appendChild(optionsEl);

      const customWrap = document.createElement('div');
      customWrap.className = 'q-custom';
      const custom = document.createElement('input');
      custom.type = 'text';
      custom.className = 'q-input';
      custom.placeholder = '其他（可选，自行输入）';
      customWrap.appendChild(custom);
      block.appendChild(customWrap);

      req.__fields.push({
        question: q.question,
        type: multi ? 'multi' : 'single',
        buttons,
        input: custom,
      });
    }

    body.appendChild(block);
  });

  if (!questions.length) {
    const empty = document.createElement('div');
    empty.className = 'q-text';
    empty.textContent = '（没有可显示的问题）';
    body.appendChild(empty);
  }
}

/** 收集每道题的选择；未作答的题不写入 answers */
function collectAnswers(req) {
  const answers = {};
  for (const field of req.__fields || []) {
    if (!field.question) continue;
    if (field.type === 'text') {
      const v = field.input.value.trim();
      if (v) answers[field.question] = v;
      continue;
    }
    const labels = field.buttons
      .filter((b) => b.classList.contains('selected'))
      .map((b) => b.dataset.label)
      .filter(Boolean);
    const custom = field.input.value.trim();
    let value = '';
    if (custom) {
      value = labels.length && field.type === 'multi' ? `${labels.join(', ')}, ${custom}` : custom;
    } else if (labels.length) {
      value = labels.join(', ');
    }
    if (value) answers[field.question] = value;
  }
  return answers;
}

function respondQuestion(skip) {
  const req = currentQuestion;
  if (!req) return;
  const answers = skip ? {} : collectAnswers(req);
  hideQuestion();

  window.api.answerQuestion({
    requestId: req.requestId,
    toolUseId: req.toolUseId,
    input: req.input,
    answers,
  });

  const entries = Object.entries(answers);
  if (entries.length) {
    addSystem(`已回答：${entries.map(([q, a]) => `${q} → ${a}`).join('；')}`);
  }

  showNextQuestion();
}

// ---------------------------------------------------------------- 事件

window.api.onEvent((ev) => {
  if (E2E && !(ev.type === 'stream' && ev.phase === 'delta')) {
    console.log('[e2e] event', ev.type, JSON.stringify(ev).slice(0, 300));
  }
  switch (ev.type) {
    case 'session':
      state.sessionId = ev.sessionId;
      if (!state.resumeId) state.resumeId = ev.sessionId;
      if (ev.cwd) state.cwd = ev.cwd;
      updateCwd();
      if (ev.model && !state.model) state.model = ev.model;
      updateModelLabel();
      if (state.pendingModel) {
        window.api.setModel(state.pendingModel);
        state.pendingModel = null;
      }
      if ($('title').textContent === '新会话') {
        $('title').textContent = baseName(ev.cwd || state.cwd) || 'Claude 会话';
      }
      break;

    case 'control':
      if (ev.model) {
        state.model = ev.model;
        updateModelLabel();
        addSystem(`已切换模型：${modelLabel(ev.model)}`);
      }
      if (ev.mode) {
        state.permissionMode = ev.mode;
        localStorage.setItem('cds.permissionMode', ev.mode);
        updateModeLabel();
      }
      if (ev.error) addSystem(`操作失败：${ev.error}`, true);
      break;

    case 'status':
      if (PERF) perfLog(`status-${ev.state}`);
      setStatus(ev.state);
      if (ev.state === 'starting' && state.running) showWorking('正在启动 Claude…');
      if (ev.state === 'ready' && state.running) showWorking('等待模型响应…');
      if (ev.state === 'idle') {
        setRunning(false);
        hideWorking();
        // 进程退出时不要留下无法回答的权限/提问弹窗
        permQueue = [];
        hidePermission();
        questionQueue = [];
        hideQuestion();
      }
      break;

    case 'stream':
      handleStream(ev);
      break;

    case 'block':
      if (ev.kind === 'assistant') {
        // 已经逐字渲染过的同一条消息，跳过完整文本，避免重复
        if (!isStreamedDuplicate(ev.messageId, ev.text)) addMessage('assistant', ev.text);
      } else if (ev.kind === 'thinking') addThinking(ev.text);
      else if (ev.kind === 'tool_use') {
        addToolUse(ev);
        if (state.running) showWorking(`正在执行 ${ev.name}…`);
      } else if (ev.kind === 'tool_result') {
        addToolResult(ev);
        if (state.running) showWorking('等待模型响应…');
      }
      break;

    case 'permission':
      enqueuePermission(ev);
      break;

    case 'question':
      enqueueQuestion(ev);
      if (E2E) {
        console.log('[e2e] question', JSON.stringify(ev.questions).slice(0, 300));
        setTimeout(() => {
          const first = document.querySelector('#q-body .q-option');
          if (first) first.click();
          $('q-submit').click();
          console.log('[e2e] question answered, label=', JSON.stringify($('q-title').textContent));
        }, 500);
      }
      break;

    case 'result':
      perfLog('ui-result');
      hideWorking();
      addMeta(ev);
      if (ev.isError) {
        const detail = ev.result ? `：${ev.result}` : '';
        addSystem(`请求失败（${ev.subtype || 'error'}）${detail}`, true);
      }
      setRunning(false);
      loadSessions();
      if (E2E) {
        const rendered = [...messagesEl.querySelectorAll('.msg')].map(
          (el) => `${el.className}: ${el.innerText.trim().slice(0, 60)}`
        );
        console.log('[e2e] rendered', JSON.stringify(rendered), 'deltas=', e2eDeltaCount);
        const firstAssistant = messagesEl.querySelector('.msg.assistant');
        if (firstAssistant) firstAssistant.scrollIntoView({ block: 'start' });
        // 仅测试模式：展开所有尚未展开的工具卡片，方便截图检查 Bash/Read 视图
        document.querySelectorAll('.tool-head').forEach((head) => {
          if (head.getAttribute('aria-expanded') === 'false') head.click();
        });

        const params = new URLSearchParams(location.search);
        if (params.get('switch') === '1' && !window.__switchTested) {
          window.__switchTested = true;
          (async () => {
            const id = state.sessionId;
            const cwd = state.cwd;
            await openSession({ id, cwd, title: '切换测试', mtime: Date.now() });
            console.log(
              '[e2e] after-switch label=', JSON.stringify($('model-label').textContent),
              'models=', (state.models || []).length,
              'visible=', $('model-label').textContent.trim().length > 0
            );
            window.api.e2eDone();
          })();
          return;
        }
        if (params.get('second') === '1' && !window.__secondSent) {
          window.__secondSent = true;
          setTimeout(async () => {
            inputEl.value = '再回复两个字：好的';
            await send();
          }, 300);
        } else {
          window.api.e2eDone();
        }
      }
      break;

    case 'error':
      addSystem(ev.message, true);
      setRunning(false);
      hideWorking();
      permQueue = [];
      hidePermission();
      questionQueue = [];
      hideQuestion();
      break;

    case 'stderr':
      // 只展示真正的错误，忽略 CLI 的进度/警告噪声
      if (ev.text && /error|failed|fatal|exception|not found|无法|失败|超时/i.test(ev.text)) {
        addSystem(ev.text, true);
      }
      break;
  }
});

// ---------------------------------------------------------------- 输入

function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
}

/** 启动/发送失败时把用户输入和附件放回输入框，避免消息凭空消失 */
async function restoreDraft(userEl, draftText, draftImages) {
  if (userEl && userEl.parentNode) userEl.remove();
  inputEl.value = draftText;
  attachments = draftImages;
  await renderAttachments();
  autoResize();
  inputEl.focus();
}

async function send() {
  const text = inputEl.value.trim();
  if ((!text && attachments.length === 0) || state.running) return;

  if (!state.cwd) {
    addSystem('尚未选择项目文件夹，请选择一个目录…');
    const folder = await window.api.pickFolder();
    if (!folder) {
      addSystem('已取消选择项目，消息未发送。');
      return;
    }
    state.cwd = folder;
    updateCwd();
  }

  perfSendAt = performance.now();
  perfFirstDeltaLogged = false;
  perfLog('ui-send');

  const draftText = inputEl.value;
  const images = [...attachments];
  const draftImages = [...attachments];

  // 先进入 running，避免渲染附件/启动/发送的 await 期间被重复提交
  setRunning(true);
  resetStream();
  let userEl = null;
  try {
    userEl = await addUserMessage(text, images);
  } catch {
    setRunning(false);
    await restoreDraft(null, draftText, draftImages);
    addSystem('渲染附件失败，消息未发送。', true);
    return;
  }
  showWorking('正在发送…');
  setTimeout(() => {
    if (state.running) showWorking('等待模型响应…');
  }, 400);

  inputEl.value = '';
  attachments = [];
  await renderAttachments();
  hideSlash();
  autoResize();

  let res;
  try {
    res = await window.api.start({
      cwd: state.cwd,
      resumeId: state.resumeId,
      permissionMode: state.permissionMode,
    });
  } catch (err) {
    res = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  if (!res || !res.ok) {
    setRunning(false);
    hideWorking();
    setStatus('idle');
    await restoreDraft(userEl, draftText, draftImages);
    const detail = res && res.error ? `：${res.error}` : '，请确认 claude 在 PATH 中';
    addSystem(`启动 Claude 失败${detail}。`, true);
    return;
  }

  let sent = false;
  try {
    sent = await window.api.send({ text, images });
  } catch {
    sent = false;
  }
  if (!sent) {
    setRunning(false);
    hideWorking();
    setStatus('idle');
    await restoreDraft(userEl, draftText, draftImages);
    addSystem('消息发送失败：Claude 进程未就绪，请重试。', true);
  }
}

// 输入法组合状态（中文输入时 Enter 用于上屏，不应触发发送）
let composing = false;
let enterHandled = false;

inputEl.addEventListener('compositionstart', () => { composing = true; });
inputEl.addEventListener('compositionend', () => { composing = false; });

function isEnterEvent(e) {
  return e.key === 'Enter' || e.keyCode === 13;
}

function isComposingEvent(e) {
  return e.isComposing || composing || e.keyCode === 229;
}

inputEl.addEventListener('keydown', (e) => {
  if (E2E) {
    console.log('[e2e] keydown', e.key, 'code=', e.keyCode, 'composing=', e.isComposing,
      'valueLen=', inputEl.value.length, 'slashHidden=', slashMenuEl.hidden, 'running=', state.running);
  }

  // 斜杠菜单打开时优先处理导航
  if (!slashMenuEl.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashActive = Math.min(slashActive + 1, slashItems.length - 1);
      renderSlash();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashActive = Math.max(slashActive - 1, 0);
      renderSlash();
      return;
    }
    if ((isEnterEvent(e) || e.key === 'Tab') && slashItems.length) {
      e.preventDefault();
      enterHandled = true; // 避免 keyup 再触发一次发送
      chooseSlash(slashActive);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideSlash();
      return;
    }
    if (isEnterEvent(e)) hideSlash(); // 无匹配项时，按 Enter 继续走发送
  }

  if (isEnterEvent(e) && !e.shiftKey && !isComposingEvent(e)) {
    e.preventDefault();
    enterHandled = true;
    send();
  }
});

// 兜底：某些输入法会把 keydown 吞掉，只在 keyup 留下 Enter
inputEl.addEventListener('keyup', (e) => {
  if (!isEnterEvent(e)) return;
  if (enterHandled) {
    enterHandled = false;
    return;
  }
  if (e.shiftKey || isComposingEvent(e)) return;
  e.preventDefault();
  send();
});

inputEl.addEventListener('input', () => {
  autoResize();
  updateSlashMenu();
});

$('send').addEventListener('click', send);
$('stop').addEventListener('click', () => {
  window.api.stop();
  // 清掉未处理的权限/提问请求，避免写入已终止的会话或残留弹窗
  permQueue = [];
  hidePermission();
  questionQueue = [];
  hideQuestion();
  resetStream();
  setRunning(false);
  setStatus('idle');
  hideWorking();
});
$('new-chat').addEventListener('click', newChat);

$('model-label').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleModelMenu();
});

$('theme-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleThemeMenu();
});

$('mode-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  toggleModeMenu();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.top-right')) {
    closeModelMenu();
    closeThemeMenu();
  }
  if (!e.target.closest('.composer-wrap')) closeModeMenu();
});

// Markdown 链接统一交给系统浏览器（包括流式阶段尚未 enhance 的链接）
messagesEl.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.href) window.api.openExternal(a.href);
});

// 用户上翻时显示「回到底部」，不要在流式输出中强行拽回去
messagesEl.addEventListener('scroll', updateScrollButton, { passive: true });
$('scroll-bottom').addEventListener('click', () => scrollBottom());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModelMenu();
    closeThemeMenu();
    closeModeMenu();
  }
});

$('attach').addEventListener('click', async () => {
  const paths = await window.api.pickImages();
  for (const p of paths) await addAttachment(p);
});

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) await handleDroppedFiles(e.dataTransfer.files);
});

inputEl.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && (file.type || '').startsWith('image/')) files.push(file);
  }
  if (!files.length) return;

  // 剪贴板截图没有磁盘路径，必须走 data URL
  e.preventDefault();
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      addSystem('图片过大（单张上限 20MB）。');
      continue;
    }
    await addAttachmentDataUrl(await fileToDataUrl(file), file.name);
  }
});

$('perm-allow').addEventListener('click', () => respondPermission(true, false));
$('perm-deny').addEventListener('click', () => respondPermission(false, false));
$('perm-always').addEventListener('click', () => respondPermission(true, true));

$('q-submit').addEventListener('click', () => respondQuestion(false));
$('q-skip').addEventListener('click', () => respondQuestion(true));

// 提问弹窗内 Enter 提交（输入框里也适用）；Esc 跳过当前提问
$('question-overlay').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    respondQuestion(true);
    return;
  }
  // 只在文本输入框里用 Enter 提交；选项按钮上的 Enter 保留默认的“选中”行为
  if (e.key === 'Enter' && !e.shiftKey && e.target && e.target.classList.contains('q-input')) {
    e.preventDefault();
    respondQuestion(false);
  }
});

// ---------------------------------------------------------------- 启动

setStatus('idle');
showEmpty();
updateCwd();
updateModeLabel();
updateScrollButton();
initTheme();
initModels();
loadSessions();
inputEl.focus();

// 端到端测试：自动发一条不需要工具的问候
if (E2E) {
  const params = new URLSearchParams(location.search);
  const cwd = params.get('cwd');
  state.cwd = cwd;
  updateCwd();
  setTimeout(() => window.api.e2eDone(), 60000);

  // enter=1：由主进程模拟真实按键，此处不自动发送
  if (params.get('enter') !== '1') {
    setTimeout(async () => {
      const cmds = await window.api.listCommands(cwd);
      console.log('[e2e] commands', JSON.stringify(cmds.map((c) => `${c.scope}:${c.name}`)));
      await initModels();
      const m = await window.api.listModels();
      console.log('[e2e] models', JSON.stringify(m));

      inputEl.value = '/';
      await updateSlashMenu();
      await new Promise((r) => setTimeout(r, 150));
      console.log('[e2e] slash items=', document.querySelectorAll('.slash-item').length, 'hidden=', slashMenuEl.hidden);
      inputEl.value = '';
      hideSlash();

      const prompt = params.get('prompt') || '只回复两个字：你好';
      const model = params.get('model');
      if (model) state.pendingModel = model;
      renderModelMenu();
      console.log('[e2e] model menu items=', document.querySelectorAll('.model-item').length);
      closeModelMenu();

      // 走真实的发送路径（含 UI 渲染、启动进程、写 stdin）
      if (params.get('prewarm') === '1') {
        await prewarm();
        console.log('[e2e] prewarmed');
        await new Promise((r) => setTimeout(r, 1500));
      }

      if (params.get('yolo') === '1') {
        await prewarm();
        await new Promise((r) => setTimeout(r, 1600));
        await selectPermissionMode('bypassPermissions');
        console.log('[e2e] yolo enabled, label=', $('mode-btn').textContent);
        await new Promise((r) => setTimeout(r, 1000));
      }

      inputEl.value = prompt;
      await send();
      console.log('[e2e] working visible=', !$('working').hidden, 'text=', $('working-text').textContent);
      console.log('[e2e] mode-label', $('mode-btn').textContent, 'theme', state.theme);

      if (params.get('yolo') !== '1') {
        await selectPermissionMode('acceptEdits');
        console.log('[e2e] mode-after', $('mode-btn').textContent);
      }

      const themeBefore = await window.api.getTheme();
      await window.api.setTheme('dark');
      console.log('[e2e] theme', themeBefore, '->', await window.api.getTheme());
      await window.api.setTheme(themeBefore);
    }, 300);
  }
}
