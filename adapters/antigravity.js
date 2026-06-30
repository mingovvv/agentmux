'use strict';
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

/**
 * Antigravity CLI (agy) adapter — plain-text print mode.
 * agy has no JSON/streaming/tool events; stdout is the answer text.
 *
 * Multi-turn: agy stores each conversation as <id>.db and resumes via
 * `--conversation <id>`, but `agy -p` does not print the new id. So for a
 * new conversation we diff the conversations dir before/after the run to
 * discover the freshly-created id, then reuse it for `--conversation`.
 */
const CONV_DIR = path.join(process.env.HOME || '/home/ubuntu', '.gemini/antigravity-cli/conversations');

function listDbs() {
  try { return fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.db')); }
  catch { return []; }
}
function newestNewId(beforeSet) {
  const fresh = listDbs().filter((f) => !beforeSet.has(f));
  if (!fresh.length) return null;
  fresh.sort((a, b) => mtime(b) - mtime(a));
  return fresh[0].replace(/\.db$/, '');
}
function mtime(f) { try { return fs.statSync(path.join(CONV_DIR, f)).mtimeMs; } catch { return 0; } }

// agy occasionally prints an infra error to STDOUT and exits 0 — most often right
// after a previous agy process was killed (e.g. when a turn is interrupted). We must
// not stream that as if it were the answer; detect it and retry with a fresh call.
const TRANSIENT = /no active conversation|trajectory not found|failed to send message|conversation not found/i;

function attempt({ prompt, sessionId, workdir, model, onEvent, signal, env }) {
  return new Promise((resolve, reject) => {
    const before = sessionId ? null : new Set(listDbs());

    // --sandbox: 터미널 제한, 워크스페이스 밖 접근 차단 / skip-permissions: 헤드리스 자동승인
    const flags = ['--sandbox', '--dangerously-skip-permissions'];
    const args = sessionId
      ? ['--conversation', sessionId, '-p', prompt, ...flags]
      : ['-p', prompt, ...flags];
    if (model) args.push('--model', model);

    const child = spawn('agy', args, { cwd: workdir, env: env ? { ...process.env, ...env } : process.env });
    child.stdin.end(); // print mode otherwise waits on stdin

    let out = '';
    let stderr = '';
    let emitting = false;  // becomes true once we've classified the output as a real answer
    let held = '';         // preflight buffer: held until we know it isn't an infra error
    const decoder = new StringDecoder('utf8'); // hold incomplete multi-byte chars across chunks

    // flush the preflight buffer once we can classify it (real answer vs infra error)
    function flushHeld() {
      if (emitting) return;
      if (TRANSIENT.test(held)) return;            // looks like an agy infra error → keep withholding
      emitting = true;
      if (held) { onEvent({ type: 'delta', text: held }); held = ''; }
    }
    child.stdout.on('data', (d) => {
      const t = decoder.write(d);
      if (!t) return;
      out += t;
      if (emitting) { onEvent({ type: 'delta', text: t }); return; }
      held += t;
      if (held.length >= 200 || held.includes('\n')) flushHeld();
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      const tail = decoder.end();
      if (tail) { out += tail; if (emitting) onEvent({ type: 'delta', text: tail }); else held += tail; }
      if (!emitting) flushHeld();                   // final decision for short outputs
      const text = out.trim();
      if (code !== 0) return reject(new Error(stderr.trim() || `agy exited with code ${code}`));
      if (!emitting && TRANSIENT.test(text)) {      // infra error printed to stdout, never streamed
        const e = new Error(text.slice(0, 160)); e.transient = true; return reject(e);
      }
      const sid = sessionId || newestNewId(before) || null;
      resolve({ sessionId: sid, text, cost: 0 });
    });

    if (signal) signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} });
  });
}

async function run(opts) {
  try {
    return await attempt(opts);
  } catch (e) {
    if (opts.signal && opts.signal.aborted) throw e;                 // user/timeout abort — don't retry
    if (!(e.transient || TRANSIENT.test(e.message || ''))) throw e;  // genuine failure — propagate
    await new Promise((r) => setTimeout(r, 700));                    // let agy settle after the killed process
    if (opts.signal && opts.signal.aborted) throw e;
    return await attempt(opts);                                      // one fresh retry
  }
}

module.exports = { id: 'antigravity', label: 'Antigravity', run };
