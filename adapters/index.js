'use strict';
// Adapter registry. Add new providers here as you build them out.
// Each adapter exports: { id, label, run({prompt, sessionId, workdir, model, onEvent, signal}) }
const claude = require('./claude');
const codex = require('./codex');
const antigravity = require('./antigravity');

const ADAPTERS = {
  claude,
  codex,
  antigravity,
};

function get(id) { return ADAPTERS[id]; }
function list() { return Object.values(ADAPTERS); }

module.exports = { get, list, ADAPTERS };
