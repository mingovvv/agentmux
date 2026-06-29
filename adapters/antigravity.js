'use strict';
const { spawn } = require('child_process');
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

function run({ prompt, sessionId, workdir, model, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const before = sessionId ? null : new Set(listDbs());

    // --sandbox: 터미널 제한, 워크스페이스 밖 접근 차단 / skip-permissions: 헤드리스 자동승인
    const flags = ['--sandbox', '--dangerously-skip-permissions'];
    const args = sessionId
      ? ['--conversation', sessionId, '-p', prompt, ...flags]
      : ['-p', prompt, ...flags];
    if (model) args.push('--model', model);

    const child = spawn('agy', args, { cwd: workdir, env: process.env });
    child.stdin.end(); // print mode otherwise waits on stdin

    let out = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const t = d.toString();
      out += t;
      onEvent({ type: 'delta', text: t });
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `agy exited with code ${code}`));
      const sid = sessionId || newestNewId(before) || null;
      resolve({ sessionId: sid, text: out.trim(), cost: 0 });
    });

    if (signal) signal.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch {} });
  });
}

module.exports = { id: 'antigravity', label: 'Antigravity', run };
