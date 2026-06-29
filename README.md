# agentmux

> One OpenAI-compatible API + web UI in front of multiple headless AI agent CLIs.

**agentmux** multiplexes several agentic CLIs — Claude Code, OpenAI Codex, Google Antigravity, … — behind a single self-hosted gateway. Pick the agent and model per request, stream responses, keep multi-turn conversations, and call everything through an OpenAI-compatible `/v1/chat/completions` endpoint or a clean web UI.

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

## Requirements

- Node.js ≥ 20
- The agent CLIs you want, **installed & authenticated for the user that runs agentmux**:
  - [Claude Code](https://docs.claude.com/claude-code) — `claude`
  - [OpenAI Codex](https://developers.openai.com/codex) — `codex`
  - [Google Antigravity](https://antigravity.google) — `agy`

## Setup

```bash
git clone <repo-url> agentmux && cd agentmux
cp config.example.json config.json      # then edit: set a strong authToken, host, providers
node server.js                          # or run via systemd (see deploy/agentmux.service)
```

Open the web UI at `http://<host>:<port>`, click 🔑, paste your token (stored in the browser).

## Configuration — `config.json`

| key | meaning |
|---|---|
| `port` / `host` | bind address. Use `127.0.0.1` or a **VPN IP** (e.g. Tailscale); do **not** expose publicly without a reverse proxy + real auth |
| `authToken` | bearer token required by every API call |
| `maxConcurrentPerProvider` | concurrent agent runs per provider (default `3`) |
| `providers.<id>` | `{ enabled, label, models: [{ id, label }] }` |

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

## Adding a provider

1. Create `adapters/<id>.js` exporting:
   ```js
   module.exports = { id, label, run({ prompt, sessionId, workdir, model, onEvent, signal }) }
   ```
   `run` streams normalized events through `onEvent` (`{type:'delta'|'tool'|'tool_result'|'error', ...}`)
   and resolves `{ sessionId, text, cost }`.
2. Register it in `adapters/index.js`.
3. Add it under `providers` in `config.json` with `enabled: true`.
4. Restart.

## Tool policy

Shell execution and file writes are disabled; web, file-read, and MCP tools are allowed.

| provider | how |
|---|---|
| claude | `--disallowedTools Bash Write Edit NotebookEdit` |
| codex | `-c sandbox_mode="read-only"` |
| antigravity | `--sandbox` (+ workspace-only access) |

## Architecture

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

## Security notes

- Single shared bearer token — intended for **personal / trusted use** over a VPN or localhost, not the public internet.
- Agents run with the host user's permissions (minus shell/write). Don't expose to untrusted callers.
- The CLIs consume **your** provider accounts & quotas — mind each provider's terms of service.

## License

MIT
