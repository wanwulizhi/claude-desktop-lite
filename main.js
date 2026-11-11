'use strict';

/**
 * Claude Desktop Lite — Electron 主进程
 *
 * 职责：
 *  1. 扫描 ~/.claude/projects/*.jsonl，提供会话列表与历史
 *  2. spawn `claude` CLI，走双向 stream-json
 *  3. 把 CLI 的 control_request(can_use_tool) 转给渲染进程弹卡片
 *  4. 把用户决定写回 stdin (control_response)
 */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, session, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const HISTORY_PAGE_SIZE = 300;
const HISTORY_CACHE_MAX = 4;
const INIT_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TOOL_RESULT_LIMIT = 50000;

/** 会话列表的标题/cwd 缓存：文件 mtime+size 不变就不重读头部 */
const sessionMetaCache = new Map();
/** 已解析的历史块缓存：分页时避免反复解析整个 jsonl */
const historyCache = new Map();

let win = null;
/** 当前唯一的会话进程 */
let runtime = null; // { child, key, sessionId, cwd, resumeId }

const PERF = !!process.env.CDS_PERF;
function perf(label, extra = '') {
  if (PERF) console.log(`[perf] ${label} ${extra}`);
}

// ---------------------------------------------------------------- 窗口

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** 恢复上次窗口位置；位置不在任何显示器可见区域时只恢复尺寸 */
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return {};
    const bounds = {
      width: Math.max(900, Math.round(s.width)),
      height: Math.max(600, Math.round(s.height)),
    };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const display = screen.getDisplayMatching({
        x: s.x, y: s.y, width: bounds.width, height: bounds.height,
      });
      const wa = display.workArea;
      const visible = s.x < wa.x + wa.width - 80 && s.x + bounds.width > wa.x + 80 &&
                      s.y < wa.y + wa.height - 80 && s.y + bounds.height > wa.y + 80;
      if (visible) {
        bounds.x = Math.round(s.x);
        bounds.y = Math.round(s.y);
      }
    }
    return bounds;
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify(b));
  } catch { /* ignore */ }
}

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 860,
    ...(saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a17' : '#fbfaf7',
    autoHideMenuBar: true,
    title: 'Claude Desktop Lite',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  const e2e = !!(process.env.CDS_E2E || process.env.CDS_E2E_ENTER);
  const query = e2e
    ? {
        e2e: '1',
        cwd: process.cwd(),
        prompt: process.env.CDS_E2E_PROMPT || '只回复两个字：你好',
        model: process.env.CDS_E2E_MODEL || '',
        perf: process.env.CDS_PERF ? '1' : '',
        second: process.env.CDS_E2E_SECOND ? '1' : '',
        prewarm: process.env.CDS_E2E_PREWARM ? '1' : '',
        switch: process.env.CDS_E2E_SWITCH ? '1' : '',
        yolo: process.env.CDS_E2E_YOLO ? '1' : '',
      }
    : undefined;
  if (process.env.CDS_E2E_ENTER) query.enter = '1';
  win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    e2e ? { query } : undefined
  );

  // 外链一律交给系统浏览器，防止点击链接后整个窗口离开 GUI
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const current = win.webContents.getURL();
    // 允许页内锚点（只有 hash 变化）
    if (url.split('#')[0] === current.split('#')[0]) return;
    e.preventDefault();
    openExternalSafe(url);
  });

  // 冒烟/端到端测试：转发渲染进程日志
  if (process.env.CDS_SMOKE || e2e) {
    win.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    win.webContents.on('did-finish-load', () => console.log('[main] did-finish-load'));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[main] did-fail-load', code, desc));
    win.webContents.on('render-process-gone', (_e, details) => console.log('[main] renderer gone', JSON.stringify(details)));
  }

  // 真实按键测试：模拟输入文字并按 Enter
  if (process.env.CDS_E2E_ENTER) {
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 900));
      win.focus();
      win.webContents.focus();
      win.webContents.insertText('只回复两个字：你好');
      const val = await win.webContents.executeJavaScript('document.getElementById("input").value');
      console.log('[enter-test] value after insertText =', JSON.stringify(val));
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      console.log('[enter-test] typed and pressed Enter');
    });
  }

  // 截图（开发用）：CDS_SHOT=<png 路径>（E2E 模式下改为收到 result 后截图）
  if (process.env.CDS_SHOT && !e2e) {
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.CDS_SHOT, img.toPNG());
      console.log('[shot] saved', process.env.CDS_SHOT);
      app.quit();
    });
  }

  // 冒烟测试：CDS_SMOKE=1 时加载完自动退出
  if (process.env.CDS_SMOKE) {
    win.webContents.on('did-finish-load', () => {
      console.log('[smoke] renderer loaded');
      setTimeout(() => app.quit(), 3000);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[smoke] load failed', code, desc);
      app.quit();
    });
  }
}

