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

function remove(id) {
  delete db.conversations[id];
  persist();
}

module.exports = { create, get, list, addMessage, setSession, remove, workspaceFor };
