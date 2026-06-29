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
async function runTurn({ provider, conversationId, message, model, onEvent, signal }) {
  const adapter = adapters.get(provider);
  if (!adapter) throw new Error(`unknown or disabled provider: ${provider}`);

  let conv = conversationId ? store.get(conversationId) : null;
  if (!conv) conv = store.create(provider, message);
  if (conv.provider !== provider) throw new Error('provider mismatch for this conversation');

  store.addMessage(conv.id, 'user', message);
  onEvent({ type: 'meta', conversationId: conv.id, provider });

  await acquire(provider); // per-provider concurrency gate
  // timeout: kill the child + free the slot if a run hangs
  const ac = new AbortController();
  const fwd = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', fwd); }
  const TMO = CONFIG.requestTimeoutMs || 300000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TMO);
  const t0 = Date.now();
  let result;
  try {
    result = await adapter.run({
      prompt: message,
      sessionId: conv.sessionId,
      workdir: conv.workdir,
      model: model || undefined,
      onEvent,
      signal: ac.signal,
    });
  } catch (e) {
    throw timedOut ? new Error(`request timed out after ${Math.round(TMO / 1000)}s`) : e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', fwd);
    release(provider);
  }
  log(`${provider}${model ? '/' + model : ''} ${Date.now() - t0}ms${result.cost ? ' $' + result.cost.toFixed(4) : ''} conv=${conv.id.slice(0, 8)}`);

  if (result.sessionId) store.setSession(conv.id, result.sessionId);
  store.addMessage(conv.id, 'assistant', result.text || '');
  return { conversationId: conv.id, ...result };
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