// 测试隔离：允许用独立 userData 跑开发版，避免和正在运行的打包版抢单实例锁
if (process.env.CDS_USER_DATA) {
  try { app.setPath('userData', process.env.CDS_USER_DATA); } catch { /* ignore */ }
}

// 单实例：第二个进程直接聚焦已有窗口，避免两个 CLI 同时写同一个会话
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.claudedesktoplite.app');

    // 渲染进程不需要摄像头/麦克风等权限；只允许剪贴板写入（代码复制按钮）
    const allowedPermissions = new Set(['clipboard-sanitized-write']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission));

    // 开发用：清空应用偏好（localStorage）
    if (process.env.CDS_RESET_PREFS) {
      try { await session.defaultSession.clearStorageData({ storages: ['localstorage'] }); } catch { /* ignore */ }
      console.log('[reset] localStorage cleared');
      app.quit();
      return;
    }

    // 开发用：CDS_THEME=light|dark 强制主题（截图测试）
    if (process.env.CDS_THEME) nativeTheme.themeSource = process.env.CDS_THEME;
    createWindow();
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('window-all-closed', () => {
  stopRuntime();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopRuntime);

function send(type, data = {}) {
  if (win && !win.isDestroyed()) win.webContents.send('chat:event', { type, ...data });
}

/** 只允许 http(s) 外链交给系统浏览器 */
function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
  } catch { /* ignore invalid URL */ }
}

// ---------------------------------------------------------------- 会话扫描

