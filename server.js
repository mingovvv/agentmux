'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
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
  try {
    return await adapter.run({ prompt: message, sessionId, workdir, model: model || undefined, onEvent, signal: ac.signal });
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

// Council: every enabled agent answers → critiques the others → one synthesizes.
async function council({ question, synthesizer, onEvent, signal }) {
  const parts = providerList().filter((p) => p.enabled).map((p) => p.id);
  if (!parts.length) throw new Error('no enabled providers');
  const labelOf = (id) => (providerList().find((p) => p.id === id) || {}).label || id;
  const syn = (synthesizer && adapters.get(synthesizer)) ? synthesizer : (parts.includes('claude') ? 'claude' : parts[0]);
  const wd = store.workspaceFor('_council', 'shared');
  const tag = (agent, round) => (ev) => { if (ev.type === 'delta') onEvent({ type: 'delta', agent, round, text: ev.text }); };
  const ask = (provider, round, message) =>
    runAgent({ provider, workdir: wd, message, onEvent: tag(provider, round), signal })
      .then((r) => ({ agent: provider, text: r.text || '' }))
      .catch((e) => { onEvent({ type: 'delta', agent: provider, round, text: `(오류: ${e.message})` }); return { agent: provider, text: '' }; });
  const block = (arr) => arr.map((x) => `[${labelOf(x.agent)}]\n${x.text}`).join('\n\n');

  // Round 1 — independent answers (parallel)
  onEvent({ type: 'round', round: 1, label: '독립 답변', agents: parts });
  const r1 = await Promise.all(parts.map((p) =>
    ask(p, 1, `다음 질문에 당신의 의견으로 답하세요. 핵심 위주로 간결하게.\n\n[질문]\n${question}`)));

  // Round 2 — rebut / refine after seeing the others
  onEvent({ type: 'round', round: 2, label: '상호 반박·보완', agents: parts });
  const r2 = await Promise.all(parts.map((p) => {
    const others = r1.filter((x) => x.agent !== p).map((x) => `[${labelOf(x.agent)}]\n${x.text}`).join('\n\n');
    const mine = (r1.find((x) => x.agent === p) || {}).text || '';
    return ask(p, 2, `질문: ${question}\n\n[당신의 1차 답변]\n${mine}\n\n[다른 AI들의 답변]\n${others}\n\n다른 답변과 비교해 동의/반대할 점과 보완점을 밝히고, 필요하면 입장을 수정하세요. 토론하듯 간결하게.`);
  }));

  // Synthesis — designated agent
  onEvent({ type: 'round', round: 3, label: `종합 (${labelOf(syn)})`, agents: [syn] });
  await ask(syn, 3, `아래는 "${question}" 에 대한 여러 AI의 토론입니다.\n\n=== 1라운드 (독립 답변) ===\n${block(r1)}\n\n=== 2라운드 (반박·보완) ===\n${block(r2)}\n\n위 토론을 종합해 최종 결론을 내려주세요. 합의점과 쟁점을 짚고, 가장 타당한 결론을 제시하세요.`);

  onEvent({ type: 'done' });
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

    // --- council: multi-agent debate (answer → rebut → synthesize) ---
    if (req.method === 'POST' && url === '/api/council') {
      const body = await readBody(req);
      const question = body.question || body.message;
      if (!question) return send(res, 400, { error: 'question required' });
      sseHead(res);
      const ac = new AbortController();
      req.on('close', () => ac.abort());
      try {
        await council({ question, synthesizer: body.synthesizer, onEvent: (ev) => sse(res, ev), signal: ac.signal });
      } catch (e) {
        sse(res, { type: 'error', message: String(e.message || e) });
      }
      return res.end();
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
