'use strict';
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const crypto = require('crypto');

/**
 * Claude Code adapter (headless, stream-json).
 * Multi-turn via --session-id (first turn) / --resume (subsequent turns).
 *
 * run() streams normalized events through onEvent and resolves with
 * { sessionId, text, cost }.
 */
function flattenResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
  }
  return '';
}

function run({ prompt, sessionId, workdir, model, onEvent, signal, env }) {
  return new Promise((resolve, reject) => {
    const isResume = !!sessionId;
    const sid = sessionId || crypto.randomUUID();

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode', 'bypassPermissions',
      // 셸/파일쓰기는 차단, 웹·읽기·MCP 등 나머지는 허용
      '--disallowedTools', 'Bash', 'Write', 'Edit', 'NotebookEdit',
      '--add-dir', workdir,
    ];
    if (model) args.push('--model', model);
    if (isResume) args.push('--resume', sid);
    else args.push('--session-id', sid);

    const child = spawn('claude', args, {
      cwd: workdir,
      env: env ? { ...process.env, ...env } : process.env,
    });
    child.stdin.end(); // avoid 3s stdin wait in print mode

    let buf = '';
    let finalText = '';
    let resolvedSid = sid;
    let cost = 0;
    let stderr = '';

    const decoder = new StringDecoder('utf8'); // hold incomplete multi-byte chars across chunks
    child.stdout.on('data', (d) => {
      buf += decoder.write(d);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        handle(ev);
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    function handle(ev) {
      if (ev.type === 'system' && ev.subtype === 'init') {
        resolvedSid = ev.session_id || resolvedSid;
      } else if (ev.type === 'stream_event') {
        // real token streaming via partial messages
        const e = ev.event || {};
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
          finalText += e.delta.text;
          onEvent({ type: 'delta', text: e.delta.text });
        }
      } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        // text already streamed via stream_event; surface tool calls (with input) here
        for (const b of ev.message.content) {
          if (b.type === 'tool_use') {
            onEvent({ type: 'tool', id: b.id, name: b.name, input: b.input || {} });
          }
        }
      } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
        // tool results come back as a synthetic user turn
        for (const b of ev.message.content) {
          if (b.type === 'tool_result') {
            onEvent({ type: 'tool_result', id: b.tool_use_id, isError: !!b.is_error, text: flattenResult(b.content) });
          }
        }
      } else if (ev.type === 'result') {
        resolvedSid = ev.session_id || resolvedSid;
        if (ev.result) finalText = ev.result; // authoritative final text
        cost = ev.total_cost_usd || 0;
        if (ev.is_error) onEvent({ type: 'error', message: ev.result || 'claude reported error' });
      }
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ sessionId: resolvedSid, text: finalText, cost });
      else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
    });

    if (signal) {
      signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} });
    }
  });
}

module.exports = { id: 'claude', label: 'Claude (Opus 4.8)', run };
