'use strict';
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/**
 * Codex CLI adapter (headless, `codex exec --json`).
 * Multi-turn via `codex exec resume <thread_id>`.
 *
 * Event model (JSONL):
 *   {type:'thread.started', thread_id}
 *   {type:'item.started'|'item.completed', item:{type, ...}}
 *     - command_execution: {command, aggregated_output, exit_code}
 *     - agent_message: {text}
 *   {type:'turn.completed', usage}
 *   {type:'turn.failed', error}|{type:'error', message}
 *
 * Codex does not stream partial text — the whole answer arrives in one
 * agent_message; the client typewriter smooths it out.
 */
function cleanCmd(c) {
  if (Array.isArray(c)) c = c.join(' ');
  if (typeof c !== 'string') return '';
  const m = c.match(/^\/bin\/(?:ba)?sh\s+-l?c\s+'([\s\S]*)'$/);
  return m ? m[1] : c;
}

function run({ prompt, sessionId, workdir, model, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    // read-only sandbox: 셸은 읽기/웹검색만, 호스트 쓰기/변경 차단 (resume도 -c 방식만 허용)
    const base = ['--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"'];
    if (model) base.push('--model', model);

    const args = sessionId
      ? ['exec', 'resume', ...base, sessionId, prompt]
      : ['exec', ...base, prompt];

    const child = spawn('codex', args, { cwd: workdir, env: process.env });
    child.stdin.end(); // codex waits on stdin otherwise

    let buf = '';
    let finalText = '';
    let resolvedSid = sessionId || null;
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
      if (ev.type === 'thread.started') {
        resolvedSid = ev.thread_id || resolvedSid;
      } else if (ev.type === 'item.started' && ev.item && ev.item.type === 'command_execution') {
        onEvent({ type: 'tool', id: ev.item.id, name: 'Bash', input: { command: cleanCmd(ev.item.command) } });
      } else if (ev.type === 'item.completed' && ev.item) {
        const it = ev.item;
        if (it.type === 'command_execution') {
          onEvent({ type: 'tool_result', id: it.id, isError: it.exit_code != null && it.exit_code !== 0, text: it.aggregated_output || '' });
        } else if (it.type === 'agent_message' && it.text) {
          finalText += (finalText ? '\n\n' : '') + it.text;
          onEvent({ type: 'delta', text: it.text });
        }
      } else if (ev.type === 'turn.failed') {
        onEvent({ type: 'error', message: (ev.error && ev.error.message) || 'codex turn failed' });
      } else if (ev.type === 'error') {
        onEvent({ type: 'error', message: ev.message || 'codex error' });
      }
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ sessionId: resolvedSid, text: finalText, cost: 0 });
      else reject(new Error(stderr.trim() || `codex exited with code ${code}`));
    });

    if (signal) signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} });
  });
}

module.exports = { id: 'codex', label: 'Codex', run };
