# agentmux

> Use Claude Code, Codex, and Antigravity through one self-hosted API and web UI.

**agentmux** puts multiple headless AI agent CLIs behind a single gateway. Pick any
agent and model per request, stream the response, and keep multi-turn conversations —
from a clean web UI or over HTTP.

The HTTP API speaks the **OpenAI `/v1/chat/completions` format** (the de-facto standard),
so any OpenAI-compatible client or SDK — `curl`, the `openai` libraries, LangChain,
OpenWebUI, … — works unchanged. It just routes your request to **Claude / Codex /
Antigravity** instead of OpenAI. "OpenAI-compatible" is only the wire format, not the model.

**Contents:** [Features](#features) · [Quick start](#quick-start) · [API](#api) · [Configuration](#configuration) · [Tool policy & concurrency](#tool-policy--concurrency) · [Extending](#extending) · [Security](#security)

## Features

- 🔌 **Pluggable adapters** — add a provider with one file
- 🧠 **Per-agent model selection** (e.g. `claude/claude-opus-4-8`, `codex/gpt-5.5`, `antigravity/Gemini 3.1 Pro (High)`)
- 🌊 **Token streaming** (SSE) with smooth typewriter rendering
- 💬 **Multi-turn** conversations (per-provider session resume)
- 🔧 **Tool transcripts** — shows the agent's tool calls & results
- 🧩 **OpenAI-compatible API** (`/v1/chat/completions`, `/v1/models`)
- 🛡️ **Safe tool policy** — shell / file-write disabled, web / read / MCP allowed
- 🚦 **Per-provider concurrency** limits (agents run independently)
- 🪶 **Zero npm dependencies** — Node ≥ 20, plain `http`

## Quick start

**Requirements**

- Node.js ≥ 20
- The agent CLIs you want, **installed & authenticated for the user that runs agentmux**:
  - [Claude Code](https://docs.claude.com/claude-code) — `claude`
  - [OpenAI Codex](https://developers.openai.com/codex) — `codex`
  - [Google Antigravity](https://antigravity.google) — `agy`

**Run**

```bash
git clone <repo-url> agentmux && cd agentmux
cp config.example.json config.json      # then edit: set a strong authToken, host, providers
node server.js                          # or run via systemd (see deploy/agentmux.service)
```

Open the web UI at `http://<host>:<port>`, click 🔑, paste your token (stored in the browser).

## API

All requests require `Authorization: Bearer <authToken>`.

### OpenAI-compatible (recommended for external clients)

```
GET  /v1/models                  # list providers and provider/modelId combos
POST /v1/chat/completions
{ "model": "<provider>" | "<provider>/<modelId>", "messages": [...], "stream": true|false }
# header  X-Conversation-Id  → keep multi-turn (response returns conversation_id)
```

```bash
curl -N http://<host>:<port>/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"claude/claude-opus-4-8","stream":true,
       "messages":[{"role":"user","content":"hi"}]}'
```

### Native

```
POST /api/chat   { "provider", "model", "conversationId"?, "message" }   → SSE: meta|delta|tool|tool_result|error|done
GET  /api/providers
GET  /api/conversations   ·   GET /api/conversations/:id   ·   DELETE /api/conversations/:id
```

## Configuration

`config.json` (copy from `config.example.json`):

| key | meaning |
|---|---|
| `port` / `host` | bind address. Use `127.0.0.1` or a **VPN IP** (e.g. Tailscale); do **not** expose publicly without a reverse proxy + real auth |
| `authToken` | bearer token required by every API call |
| `maxConcurrentPerProvider` | concurrent agent runs per provider (default `3`) |
| `providers.<id>` | `{ enabled, label, models: [{ id, label }] }` |

## Tool policy & concurrency

**Tools** — shell execution and file writes are disabled; web, file-read, and MCP tools are allowed:

| provider | how |
|---|---|
| claude | `--disallowedTools Bash Write Edit NotebookEdit` |
| codex | `-c sandbox_mode="read-only"` |
| antigravity | `--sandbox` (+ workspace-only access) |

**Concurrency** — each provider has an independent limit (`maxConcurrentPerProvider`, default 3); agents don't block each other, and requests over the limit queue within that provider.

## Extending

**Layout**

```
server.js          HTTP server — auth, routing, SSE, OpenAI-compat, concurrency gate
adapters/
  index.js         provider registry
  claude.js        claude -p --output-format stream-json   (resume: --session-id / --resume)
  codex.js         codex exec --json                       (resume: codex exec resume <id>)
  antigravity.js   agy -p (plain text)                     (resume: --conversation <id>)
lib/store.js       conversation persistence (store/conversations.json)
public/index.html  single-file web UI
workspaces/<provider>/<conversationId>/   per-conversation working dir
config.json        local config (gitignored — copy from config.example.json)
```

**Add a provider**

1. Create `adapters/<id>.js` exporting:
   ```js
   module.exports = { id, label, run({ prompt, sessionId, workdir, model, onEvent, signal }) }
   ```
   `run` streams normalized events through `onEvent` (`{type:'delta'|'tool'|'tool_result'|'error', ...}`)
   and resolves `{ sessionId, text, cost }`.
2. Register it in `adapters/index.js`.
3. Add it under `providers` in `config.json` with `enabled: true`.
4. Restart.

## Security

- Single shared bearer token — intended for **personal / trusted use** over a VPN or localhost, not the public internet.
- Agents run with the host user's permissions (minus shell/write). Don't expose to untrusted callers.
- The CLIs consume **your** provider accounts & quotas — mind each provider's terms of service.

## License

MIT