/** 只读文件头部，避免把几百 MB 的 jsonl 全读进来 */
function readHead(file, bytes = 96 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function mediaTypeFor(file) {
  return IMAGE_MEDIA[path.extname(file).toLowerCase()] || null;
}

function walkMarkdown(dir, prefix = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const nextPrefix = prefix ? `${prefix}:${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...walkMarkdown(full, nextPrefix));
    } else if (e.name.endsWith('.md')) {
      out.push({ name: nextPrefix.replace(/\.md$/, ''), file: full });
    }
  }
  return out;
}

function readCommandDescription(file) {
  const head = readHead(file, 8192);
  const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const m = fm[1].match(/^description:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/** 扫描 user(~/.claude/commands) 与 project(<cwd>/.claude/commands) 的自定义命令 */
function readSettings() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/** 从 settings.json 的 env 里整理出可用模型 */
function listModels() {
  const env = readSettings().env || {};
  const pairs = [
    ['ANTHROPIC_MODEL', 'ANTHROPIC_MODEL_NAME'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
    ['ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'],
  ];

  const models = [];
  const seen = new Set();
  for (const [key, nameKey] of pairs) {
    const id = env[key];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: env[nameKey] || id,
      slot: key === 'ANTHROPIC_MODEL'
        ? 'default'
        : key.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase(),
    });
  }
  return { current: env.ANTHROPIC_MODEL || '', models };
}

function listCommands(cwd) {
  const out = [];
  const userDir = path.join(os.homedir(), '.claude', 'commands');
  for (const c of walkMarkdown(userDir)) {
    out.push({ ...c, scope: 'user', description: readCommandDescription(c.file) });
  }
  if (cwd) {
    const projectDir = path.join(cwd, '.claude', 'commands');
    for (const c of walkMarkdown(projectDir)) {
      out.push({ ...c, scope: 'project', description: readCommandDescription(c.file) });
    }
  }
  // 项目命令排前面
  out.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1));
  return out;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}

/** 只解析文件头部，提取标题与 cwd；结果按 mtime+size 缓存 */
function parseSessionHead(full) {
  let title = '';
  let cwd = '';
  let head;
  try { head = readHead(full); } catch { return { title, cwd }; }
  for (const line of head.split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (!title && rec.type === 'user' && rec.message) {
      const t = textFromContent(rec.message.content).trim();
      // 跳过 CLI 注入的系统消息（<local-command-caveat>、<system-reminder> 等）
      if (t && !t.startsWith('<')) title = t.replace(/\s+/g, ' ').slice(0, 80);
    }
    if (cwd && title) break;
  }
  return { title, cwd };
}

function listSessions() {
  const out = [];
  if (!fs.existsSync(PROJECTS_DIR)) return out;

  let dirNames;
  try { dirNames = fs.readdirSync(PROJECTS_DIR); } catch { return out; }
  const seen = new Set();

  for (const dirName of dirNames) {
    const dir = path.join(PROJECTS_DIR, dirName);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;

    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const full = path.join(dir, file);
      let fst;
      try { fst = fs.statSync(full); } catch { continue; }
      if (!fst.isFile()) continue;
      seen.add(full);

      const cached = sessionMetaCache.get(full);
      let meta;
      if (cached && cached.mtime === fst.mtimeMs && cached.size === fst.size) {
        meta = cached;
      } else {
        meta = { ...parseSessionHead(full), mtime: fst.mtimeMs, size: fst.size };
        sessionMetaCache.set(full, meta);
      }

      out.push({
        id: file.replace(/\.jsonl$/, ''),
        cwd: meta.cwd,
        title: meta.title || file,
        mtime: fst.mtimeMs,
      });
    }
  }

  // 清掉已删除会话的缓存
  for (const key of sessionMetaCache.keys()) {
    if (!seen.has(key)) sessionMetaCache.delete(key);
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 300);
}

/** 把一条 jsonl 记录映射成渲染块；push 由调用方决定是否截断 */
function appendHistoryRecord(rec, push, onCwd) {
  if (rec.cwd) onCwd(rec.cwd);
  if (rec.isSidechain) return;
  if (rec.type !== 'user' && rec.type !== 'assistant') return;

  const content = rec.message && rec.message.content;
  if (!content) return;

  if (typeof content === 'string') {
    // 跳过 CLI 注入的系统文本
    if (rec.type === 'user' && content.trim().startsWith('<')) return;
    push({ kind: rec.type === 'user' ? 'user' : 'assistant', text: content });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const b of content) {
    if (!b || !b.type) continue;
    if (b.type === 'text' && b.text.trim()) {
      if (rec.type === 'user' && b.text.trim().startsWith('<')) continue;
      push({ kind: rec.type === 'user' ? 'user' : 'assistant', text: b.text });
    } else if (b.type === 'tool_use') {
      push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
    } else if (b.type === 'tool_result') {
      const full = textFromContent(b.content);
      push({
        kind: 'tool_result',
        toolUseId: b.tool_use_id,
        isError: !!b.is_error,
        text: full.slice(0, TOOL_RESULT_LIMIT),
        truncated: full.length > TOOL_RESULT_LIMIT,
        totalLength: full.length,
      });
    }
  }
}

function findCwdInHead(file) {
  try {
    for (const line of readHead(file, 8192).split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.cwd) return rec.cwd;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 解析整个会话文件并按 mtime+size 缓存。
 * 分页只在这份数组上切片，避免每次「加载更早」都重新解析 10MB 的 jsonl。
 */
async function parseHistoryFile(file) {
  const st = fs.statSync(file);
  const cached = historyCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }

  const items = [];
  let cwd = '';
  const push = (item) => items.push(item);
  const onCwd = (value) => { cwd = value; };

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      appendHistoryRecord(rec, push, onCwd);
    }
  } catch { /* 返回已经解析的部分 */ }

  if (!cwd) cwd = findCwdInHead(file);

  const entry = { mtimeMs: st.mtimeMs, size: st.size, items, cwd };
  historyCache.set(file, entry);
  if (historyCache.size > HISTORY_CACHE_MAX) {
    historyCache.delete(historyCache.keys().next().value);
  }
  return entry;
}

/** 在 ~/.claude/projects 的各子目录下按会话 ID 定位 jsonl；ID 已做白名单校验 */
function findSessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  let dirNames;
  try { dirNames = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const dirName of dirNames) {
    const full = path.join(PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(full).isFile()) return full;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * 分页读取会话历史。
 *  - 不传 before：返回最后一页
 *  - 传 before：返回 nextBefore 之前的一页
 */
async function loadHistory(sessionId, opts = {}) {
  const empty = { id: sessionId, cwd: '', items: [], hasMore: false, nextBefore: 0, total: 0 };
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return empty;
  const file = findSessionFile(sessionId);
  if (!file) return empty;

  let entry;
  try { entry = await parseHistoryFile(file); } catch { return empty; }

  const total = entry.items.length;
  const limitRaw = Number.parseInt(opts?.limit, 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : HISTORY_PAGE_SIZE, 1), 1000);

  const beforeRaw = typeof opts?.before === 'number'
    ? opts.before
    : Number.parseInt(opts?.before, 10);
  const before = Number.isInteger(beforeRaw)
    ? Math.min(Math.max(beforeRaw, 0), total)
    : total;

  const start = Math.max(0, before - limit);
  return {
    id: sessionId,
    cwd: entry.cwd,
    items: entry.items.slice(start, before),
    hasMore: start > 0,
    nextBefore: start,
    total,
  };
}

// ---------------------------------------------------------------- 删除会话

/** CLI 为每个会话生成的派生数据（文件历史、环境快照等） */
const SESSION_SIDECAR_DIRS = [
  path.join(os.homedir(), '.claude', 'file-history'),
  path.join(os.homedir(), '.claude', 'session-env'),
];

function runtimeUsesSession(sessionId) {
  return !!runtime && (runtime.sessionId === sessionId || runtime.resumeId === sessionId);
}

/** 停止当前 CLI 进程并等待退出；Windows 上进程仍持有文件句柄时无法删除 */
function stopRuntimeAndWait(timeoutMs = 1500) {
  const child = runtime?.child;
  if (!child) { stopRuntime(); return Promise.resolve(); }

  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.once('exit', done);
    stopRuntime();
  });
}

/** 优先丢进回收站；失败时重试，最后降级为永久删除 */
async function trashOrUnlink(file) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      await shell.trashItem(file);
      return 'trash';
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  try {
    await fs.promises.unlink(file);
    return 'unlink';
  } catch (err) {
    lastErr = err;
  }
  throw lastErr;
}

async function deleteSession(sessionId, title) {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: '无效的会话 ID' };
  }

  const file = findSessionFile(sessionId);
  if (!file) return { ok: false, error: '会话文件不存在，可能已被删除' };

  if (win && !win.isDestroyed()) {
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '删除'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: '删除对话',
      message: '确定要删除这个对话吗？',
      detail: `“${String(title || sessionId).slice(0, 120)}”\n\n会话文件会被移到回收站。`,
    });
    if (choice.response !== 1) return { ok: false, canceled: true };
  }

  // 先停掉正在写这个会话的 CLI，避免文件被占用或被重新创建
  if (runtimeUsesSession(sessionId)) await stopRuntimeAndWait();

  let mode;
  try {
    mode = await trashOrUnlink(file);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }

  sessionMetaCache.delete(file);
  historyCache.delete(file);

  // 清理派生数据；失败不影响主流程
  const projectDir = path.dirname(file);
  const sidecars = [
    path.join(projectDir, sessionId), // 子代理 transcript 等
    ...SESSION_SIDECAR_DIRS.map((dir) => path.join(dir, sessionId)),
  ];
  for (const p of sidecars) {
    try {
      const st = await fs.promises.lstat(p);
      if (st.isDirectory()) await fs.promises.rm(p, { recursive: true, force: true });
      else await fs.promises.unlink(p);
    } catch { /* 不存在或无法删除 */ }
  }

  return { ok: true, trashed: mode === 'trash' };
}

// ---------------------------------------------------------------- CLI 进程

function stopRuntime() {
  if (!runtime?.child) { runtime = null; return; }
  const { child } = runtime;
  if (runtime.initTimer) {
    clearTimeout(runtime.initTimer);
    runtime.initTimer = null;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* ignore */ }
  runtime = null;
  send('status', { state: 'idle' });
}

/** 向当前 CLI 进程写一行 JSON；进程已退出/管道已断开时安全返回 false */
function writeStdin(payload) {
  const stdin = runtime?.child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) return false;
  try {
    stdin.write(JSON.stringify(payload) + '\n');
    return true;
  } catch {
    return false;
  }
}

function startRuntime({ cwd, resumeId, permissionMode }) {
  if (resumeId && (typeof resumeId !== 'string' || !SESSION_ID_RE.test(resumeId))) {
    send('error', { message: '无效的会话 ID，已取消启动。' });
    return { ok: false, error: '无效的会话 ID' };
  }

  const workdir = cwd || os.homedir();
  try {
    if (!fs.statSync(workdir).isDirectory()) throw new Error('not a directory');
  } catch {
    send('error', { message: `工作目录不存在：${workdir}` });
    return { ok: false, error: '工作目录不存在' };
  }

  const wanted = PERMISSION_MODES.has(permissionMode) ? permissionMode : 'default';
  const key = `${workdir}|${resumeId || ''}`;

  if (runtime && runtime.key === key && runtime.child && !runtime.child.killed) {
    if (runtime.permissionMode === wanted) return { ok: true, reused: true };

    // 非 bypass 模式可以热切换，避免重启丢失会话
    if (!(wanted === 'bypassPermissions' && !runtime.launchedBypass)) {
      if (writeStdin({
        type: 'control_request',
        request_id: `setmode-${Date.now()}`,
        request: { subtype: 'set_permission_mode', mode: wanted },
      })) {
        runtime.permissionMode = wanted;
        return { ok: true, reused: true, modeChanged: true };
      }
    }
    // 切到 bypass 需要带危险参数重启
  }

  stopRuntime();

  // 与官方 VS Code 扩展相同的启动方式
  const args = [
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    // 逐字流式：CLI 会额外发出 stream_event 增量
    '--include-partial-messages',
  ];
  if (resumeId) args.push('--resume', resumeId);

  // 权限模式：bypassPermissions 必须在启动时用危险参数
  if (wanted === 'bypassPermissions') {
    args.push('--dangerously-skip-permissions');
  } else if (wanted !== 'default') {
    args.push('--permission-mode', wanted);
  }

  const spawnAt = Date.now();
  let child;
  try {
    child = spawn('claude', args, {
      cwd: workdir,
      // Windows 上 claude 是 .cmd shim，必须走 shell 才能解析
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    send('error', { message: `无法启动 claude: ${err.message}` });
    return { ok: false };
  }

  runtime = {
    child,
    key,
    sessionId: resumeId || null,
    cwd: workdir,
    resumeId: resumeId || null,
    permissionMode: wanted,
    launchedBypass: wanted === 'bypassPermissions',
    initTimer: null,
  };
  send('status', { state: 'starting' });
  perf('spawn-called');
  child.on('spawn', () => perf('process-spawned', `+${Date.now() - spawnAt}ms pid=${child.pid}`));

  // CLI 一直不 init（登录失效、网络卡住）时不能让界面永远停在“启动中”
  runtime.initTimer = setTimeout(() => {
    if (runtime?.child !== child || runtime.sessionId) return;
    send('error', { message: `Claude CLI 初始化超时（${INIT_TIMEOUT_MS / 1000} 秒），请检查登录状态或网络。` });
    stopRuntime();
  }, INIT_TIMEOUT_MS);

  child.on('error', (err) => {
    // 只处理当前进程；已被替换的旧进程错误不打扰新会话
    if (runtime?.child !== child) return;
    if (runtime.initTimer) { clearTimeout(runtime.initTimer); runtime.initTimer = null; }
    send('error', { message: `claude 进程错误: ${err.message}（确认 claude 在 PATH 中）` });
    send('status', { state: 'idle' });
    runtime = null;
  });

  child.on('exit', (code) => {
    // 切会话/停止后旧进程退出时不能再改新会话状态
    if (runtime?.child !== child) return;
    if (runtime.initTimer) { clearTimeout(runtime.initTimer); runtime.initTimer = null; }
    send('status', { state: 'idle', code });
    runtime = null;
  });

  // CLI 退出后写 stdin 会触发 EPIPE；不监听会直接崩主进程
  child.stdin?.on('error', (err) => {
    console.error('[claude stdin]', err.message);
  });

  // stdout: JSONL 事件流
  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      // 旧进程残留的 stdout 不能追加到新会话
      if (runtime?.child !== child) return;
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      handleEvent(ev, child);
    });
  }

  // stderr: 只转发非噪声内容
  child.stderr?.on('data', (buf) => {
    if (runtime?.child !== child) return;
    const text = buf.toString('utf8').trim();
    if (text) send('stderr', { text });
  });

  return { ok: true };
}

function handleEvent(ev, child) {
  switch (ev.type) {
    case 'system': {
      if (ev.subtype === 'init') {
        perf('session-init', `+${Date.now() - (runtime?.sendAt || Date.now())}ms`);
        if (runtime) {
          if (runtime.initTimer) { clearTimeout(runtime.initTimer); runtime.initTimer = null; }
          runtime.sessionId = ev.session_id;
          // 新会话建立后，key 以真实 session id 为准，后续 start 才能复用进程
          runtime.key = `${runtime.cwd}|${ev.session_id}`;
        }
        send('session', {
          sessionId: ev.session_id,
          cwd: ev.cwd || runtime?.cwd,
          model: ev.model,
          tools: ev.tools,
        });
        send('status', { state: 'ready' });
      }
      break;
    }

    case 'assistant': {
      const blocks = ev.message?.content || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          send('block', { kind: 'assistant', text: b.text, messageId: ev.message?.id });
        } else if (b.type === 'tool_use') {
          send('block', { kind: 'tool_use', id: b.id, name: b.name, input: b.input });
        } else if (b.type === 'thinking' && b.thinking) {
          send('block', { kind: 'thinking', text: b.thinking });
        }
      }
      break;
    }

    case 'user': {
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) break;
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const full = textFromContent(b.content);
          send('block', {
            kind: 'tool_result',
            toolUseId: b.tool_use_id,
            isError: !!b.is_error,
            text: full.slice(0, TOOL_RESULT_LIMIT),
            truncated: full.length > TOOL_RESULT_LIMIT,
            totalLength: full.length,
          });
        }
      }
      break;
    }

    case 'result': {
      perf('result', `+${Date.now() - (runtime?.sendAt || Date.now())}ms`);
      send('result', {
        subtype: ev.subtype,
        isError: !!ev.is_error,
        durationMs: ev.duration_ms,
        totalCostUsd: ev.total_cost_usd,
        numTurns: ev.num_turns,
        result: typeof ev.result === 'string' ? ev.result.slice(0, 2000) : undefined,
      });
      send('status', { state: 'idle' });
      break;
    }

    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'message_start') {
        if (runtime) runtime.streamMessageId = e.message?.id || null;
        perf('message-start', `+${Date.now() - (runtime?.sendAt || Date.now())}ms`);
        send('stream', { phase: 'start', messageId: e.message?.id || null });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        if (runtime && !runtime.firstDeltaAt) {
          runtime.firstDeltaAt = Date.now();
          perf('first-delta', `+${Date.now() - (runtime.sendAt || Date.now())}ms`);
        }
        send('stream', { phase: 'delta', text: e.delta.text });
      } else if (e.type === 'message_stop') {
        send('stream', { phase: 'stop', messageId: runtime?.streamMessageId || null });
      }
      break;
    }

    case 'control_request': {
      handleControlRequest(ev, child);
      break;
    }

    case 'control_response': {
      const r = ev.response || {};
      send('control', {
        requestId: r.request_id,
        subtype: r.subtype,
        model: r.response && r.response.model,
        mode: r.response && r.response.mode,
        error: r.error,
      });
      break;
    }

    default:
      // stream_event / 其他：MVP 暂不处理
      break;
  }
}

function handleControlRequest(ev, child) {
  const req = ev.request || {};
  if (req.subtype !== 'can_use_tool') return;

  // AskUserQuestion 不是权限审批，而是模型向用户提问：
  // 必须把用户选择的答案写回 updatedInput.answers，否则工具会返回“用户未回答”。
  if (req.tool_name === 'AskUserQuestion') {
    send('question', {
      requestId: ev.request_id,
      toolUseId: req.tool_use_id,
      input: req.input || {},
      questions: (req.input && Array.isArray(req.input.questions)) ? req.input.questions : [],
    });
    send('status', { state: 'waiting-permission' });
    return;
  }

  send('permission', {
    requestId: ev.request_id,
    toolName: req.tool_name || 'Unknown',
    input: req.input || {},
    suggestions: req.permission_suggestions || [],
    decisionReason: req.decision_reason,
    toolUseId: req.tool_use_id,
  });
  send('status', { state: 'waiting-permission' });
}

/** 回答 AskUserQuestion：把选项写进 updatedInput.answers（问题文本 -> 答案） */
function sendQuestionAnswer({ requestId, toolUseId, input, answers, annotations }) {
  if (!runtime?.child?.stdin || runtime.child.stdin.destroyed) return false;
  if (typeof requestId !== 'string' || !requestId) return false;

  const cleanAnswers = {};
  if (answers && typeof answers === 'object') {
    for (const [k, v] of Object.entries(answers)) {
      if (typeof k === 'string' && typeof v === 'string' && v) cleanAnswers[k] = v;
    }
  }
  const cleanAnnotations = {};
  if (annotations && typeof annotations === 'object') {
    for (const [k, v] of Object.entries(annotations)) {
      if (typeof k !== 'string' || !v || typeof v !== 'object') continue;
      const note = {};
      if (typeof v.preview === 'string' && v.preview) note.preview = v.preview;
      if (typeof v.notes === 'string' && v.notes) note.notes = v.notes;
      if (Object.keys(note).length) cleanAnnotations[k] = note;
    }
  }

  const response = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'allow',
        // 必须保留原 questions（工具输入 schema 要求），再合并 answers
        updatedInput: {
          ...(input && typeof input === 'object' ? input : {}),
          answers: cleanAnswers,
          ...(Object.keys(cleanAnnotations).length ? { annotations: cleanAnnotations } : {}),
        },
        toolUseID: toolUseId,
      },
    },
  };
  if (!writeStdin(response)) return false;
  send('status', { state: 'running' });
  return true;
}

function sendPermissionResponse({ requestId, approved, always, toolUseId, suggestions, input }) {
  if (!runtime?.child?.stdin || runtime.child.stdin.destroyed) return;

  const response = approved

    ? {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            behavior: 'allow',
            updatedInput: input,
            // 选了「始终允许」：把 CLI 给出的建议回传，由 CLI 持久化
            updatedPermissions: always ? suggestions : undefined,
            toolUseID: toolUseId,
          },
        },
      }
    : {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: {
            behavior: 'deny',
            message: '用户拒绝了该操作',
            interrupt: true,
            toolUseID: toolUseId,
          },
        },
      };

  if (writeStdin(response)) send('status', { state: 'running' });
}

function setModel(model) {
  if (typeof model !== 'string' || !model.trim() || model.length > 200) {
    return { ok: false, error: '无效的模型' };
  }
  if (!runtime?.child?.stdin || runtime.child.stdin.destroyed) {
    return { ok: false, error: '会话尚未启动' };
  }
  const requestId = `setmodel-${Date.now()}`;
  const message = {
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'set_model', model },
  };
  if (!writeStdin(message)) return { ok: false, error: '会话已结束' };
  runtime.model = model;
  return { ok: true, requestId };
}

async function setPermissionMode(mode) {
  if (!runtime) return { ok: false, error: '会话尚未启动' };

  // bypass 模式只能在启动时开启，需要带 --resume 重启进程
  if (mode === 'bypassPermissions' && !runtime.launchedBypass) {
    const cwd = runtime.cwd;
    const resumeId = runtime.sessionId || runtime.resumeId || null;
    const oldChild = runtime.child;
    stopRuntime();

    // 等旧进程真正退出，避免 taskkill 的进程树清理影响新进程
    await new Promise((resolve) => {
      if (!oldChild || oldChild.exitCode !== null) return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      oldChild.once('exit', finish);
      setTimeout(finish, 800);
    });

    const res = startRuntime({ cwd, resumeId, permissionMode: mode });
    return { ok: !!(res && res.ok), restarted: true };
  }

  if (mode === 'bypassPermissions' && runtime.launchedBypass) {
    runtime.permissionMode = mode;
    return { ok: true };
  }

  if (!runtime.child?.stdin || runtime.child.stdin.destroyed) {
    return { ok: false, error: '会话未就绪' };
  }

  const requestId = `setmode-${Date.now()}`;
  if (!writeStdin({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'set_permission_mode', mode },
  })) {
    return { ok: false, error: '会话已结束' };
  }
  runtime.permissionMode = mode;
  return { ok: true, requestId };
}

async function sendUserMessage(input) {
  const rt = runtime;
  if (!rt?.child?.stdin) return false;

  const raw = typeof input === 'string' ? { text: input } : (input || {});
  const text = typeof raw.text === 'string' ? raw.text : '';
  const images = Array.isArray(raw.images) ? raw.images : [];

  const content = [];
  if (text.trim()) content.push({ type: 'text', text });

  for (const image of images) {
    // 剪贴板/浏览器拖入的图片没有磁盘路径，渲染进程直接传 data URL
    if (image && typeof image === 'object') {
      const m = /^data:(image\/[^;,]+);base64,(.+)$/s.exec(image.dataUrl || '');
      if (!m) continue;
      const base64 = m[2];
      // 单张上限 20MB，避免一次性灌爆 stdin
      if (!base64 || base64.length > 28 * 1024 * 1024) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: base64 },
      });
      continue;
    }

    const mediaType = mediaTypeFor(image);
    if (!mediaType) continue;
    try {
      const data = await fs.promises.readFile(image);
      // 读取期间可能已经切了会话
      if (runtime !== rt) return false;
      if (!data.length || data.length > MAX_IMAGE_BYTES) continue;
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
      });
    } catch { /* 跳过读不到的文件 */ }
  }

  if (!content.length) return false;
  if (runtime !== rt) return false;

  const payload = {
    type: 'user',
    session_id: rt.sessionId || '',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
  if (!writeStdin(payload)) return false;
  rt.sendAt = Date.now();
  rt.firstDeltaAt = 0;
  perf('stdin-write', `chars=${text.length}`);
  send('status', { state: 'running' });
  return true;
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('sessions:list', () => {
  const t = Date.now();
  const rows = listSessions();
  perf('list-sessions', `+${Date.now() - t}ms n=${rows.length}`);
  return rows;
});
ipcMain.handle('sessions:history', (_e, id, opts) => loadHistory(id, opts));
ipcMain.handle('sessions:delete', (_e, id, title) => deleteSession(id, title));

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择项目文件夹',
    properties: ['openDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('commands:list', (_e, cwd) => listCommands(cwd));
ipcMain.handle('models:list', () => listModels());
ipcMain.handle('chat:setModel', (_e, model) => setModel(model));
ipcMain.handle('chat:setPermissionMode', (_e, mode) => {
  if (!PERMISSION_MODES.has(mode)) return { ok: false, error: '无效的权限模式' };
  return setPermissionMode(mode);
});

ipcMain.handle('theme:get', () => nativeTheme.themeSource);
ipcMain.handle('theme:set', (_e, mode) => {
  if (['system', 'light', 'dark'].includes(mode)) nativeTheme.themeSource = mode;
  return nativeTheme.themeSource;
});

ipcMain.handle('files:pickImages', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('files:toDataUrl', async (_e, file) => {
  // 只允许图片，避免渲染进程借这个通道读任意文件
  const mediaType = mediaTypeFor(file);
  if (!mediaType) return null;
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;

    // 用 nativeImage 生成缩略图，避免把整张大图 base64 塞进 DOM
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      const { width } = img.getSize();
      const preview = width > 640 ? img.resize({ width: 640 }) : img;
      return preview.toDataURL();
    }

    const data = await fs.promises.readFile(file);
    return `data:${mediaType};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.handle('chat:start', (_e, opts) => startRuntime(opts || {}));
ipcMain.handle('chat:send', (_e, payload) => sendUserMessage(payload));
ipcMain.on('chat:permission', (_e, payload) => sendPermissionResponse(payload));
ipcMain.on('chat:answerQuestion', (_e, payload) => sendQuestionAnswer(payload || {}));
ipcMain.on('chat:stop', () => stopRuntime());

ipcMain.on('shell:openExternal', (_e, url) => openExternalSafe(url));

/** 工具卡片里的“打开文件/在资源管理器中显示”：只接受存在的绝对路径 */
async function validFilePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try {
    const st = await fs.promises.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (!(await validFilePath(p))) return false;
  const err = await shell.openPath(p);
  return !err;
});

ipcMain.handle('shell:showInFolder', async (_e, p) => {
  if (!(await validFilePath(p))) return false;
  shell.showItemInFolder(p);
  return true;
});

// 端到端测试钩子（仅在 CDS_E2E=1 时由渲染进程调用）
ipcMain.on('e2e:done', async () => {
  console.log('[e2e] done');
  if (process.env.CDS_SHOT && win && !win.isDestroyed()) {
    await new Promise((r) => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(process.env.CDS_SHOT, img.toPNG());
    console.log('[shot] saved', process.env.CDS_SHOT);
  }
  setTimeout(() => app.quit(), 300);
});
