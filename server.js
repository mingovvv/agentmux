'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adapters = require('./adapters');
const store = require('./lib/store');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = process.env.PORT || CONFIG.port || 8787;
const HOST = CONFIG.host || '0.0.0.0';
const TOKEN = process.env.GATEWAY_TOKEN || CONFIG.authToken;
const PUBLIC = path.join(__dirname, 'public');

/* ----------------------------- helpers ----------------------------- */
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

function authed(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : (req.headers['x-gateway-token'] || '');
  return token && token === TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function providerList() {
  const cfg = CONFIG.providers || {};
  return Object.keys(cfg).map((id) => ({
    id,
    label: cfg[id].label || id,
    enabled: !!cfg[id].enabled && !!adapters.get(id),
    models: cfg[id].models || [{ id: '', label: '기본' }],
  }));
}

/* ----- per-provider concurrency (agents run independently) ----- */
const MAXC = CONFIG.maxConcurrentPerProvider || 3;
const _slots = {};
function acquire(p) {
  const s = _slots[p] || (_slots[p] = { active: 0, queue: [] });
  return new Promise((resolve) => {
    const tryRun = () => { if (s.active < MAXC) { s.active++; resolve(); } else { s.queue.push(tryRun); } };
    tryRun();
  });
}
function release(p) { const s = _slots[p]; if (!s) return; s.active--; const n = s.queue.shift(); if (n) n(); }

/* model field "provider" or "provider/modelId" (e.g. "claude/claude-opus-4-8") */
function parseModel(m) {
  m = String(m || 'claude').replace(/^ai-gateway[/:]/, '');
  const i = m.indexOf('/');
  return i < 0 ? { provider: m, model: undefined } : { provider: m.slice(0, i), model: m.slice(i + 1) };
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

/* --------------------------- static files -------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res) {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ----------------------------- chat core --------------------------- */
// one agent run with concurrency gate + timeout (no store/session side effects)
async function runAgent({ provider, sessionId, workdir, model, message, onEvent, signal }) {
  const adapter = adapters.get(provider);
  if (!adapter) throw new Error(`unknown or disabled provider: ${provider}`);
  await acquire(provider);
  const ac = new AbortController();
  const fwd = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', fwd); }
  const TMO = CONFIG.requestTimeoutMs || 300000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TMO);
  // per-provider env override (e.g. HOME / CLAUDE_CONFIG_DIR to pick an account, or API keys)
  const penv = ((CONFIG.providers || {})[provider] || {}).env;
  try {
    return await adapter.run({ prompt: message, sessionId, workdir, model: model || undefined, onEvent, signal: ac.signal, env: penv });
  } catch (e) {
    throw timedOut ? new Error(`request timed out after ${Math.round(TMO / 1000)}s`) : e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', fwd);
    release(provider);
  }
}

async function runTurn({ provider, conversationId, message, model, onEvent, signal }) {
  let conv = conversationId ? store.get(conversationId) : null;
  if (!conv) conv = store.create(provider, message);
  if (conv.provider !== provider) throw new Error('provider mismatch for this conversation');

  store.addMessage(conv.id, 'user', message);
  onEvent({ type: 'meta', conversationId: conv.id, provider });

  const t0 = Date.now();
  const result = await runAgent({ provider, sessionId: conv.sessionId, workdir: conv.workdir, model, message, onEvent, signal });
  log(`${provider}${model ? '/' + model : ''} ${Date.now() - t0}ms${result.cost ? ' $' + result.cost.toFixed(4) : ''} conv=${conv.id.slice(0, 8)}`);

  if (result.sessionId) store.setSession(conv.id, result.sessionId);
  store.addMessage(conv.id, 'assistant', result.text || '');
  return { conversationId: conv.id, ...result };
}

/* ====================================================================
 * Council / Debate engine — moderator-driven, interruptible
 *
 * Flow: opening (parallel independent answers) → moderator extracts the
 * real points of contention → sequential ping-pong where the moderator
 * directs "speaker → target on dispute" each turn → synthesis + consensus.
 *
 * The user is the chair: POST /api/council/:id/say injects a message that
 * aborts the in-flight turn and is handled first by the moderator.
 * The moderator runs as its OWN session (key "mod:<provider>"), isolated
 * from the same provider's debater session, so e.g. Claude-as-moderator
 * and Claude-as-debater never share context.
 * ==================================================================== */
const debates = new Map();
const COUNCIL = CONFIG.council || {};
const MAX_TURNS = COUNCIL.maxTurns || 8;

function extractJson(s) {
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(body.slice(a, b + 1)); } catch { return null; }
}
function clabel(id) { return (providerList().find((p) => p.id === id) || {}).label || id; }
function failMsg(speaker, e) {
  const r = (e && e.message) || String(e || '');
  return `⚠ **${clabel(speaker)} 응답 실패** — 사용량 한도·인증·일시 오류 등으로 응답하지 못했습니다.${r ? `\n\n\`${r}\`` : ''}`;
}

let _turnSeq = 0;
function newTurn(o) { return { id: 't' + (++_turnSeq), ts: Date.now(), text: '', ...o }; }
function makeAbort(d) { const ac = new AbortController(); d.aborters.add(ac); return ac; }
function clearAbort(d, ac) { d.aborters.delete(ac); }
function abortAll(d) { for (const ac of d.aborters) { try { ac.abort(); } catch {} } }

function createDebate({ question, moderator }) {
  const parts = providerList().filter((p) => p.enabled).map((p) => ({
    key: p.id, label: p.label, model: (p.models && p.models[0] && p.models[0].id) || undefined,
  }));
  if (!parts.length) throw new Error('no enabled providers');
  const ids = parts.map((p) => p.key);
  const mod = (moderator && adapters.get(moderator)) ? moderator : (ids.includes('claude') ? 'claude' : ids[0]);
  const id = crypto.randomUUID();
  const d = {
    id, question, moderator: mod, participants: parts,
    transcript: [], disputes: [], createdSessions: [],
    workdir: store.workspaceFor('_council', id),
    aborters: new Set(), pendingUser: [], interrupt: null,
    status: 'running', clients: new Set(),
    emit(ev) { for (const res of this.clients) { try { sse(res, ev); } catch {} } },
  };
  debates.set(id, d);
  return d;
}
function cleanupDebate(d) {
  try { fs.rmSync(d.workdir, { recursive: true, force: true }); } catch {}
  // turns run stateless (fresh session each call); remove every session we created
  for (const { provider, sessionId } of d.createdSessions) {
    try { store.rmSession(provider, sessionId); } catch {}
  }
}

// Debate turns run STATELESS — the shared transcript (passed in every prompt) is the
// only state, so there's no hidden per-agent session to corrupt on abort and no context
// bleed between a provider's moderator and debater roles. We still capture each freshly
// created session id so cleanup can remove it.

// a debater turn — streams deltas into turn.text live (so partials survive aborts)
async function debaterTurn(d, turn, prompt) {
  const ac = makeAbort(d);
  const t0 = Date.now();
  try {
    const r = await runAgent({
      provider: turn.speaker, model: turn.model, sessionId: null, workdir: d.workdir,
      message: prompt,
      onEvent: (ev) => { if (ev.type === 'delta') { turn.text += ev.text; d.emit({ type: 'delta', turnId: turn.id, speaker: turn.speaker, text: ev.text }); } },
      signal: ac.signal,
    });
    if (r.sessionId) d.createdSessions.push({ provider: turn.speaker, sessionId: r.sessionId });
    if (r.text) turn.text = r.text;
    if (!turn.text.trim()) {  // agent finished but produced nothing (e.g. usage limit) — make it visible
      turn.text = `⚠ **${clabel(turn.speaker)} 응답이 비어 있습니다** — 사용량 한도이거나 일시적 오류일 수 있어요.`;
      turn.failed = true;
      d.emit({ type: 'delta', turnId: turn.id, speaker: turn.speaker, text: turn.text });
    }
    log(`council ${turn.speaker}${turn.model ? '/' + turn.model : ''} ${turn.role || ''} ${Date.now() - t0}ms ${turn.text.length}c`);
    return turn.text;
  } finally { clearAbort(d, ac); }
}

// the moderator — also stateless; isolated from debaters by construction.
// emits moderating{active} so the UI can glow the moderator seat while it deliberates.
async function moderate(d, instruction) {
  const ac = makeAbort(d);
  const t0 = Date.now();
  let text = '';
  d.emit({ type: 'moderating', active: true });
  try {
    const r = await runAgent({
      provider: d.moderator, sessionId: null, workdir: d.workdir,
      message: instruction, onEvent: () => {}, signal: ac.signal,
    });
    if (r.sessionId) d.createdSessions.push({ provider: d.moderator, sessionId: r.sessionId });
    text = r.text || '';
  } finally {
    clearAbort(d, ac);
    d.emit({ type: 'moderating', active: false });
    log(`council mod:${d.moderator} ${Date.now() - t0}ms ${text.length}c`);
  }
  return text;
}
function moderatorSay(d, text) {
  if (!text) return;
  const turn = newTurn({ speaker: '__moderator', role: 'moderator', text });
  d.emit({ type: 'turn_start', turnId: turn.id, speaker: '__moderator', role: 'moderator' });
  d.emit({ type: 'delta', turnId: turn.id, speaker: '__moderator', text });
  d.emit({ type: 'turn_end', turnId: turn.id });
  d.transcript.push({ role: 'moderator', text, ts: Date.now() });
}

function compactTranscript(d, limit = 16) {
  return d.transcript.slice(-limit).map((t) => {
    if (t.role === 'user') return `[좌장(사용자)] ${t.text}`;
    if (t.role === 'moderator') return `[사회자] ${t.text}`;
    const tgt = t.target ? ` → ${clabel(t.target)}` : '';
    return `[${clabel(t.speaker)}${tgt}] ${t.text}`;
  }).join('\n\n');
}

async function runDebate(d) {
  const parts = d.participants;
  const ids = parts.map((p) => p.key);
  const modelOf = (k) => (parts.find((x) => x.key === k) || {}).model;
  const q = d.question;

  d.emit({
    type: 'debate', debateId: d.id, question: q,
    participants: parts.map((p) => ({ key: p.key, label: p.label, model: p.model })),
    moderator: d.moderator,
  });

  // ── Phase 0: opening — independent answers in parallel ──
  d.emit({ type: 'phase', phase: 'opening', label: '개회 · 독립 답변' });
  await Promise.all(parts.map(async (p) => {
    const turn = newTurn({ speaker: p.key, model: p.model, role: 'opening' });
    d.emit({ type: 'turn_start', turnId: turn.id, speaker: p.key, role: 'opening' });
    try { await debaterTurn(d, turn, `다음 질문에 당신의 의견을 분명하고 간결하게 답하세요. 입장을 명확히 하세요.\n\n[질문]\n${q}`); }
    catch (e) { if (!turn.text && !d.interrupt) { turn.text = failMsg(turn.speaker, e); turn.failed = true; d.emit({ type: 'delta', turnId: turn.id, speaker: turn.speaker, text: turn.text }); } }
    d.transcript.push(turn);
    d.emit({ type: 'turn_end', turnId: turn.id, interrupted: !!d.interrupt, error: !!turn.failed });
  }));

  // ── Phase 1: moderator extracts the real disputes ──
  if (d.status === 'running') {
    d.emit({ type: 'phase', phase: 'disputes', label: '쟁점 정리' });
    try {
      const raw = await moderate(d, `당신은 토론 사회자입니다. 아래는 "${q}"에 대한 각 참가자의 독립 답변입니다.\n\n${compactTranscript(d, parts.length)}\n\n의견이 실제로 갈리는 핵심 쟁점 2~3개를 뽑아 JSON으로만 답하세요:\n{"disputes":[{"id":"1","title":"짧은 제목","detail":"무엇이 왜 갈리는지 한 문장"}]}`);
      const j = extractJson(raw);
      d.disputes = (j && Array.isArray(j.disputes)) ? j.disputes.slice(0, 3) : [];
    } catch { d.disputes = []; }
    d.emit({ type: 'disputes', items: d.disputes });
  }

  // ── Phase 2: moderator-directed ping-pong (interruptible) ──
  d.emit({ type: 'phase', phase: 'debate', label: '교차 반박' });
  let turns = 0;        // productive debate turns (capped at MAX_TURNS)
  let guard = 0;        // hard iteration guard against any spin
  let errStreak = 0;    // consecutive genuine errors → bail out
  while (d.status === 'running' && turns < MAX_TURNS && guard < MAX_TURNS * 4) {
    guard++;
    // (a) user interjection is top priority
    let userNote = '';
    if (d.pendingUser.length) {
      const u = d.pendingUser.shift();
      d.transcript.push({ role: 'user', text: u, ts: Date.now() });
      d.emit({ type: 'user', text: u });
      userNote = `\n\n[최우선] 좌장(사용자)이 방금 개입했습니다: "${u}"\n이 발언을 먼저 이해하고 반영하세요. 질문이면 누가 답할지 정하고, 새 논점이면 토론을 그쪽으로 트세요.`;
    }
    d.interrupt = null;

    // (b) moderator decides the next move
    let decRaw = '';
    try {
      decRaw = await moderate(d, `당신은 토론 사회자입니다. 질문: "${q}"\n\n[쟁점]\n${(d.disputes || []).map((x) => `${x.id}. ${x.title}`).join('\n') || '(없음)'}\n\n[최근 토론]\n${compactTranscript(d)}${userNote}\n\n다음에 누가 누구에게 무엇을 말할지 정하세요. 한쪽으로 치우치지 말고 핑퐁이 되게 번갈아 지목하세요. 토론이 충분히 무르익었거나 합의/결렬이 분명하면 종료하세요. JSON으로만:\n{"action":"direct","say":"진행 멘트 한 줄(선택)","speaker":"${ids.join('|')}","target":"${ids.join('|')} 또는 빈값","disputeId":"쟁점번호 또는 빈값","instruction":"speaker에게 줄 구체적 지시"}\n또는\n{"action":"conclude","say":"마무리 멘트 한 줄"}`);
    } catch {
      if (d.interrupt === 'user') continue;   // user jumped in while moderating
      if (d.status !== 'running') break;       // stopped / disconnected
      // genuine moderator error → fall through with empty decision (round-robin fallback)
    }
    if (d.interrupt === 'user') continue;
    if (d.status !== 'running') break;

    const dec = extractJson(decRaw) || {};
    if (dec.action === 'conclude') { moderatorSay(d, dec.say); break; }

    const speaker = ids.includes(dec.speaker) ? dec.speaker : ids[turns % ids.length];
    const target = ids.includes(dec.target) && dec.target !== speaker ? dec.target : '';
    const instruction = dec.instruction || '쟁점에 대해 당신의 입장을 변호하고 상대 주장을 반박하세요.';
    if (dec.say) moderatorSay(d, dec.say);

    const turn = newTurn({ speaker, target, model: modelOf(speaker), role: 'rebut', disputeId: dec.disputeId });
    d.emit({ type: 'turn_start', turnId: turn.id, speaker, target, disputeId: dec.disputeId, role: 'rebut' });
    const prompt = `당신은 이 토론의 참가자입니다. 질문: "${q}"\n\n[지금까지의 토론]\n${compactTranscript(d)}\n\n[사회자 지시]\n${instruction}${target ? `\n특히 ${clabel(target)}의 주장에 직접 반박하거나 응답하세요.` : ''}\n\n간결하고 날카롭게, 새 근거를 더하세요. 같은 말 반복은 금지.`;
    try {
      await debaterTurn(d, turn, prompt);
      d.transcript.push(turn);
      d.emit({ type: 'turn_end', turnId: turn.id, error: !!turn.failed });
      turns++; errStreak = 0;
    } catch (e) {
      // user interrupt → keep partial, loop back to handle the interjection (does NOT consume a turn)
      if (d.interrupt === 'user') {
        turn.interrupted = true;
        d.transcript.push(turn);
        d.emit({ type: 'turn_end', turnId: turn.id, interrupted: true });
        continue;
      }
      if (d.status !== 'running') { d.emit({ type: 'turn_end', turnId: turn.id, interrupted: true }); break; }
      // genuine error/timeout → record, count the turn, bail if it keeps failing
      if (!turn.text) { turn.text = failMsg(turn.speaker, e); turn.failed = true; d.emit({ type: 'delta', turnId: turn.id, speaker: turn.speaker, text: turn.text }); }
      d.transcript.push(turn);
      d.emit({ type: 'turn_end', turnId: turn.id, error: true });
      turns++;
      if (++errStreak >= 3) break;
    }
  }

  // ── Phase 3: synthesis + consensus map (skip if user-stopped) ──
  if (d.status === 'running') {
    d.emit({ type: 'phase', phase: 'closing', label: '종합' });
    let cj = {};
    try {
      const raw = await moderate(d, `토론을 마칩니다. 질문: "${q}"\n\n[전체 토론]\n${compactTranscript(d, 40)}\n\n사회자로서 최종 종합을 JSON으로만 작성하세요:\n{"summary":"3~5문장 결론","points":[{"point":"논점","status":"agree 또는 split","detail":"한 문장"}]}`);
      cj = extractJson(raw) || { summary: raw };
    } catch { /* leave empty */ }
    d.emit({ type: 'consensus', summary: cj.summary || '', points: Array.isArray(cj.points) ? cj.points : [] });
  }
  d.emit({ type: 'done', debateId: d.id });
}

/* ------------------------------ routes ----------------------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const t = Date.now();
  res.on('finish', () => { if (url.startsWith('/api') || url.startsWith('/v1')) log(`${req.method} ${url} ${res.statusCode} ${Date.now() - t}ms`); });

  // health check (no auth) — for monitoring / uptime probes
  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), providers: providerList().filter((p) => p.enabled).map((p) => p.id) });
  }

  // static (no auth needed for the shell; API calls below are authed)
  if (req.method === 'GET' && (url === '/' || url.startsWith('/index') || MIME[path.extname(url)])) {
    return serveStatic(req, res);
  }

  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

  try {
    // --- list providers ---
    if (req.method === 'GET' && url === '/api/providers') {
      return send(res, 200, { providers: providerList() });
    }

    // --- conversations ---
    if (req.method === 'GET' && url === '/api/conversations') {
      return send(res, 200, { conversations: store.list() });
    }
    if (req.method === 'GET' && url.startsWith('/api/conversations/')) {
      const id = url.split('/')[3];
      const c = store.get(id);
      if (!c) return send(res, 404, { error: 'not found' });
      return send(res, 200, c);
    }
    if (req.method === 'DELETE' && url.startsWith('/api/conversations/')) {
      store.remove(url.split('/')[3]);
      return send(res, 200, { ok: true });
    }

    // --- native chat: SSE by default, single JSON when stream:false ---
    if (req.method === 'POST' && url === '/api/chat') {
      const body = await readBody(req);
      if (!body.provider || !body.message) return send(res, 400, { error: 'provider and message required' });
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      // non-streaming: collect events, return one JSON (text + tool transcript)
      if (body.stream === false) {
        const tools = [];
        try {
          const out = await runTurn({
            provider: body.provider, conversationId: body.conversationId, message: body.message, model: body.model,
            signal: ac.signal,
            onEvent: (ev) => {
              if (ev.type === 'tool') tools.push({ id: ev.id, name: ev.name, input: ev.input });
              else if (ev.type === 'tool_result') { const t = tools.find((x) => x.id === ev.id); if (t) { t.result = ev.text; t.isError = ev.isError; } }
            },
          });
          return send(res, 200, { conversationId: out.conversationId, provider: body.provider, text: out.text, tools, cost: out.cost });
        } catch (e) {
          return send(res, 500, { error: String(e.message || e) });
        }
      }

      // streaming (default; used by web UI)
      sseHead(res);
      try {
        const out = await runTurn({
          provider: body.provider,
          conversationId: body.conversationId,
          message: body.message,
          model: body.model,
          onEvent: (ev) => sse(res, ev),
          signal: ac.signal,
        });
        sse(res, { type: 'done', conversationId: out.conversationId, cost: out.cost });
      } catch (e) {
        sse(res, { type: 'error', message: String(e.message || e) });
      }
      return res.end();
    }

    // --- council: user interjection (abort in-flight turn, handle first) ---
    if (req.method === 'POST' && url.startsWith('/api/council/') && url.endsWith('/say')) {
      const d = debates.get(url.split('/')[3]);
      if (!d) return send(res, 404, { error: 'debate not found' });
      const body = await readBody(req);
      const text = String(body.text || body.message || '').trim();
      if (!text) return send(res, 400, { error: 'text required' });
      d.pendingUser.push(text);
      d.interrupt = 'user';
      abortAll(d);
      return send(res, 200, { ok: true });
    }
    // --- council: stop the debate ---
    if (req.method === 'POST' && url.startsWith('/api/council/') && url.endsWith('/stop')) {
      const d = debates.get(url.split('/')[3]);
      if (!d) return send(res, 404, { error: 'debate not found' });
      d.status = 'stopping'; d.interrupt = 'stop'; abortAll(d);
      return send(res, 200, { ok: true });
    }

    // --- council: start a moderator-driven, interruptible debate (SSE) ---
    if (req.method === 'POST' && url === '/api/council') {
      const body = await readBody(req);
      const question = body.question || body.message;
      if (!question) return send(res, 400, { error: 'question required' });
      sseHead(res);
      let d;
      try { d = createDebate({ question, moderator: body.moderator || body.synthesizer }); }
      catch (e) { sse(res, { type: 'error', message: String(e.message || e) }); return res.end(); }
      d.clients.add(res);
      req.on('close', () => {
        d.clients.delete(res);
        if (!d.clients.size) { d.status = 'stopping'; d.interrupt = 'stop'; abortAll(d); }
      });
      try { await runDebate(d); }
      catch (e) { d.emit({ type: 'error', message: String(e.message || e) }); }
      finally { d.status = 'done'; debates.delete(d.id); cleanupDebate(d); res.end(); }
      return;
    }

    // --- OpenAI-compatible: list models (provider + provider/modelId) ---
    if (req.method === 'GET' && url === '/v1/models') {
      const data = [];
      for (const p of providerList()) {
        if (!p.enabled) continue;
        data.push({ id: p.id, object: 'model', owned_by: p.id, created: 0 });
        for (const m of p.models) {
          if (m.id) data.push({ id: `${p.id}/${m.id}`, object: 'model', owned_by: p.id, created: 0 });
        }
      }
      return send(res, 200, { object: 'list', data });
    }

    // --- OpenAI-compatible chat (for external API clients) ---
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const body = await readBody(req);
      const { provider, model } = parseModel(body.model);   // "claude" or "claude/claude-opus-4-8"
      const echo = body.model || provider;
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      if (!lastUser) return send(res, 400, { error: { message: 'no user message' } });
      const conversationId = req.headers['x-conversation-id'] || body.conversation_id || null;
      const created = Math.floor(Date.now() / 1000);
      const cmplId = 'chatcmpl-' + created + Math.random().toString(36).slice(2, 8);

      if (body.stream) {
        sseHead(res);
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        let convId = conversationId;
        try {
          const out = await runTurn({
            provider, conversationId, model, message: lastUser.content,
            signal: ac.signal,
            onEvent: (ev) => {
              if (ev.type === 'meta') convId = ev.conversationId;
              if (ev.type === 'delta') {
                res.write(`data: ${JSON.stringify({ id: cmplId, object: 'chat.completion.chunk', created, model: echo, choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] })}\n\n`);
              }
            },
          });
          convId = out.conversationId;
          res.write(`data: ${JSON.stringify({ id: cmplId, object: 'chat.completion.chunk', created, model: echo, conversation_id: convId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (e) {
          res.write(`data: ${JSON.stringify({ error: { message: String(e.message || e) } })}\n\n`);
        }
        return res.end();
      }

      // non-streaming
      try {
        const out = await runTurn({ provider, conversationId, model, message: lastUser.content, onEvent: () => {} });
        return send(res, 200, {
          id: cmplId, object: 'chat.completion', created, model: echo,
          choices: [{ index: 0, message: { role: 'assistant', content: out.text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          conversation_id: out.conversationId,
        });
      } catch (e) {
        return send(res, 500, { error: { message: String(e.message || e) } });
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`agentmux listening on http://${HOST}:${PORT}`);
  log(`providers: ${providerList().map((p) => `${p.id}${p.enabled ? '' : '(off)'}`).join(', ')}`);
  const gc = () => { const n = store.gcOrphans(); if (n) log(`gc: removed ${n} orphan workspace(s)`); };
  gc();
  setInterval(gc, 6 * 3600 * 1000).unref();
});
