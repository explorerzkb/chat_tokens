<div align="center">
  <img src="assets/logo.svg" alt="Chat Tokens logo" width="84" height="84" />
  <h1>Chat Tokens & Context Monitor for Antigravity 2.0</h1>
</div>

[![Version](https://img.shields.io/badge/version-1.1.0-orange)](https://github.com/vladsboev-web/chat_tokens/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

All-in-one, zero-dependency plugin for **Google Antigravity 2.0** combining:
1. **Context Monitor** — a live native Sidecar side panel in the right-hand Auxiliary Pane.
2. **Instant `/ctx` & `/чат` commands** — a 0-token `PreInvocation` hook that prints the exact current chat token count without calling the LLM.

---

## Screenshots / Скриншоты

<p align="center">
  <img src="assets/context-monitor-panel.png" alt="Context Monitor Sidecar Panel" width="340" />
</p>

<p align="center">
  <img src="assets/ctx-command.png" alt="/ctx 0-token command output" width="560" />
</p>

---

## Features / Возможности

- **Live Sidecar Panel (`Context Monitor`)**
  - **Context & Stats tabs**: monitor live context window usage in the current chat alongside global `24h / 7d` analytics across all chats.
  - **Orchestrator & Multi-Model Scope Switcher**: switch between `All | Orchestrator | Executor` (or `All | <Models>` in manual mode, or 2-level when both modes appear in the same chat).
  - **Selectable threshold presets & custom limit**: `128k`, `160k`, `200k`, `256k`, `1M`, plus a **Custom** input (`300k`, `500000`, `1.5M`, etc.) saved in `localStorage`.
  - **Expandable 1-column Context Breakdown**: visual breakdown across 6 categories (*System & rules* with subcategories, *Files in context* with touched files list, *Tools & commands* with call counts, *Model responses*, *Thinking*, *User messages*), hiding 0-token rows.
  - **6-tile session summary & transition badges**: displays formatted model names with `Effort` pill (`Low / Medium / High / XHigh`), *Last message / step delta*, *Cache (last / avg)*, *Messages / Steps vs. Peak*, *Input + Output*, and *Duration*, plus `⚡ compacted`, `⇄ model`, and `⇄ effort` history badges.
  - **Global `24h / 7d` Stats tab**: 6-cell summary grid (*Chats / Messages*, *Model calls & compactions*, *Fresh input*, *From cache*, *Output*, *Active time*) and expandable *Models*, *Files*, *Tools*, and clickable *Active chats* lists.
  - **In-plugin Controls**: `Auto / Manual ↺ Auto` active-chat sync badge, `Auto / Light / Dark` theme cycle button (synced with Antigravity), and `RU / EN` language toggle.
  - **One-click `HANDOFF.md` prompt copy** — wrap up long sessions cleanly before auto-compaction erases fine-grained constraints.
  - Switch between the 10 most recent conversations (with titles read from `conversation_summaries.db` and incremental tail-reading of `transcript.jsonl`).
- **Instant 0-Token Slash Command (`/ctx`, `/чат`, `/chat`, `/tokens`)**
  - Both `/ctx` and `/чат` are registered in the `/` autocomplete menu (`skills/ctx/SKILL.md` and `skills/чат/SKILL.md`).
  - Intercepted locally by a `PreInvocation` hook (`./scripts/chat_tokens_hook.py`) before any model request is sent (**0 LLM tokens, 0 quota spent**).
  - Automatically syncs threshold, language (`RU / EN`), and view mode (`Messages / Steps`) with the Sidecar panel via `~/.gemini/config/chat_tokens_prefs.json`, and supports an optional threshold override (e.g. `/чат 256k`, `/ctx 1M`).
  - Renders directly in chat via `systemMessage` + `metadata.user_markdown` (`systemMessage: ""`) — clean inline Markdown with a compact summary line and a collapsible `<details>` session breakdown card (including a `[Context Monitor](sidecar://chat_tokens/context_monitor/)` shortcut).
- **100% Local & Zero Dependencies**
  - Uses only Node.js built-ins + Antigravity's built-in `sidecar_sdk`, and Python 3 standard library.
  - Read-only access to `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/` (`transcript.jsonl` / `transcript_full.jsonl`), `~/.gemini/antigravity/conversation_summaries.db`, and Antigravity theme settings.

---

## Requirements / Требования

- **Google Antigravity 2.0** (Desktop app)
- **Node.js** (bundled or installed on `PATH`)
- **Python 3** (for the `/ctx` / `/чат` hook)

---

## Installation / Установка

### Option 1: Via Antigravity CLI (`agy`)
```bash
agy plugin install https://github.com/vladsboev-web/chat_tokens
```

### Option 2: Manual / Antigravity 2.0 Desktop (`git clone`)
Clone (or copy) this repository into `~/.gemini/config/plugins/chat_tokens`:

```bash
git clone https://github.com/vladsboev-web/chat_tokens.git ~/.gemini/config/plugins/chat_tokens
```

Then **restart Antigravity 2.0**.

> **Note:** If you previously installed standalone `hooks.json`, `scripts/chat_tokens_hook.py`, `skills/ctx`, or `plugins/context_monitor`, remove those duplicates so the single unified plugin handles everything without hook conflicts.

---

## Usage / Использование

### 1. Sidecar Panel (`Context Monitor`)
Open the right-hand Auxiliary Pane and switch to the **Context** tab (or ask the agent to surface the `[Context Monitor](sidecar://chat_tokens/context_monitor/)` pill).

### 2. Slash Commands in Chat
Send any of the following as a standalone message (optionally with a custom threshold like `/чат 256k` or `/ctx 1M`):
- `/ctx` (available in the `/` autocomplete menu via `skills/ctx/SKILL.md`)
- `/чат`
- `/chat`
- `/tokens`

Example output:
```text
🟢 Контекст: 142 300 / 200k (71%) · +3 420 · кэш 96% · 4 Neon High · сообщ. 6
```
Clicking **Подробнее о сессии / Session details** expands a full Markdown summary with model/mode info, cache ratio, input/output totals, duration, estimated context breakdown, top files/tools, and a button to open the Sidecar panel.

---

## Repository Layout / Структура проекта

```text
chat_tokens/
├── plugin.json                        # Plugin manifest
├── hooks.json                         # PreInvocation hook registration
├── assets/
│   └── logo.svg                       # Plugin logo
├── scripts/
│   └── chat_tokens_hook.py            # 0-token local hook (/ctx, /чат, /chat, /tokens)
├── skills/
│   ├── ctx/
│   │   └── SKILL.md                   # Registers /ctx in the '/' autocomplete menu
│   └── чат/
│       └── SKILL.md                   # Registers /чат in the '/' autocomplete menu
└── sidecars/
    └── context_monitor/
        ├── package.json               # ESM module marker
        ├── sidecar.json               # Auxiliary Pane UI registration
        ├── main.mjs                   # Read-only transcript HTTP server
        └── index.html                 # Sidecar frontend UI
```

---

## Privacy & Security / Приватность

- No external network requests, no telemetry, no API calls.
- All files are read-only against local Antigravity logs (`~/.gemini/antigravity/brain/`).

---

## Authors / Авторы

- **vladsboev-web** — idea, architecture, and product direction
- **Antigravity (Google DeepMind)** — co-author & implementation

---

## License

[MIT](LICENSE)
