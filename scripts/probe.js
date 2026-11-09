'use strict';

/**
 * 无 GUI 协议探针：
 *   node scripts/probe.js [工作目录]
 *
 * 验证三件事：
 *  1. `claude` 能否用 stream-json 双向模式启动
 *  2. 用户消息输入格式是否被接受
 *  3. 权限请求 (control_request/can_use_tool) 能否自动放行
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const cwd = process.argv[2] || process.cwd();
const prompt = process.argv[3] || '只回复两个字：你好';

const args = [
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
  '--permission-prompt-tool', 'stdio',
];
if (process.env.PROBE_STREAM === '1') args.push('--include-partial-messages');
if (process.env.PROBE_YOLO === '1') args.push('--dangerously-skip-permissions');
if (process.env.PROBE_NO_PPT === '1') { const i = args.indexOf('--permission-prompt-tool'); if (i >= 0) args.splice(i, 2); }

console.log('[probe] cwd =', cwd);
console.log('[probe] spawn claude', args.join(' '));

const child = spawn('claude', args, {
  cwd,
  shell: process.platform === 'win32',
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let sawInit = false;
let sawAssistant = false;
let sawResult = false;
let sessionId = '';

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let ev;
  try { ev = JSON.parse(line); } catch { return; }

  if (ev.type === 'system' && ev.subtype === 'init') {
    sawInit = true;
    sessionId = ev.session_id;
    if (process.env.PROBE_MODEL) {
      const req = { type: 'control_request', request_id: 'probe-set-model', request: { subtype: 'set_model', model: process.env.PROBE_MODEL } };
      child.stdin.write(JSON.stringify(req) + '\n');
      console.log('[probe] sent set_model ->', process.env.PROBE_MODEL);
    }
    console.log(`[init] session=${sessionId} model=${ev.model} cwd=${ev.cwd}`);
    if (process.env.PROBE_MODE) {
      const req = { type: 'control_request', request_id: 'probe-set-mode', request: { subtype: 'set_permission_mode', mode: process.env.PROBE_MODE } };
      child.stdin.write(JSON.stringify(req) + '\n');
      console.log('[probe] sent set_permission_mode ->', process.env.PROBE_MODE);
    }

  } else if (ev.type === 'assistant') {
    for (const b of ev.message?.content || []) {
      if (b.type === 'text') {
        sawAssistant = true;
        console.log('[assistant text]', JSON.stringify(b.text));
      } else if (b.type === 'tool_use') {
        console.log(`[tool_use] ${b.name}`, JSON.stringify(b.input).slice(0, 120));
      }
    }
  } else if (ev.type === 'control_request') {
    const req = ev.request || {};
    console.log(`[control_request] subtype=${req.subtype} tool=${req.tool_name} input=${JSON.stringify(req.input).slice(0, 120)}`);
    if (req.subtype === 'can_use_tool') {
      // 探针只验证协议，不做任何自动放行：一律拒绝
      const response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: ev.request_id,
          response: {
            behavior: 'deny',
            message: 'probe: permission requests are denied by design',
            toolUseID: req.tool_use_id,
          },
        },
      };
      child.stdin.write(JSON.stringify(response) + '\n');
      console.log('[probe] denied', req.tool_name);
    }
  } else if (ev.type === 'control_response') {
    console.log('[control_response]', JSON.stringify(ev.response).slice(0, 300));
  } else if (ev.type === 'user') {
    const blocks = ev.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'tool_result') console.log('[tool_result]', JSON.stringify(b.content).slice(0, 160));
      }
    }
  } else if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'message_start') {
      console.log('[stream] message_start id=', e.message?.id, 'session=', ev.session_id);
    } else if (e.type === 'content_block_start') {
      console.log('[stream] block_start index=', e.index, 'type=', e.content_block?.type, 'id=', e.content_block?.id, 'name=', e.content_block?.name);
    } else if (e.type === 'content_block_delta') {
      if (e.delta?.type === 'text_delta') {
        console.log('[stream] text_delta', JSON.stringify(e.delta.text));
      } else {
        console.log('[stream] delta type=', e.delta?.type, JSON.stringify(e.delta).slice(0, 80));
      }
    } else if (e.type === 'message_stop') {
      console.log('[stream] message_stop');
    } else {
      console.log('[stream] other', e.type);
    }
  } else if (ev.type === 'result') {
    sawResult = true;
    console.log(`[result] subtype=${ev.subtype} is_error=${ev.is_error} turns=${ev.num_turns} duration=${ev.duration_ms}ms cost=${ev.total_cost_usd ?? '-'}`);
    finish(0);
  }
});

child.stderr.on('data', (b) => {
  const t = b.toString('utf8').trim();
  if (t) console.log('[stderr]', t.slice(0, 300));
});

child.on('error', (e) => {
  console.log('[error]', e.message);
  finish(1);
});

const timer = setTimeout(() => {
  console.log('[probe] timeout after 90s');
  finish(2);
}, 90000);

function finish(code) {
  clearTimeout(timer);
  console.log(`[probe] summary init=${sawInit} assistant=${sawAssistant} result=${sawResult} session=${sessionId}`);
  try { child.stdin.end(); } catch {}
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {}
  setTimeout(() => process.exit(code), 500);
}

const content = [{ type: 'text', text: prompt }];
if (process.env.PROBE_IMAGE) {
  const ext = path.extname(process.env.PROBE_IMAGE).toLowerCase();
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext] || 'image/png';
  content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: fs.readFileSync(process.env.PROBE_IMAGE).toString('base64') } });
  console.log('[probe] attached image', process.env.PROBE_IMAGE);
}
const userMessage = {
  type: 'user',
  session_id: '',
  message: { role: 'user', content },
  parent_tool_use_id: null,
};

child.stdin.write(JSON.stringify(userMessage) + '\n');
console.log('[probe] sent user message');
