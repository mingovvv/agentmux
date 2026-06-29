'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STORE_DIR = path.join(ROOT, 'store');
const DB_FILE = path.join(STORE_DIR, 'conversations.json');
const WS_ROOT = path.join(ROOT, 'workspaces');

fs.mkdirSync(STORE_DIR, { recursive: true });

let db = { conversations: {} };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.conversations) db.conversations = {};
} catch { /* fresh */ }

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 100);
}

function workspaceFor(provider, id) {
  const dir = path.join(WS_ROOT, provider, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function create(provider, title) {
  const id = crypto.randomUUID();
  const conv = {
    id,
    provider,
    title: title || 'New chat',
    sessionId: null,
    workdir: workspaceFor(provider, id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  db.conversations[id] = conv;
  persist();
  return conv;
}

function get(id) { return db.conversations[id]; }

function list() {
  return Object.values(db.conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, provider, title, createdAt, updatedAt }) => ({ id, provider, title, createdAt, updatedAt }));
}

function addMessage(id, role, content) {
  const c = db.conversations[id];
  if (!c) return;
  c.messages.push({ role, content, ts: Date.now() });
  c.updatedAt = Date.now();
  if (role === 'user' && (c.title === 'New chat' || !c.title)) {
    c.title = content.slice(0, 60);
  }
  persist();
}

function setSession(id, sessionId) {
  const c = db.conversations[id];
  if (c) { c.sessionId = sessionId; persist(); }
}

/* ---- disk cleanup ---- */
const HOME = process.env.HOME || '/home/ubuntu';
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
function safeReaddir(d) { try { return fs.readdirSync(d); } catch { return []; } }

// best-effort removal of the underlying CLI session for a deleted conversation
function rmSession(provider, sessionId) {
  if (!sessionId) return;
  try {
    if (provider === 'antigravity') {
      rmrf(path.join(HOME, '.gemini/antigravity-cli/conversations', sessionId + '.db'));
    } else if (provider === 'codex') {
      const base = path.join(HOME, '.codex/sessions');
      let files = [];
      try { files = fs.readdirSync(base, { recursive: true }); } catch {}
      files.filter((f) => typeof f === 'string' && f.includes(sessionId) && f.endsWith('.jsonl'))
        .forEach((f) => rmrf(path.join(base, f)));
    }
    // claude: internal session store layout is fragile → left in place
  } catch {}
}

function remove(id) {
  const c = db.conversations[id];
  if (c) { rmrf(c.workdir); rmSession(c.provider, c.sessionId); }
  delete db.conversations[id];
  persist();
}

// sweep workspace dirs whose conversation no longer exists (orphans from old deletes)
function gcOrphans() {
  let removed = 0;
  for (const provider of safeReaddir(WS_ROOT)) {
    const pdir = path.join(WS_ROOT, provider);
    for (const id of safeReaddir(pdir)) {
      if (!db.conversations[id]) { rmrf(path.join(pdir, id)); removed++; }
    }
  }
  return removed;
}

module.exports = { create, get, list, addMessage, setSession, remove, workspaceFor, gcOrphans };
