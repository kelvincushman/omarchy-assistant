# Omarchy Assistant

A voice assistant for [Omarchy](https://omarchy.org): hold a key (or press the button on the
[omarchy-wearable](https://github.com/kelvincushman/omarchy-wearable)), say what you want, and a
headless coding agent does it on your laptop using the `omarchy` CLI. Everything you say lands in
an Obsidian vault. Things you overhear yourself committing to ("I'll send Bob the quote on Tuesday")
turn into suggestions that need one click before they become tasks, calendar events or gentle nudges.

Built on what Omarchy already ships: `voxtype transcribe` and `pw-record` for speech-to-text, `omarchy-notification-send`
for click-to-run notifications, `systemd-run` for scheduling, the Quickshell plugin API for the bar,
and `claude -p` (or `codex exec`) as the brain. The daemon has no npm dependencies; memory uses
a pinned Dossier virtual environment maintained outside the vault.

Email follows a stricter boundary: a deterministic `omarchy-mail-kernel` owns IMAP/SMTP,
folders, flags, delivery, approvals, and an audit log. AI is used only to understand message
content and compose drafts or replies. The normal mail path never loads a Gmail connector,
browser, or model tool schema.

## How it works

```
hotkey / wearable button ──▶ voxtype transcribe / phone STT ──▶ daemon ──▶ claude -p ──▶ omarchy CLI
                                                       │              └──▶ reply: notification + phone chat
ambient speech (text only) ────────────────────────────┤
                                                       ├──▶ ~/Documents/Omarchy  (Obsidian vault)
                                                       ├──▶ regex gate ──▶ tool-less miner ──▶ Proposals/
                                                       └──▶ click to accept ──▶ Tasks/Inbox.md + nudge timers
```

Three rules that come from the previous attempt at this idea:

1. **Ambient text produces artifacts, never replies.** The miner runs with no tools and can only
   emit data. The tool-enabled brain is reachable only from a button or hotkey.
2. **Nothing user-visible fires from ambient text without a click.** Suggestions arrive as one
   low-urgency notification; clicking opens a picker.
3. **Nudges are gentle.** Never critical, at most once an hour per item, deferred to a morning digest
   during quiet hours.

## Install

```bash
git clone https://github.com/kelvincushman/omarchy-assistant ~/Projects/omarchy-assistant
~/Projects/omarchy-assistant/install.sh
```

The installer links the plugin into `~/.config/omarchy/plugins/wearable.assistant`, writes
`~/.config/omarchy/assistant/config.json`, creates the vault, and enables a user systemd unit.
It then prints the snippets to add to `bindings.lua` and the menu extension.
Enable the bar widget with:

```bash
omarchy-shell shell rescanPlugins && omarchy plugin enable wearable.assistant
```

Requirements: Omarchy 4.x, `node` 22+ (ships with the `claude` CLI via mise), `claude` logged in,
`voxtype` running (`omarchy voxtype install`).

## Use

| Action | How |
|---|---|
| Ask for something | hold `SUPER+ALT+O`, speak, release. Or tap once to start and tap again to send. |
| Dictate a note | hold `SUPER+ALT+N`, speak, release, or tap to start and tap to send |
| Same from a terminal | `omarchy-assistant ask "remind me in 10 minutes to stretch"` |
| Review suggestions | click the notification, or `omarchy-assistant review`, or the bar widget |
| Mute ambient listening | right-click the bar widget, or `omarchy-assistant listen off` |
| Pair the phone app | `omarchy-assistant pair phone` (prints the token once) |
| Status | `omarchy-assistant status` |
| Memory status | `omarchy-assistant memory status` |
| Sync memory now | `omarchy-assistant memory sync` |

## Email kernel

`omarchy-assistant mail ...` is a compatibility entrypoint for `omarchy-mail-kernel`. The kernel
calls Himalaya directly and never calls a model, browser, MCP server, or cloud connector.

```bash
omarchy-assistant mail accounts
omarchy-assistant mail check aigentis
omarchy-assistant mail aigentis inbox 10
omarchy-assistant mail aigentis search 'from "person@example.com"'
omarchy-assistant mail aigentis read 42
printf 'Draft text' | omarchy-assistant mail aigentis draft person@example.com 'Subject'
printf 'Reply text' | omarchy-assistant mail aigentis reply 42
omarchy-assistant mail aigentis archive 42
```

Reading and reversible organization run locally without model cost. Send, reply, forward, and
delete stop at the desktop approval gate. Successful mutations append metadata (never bodies or
credentials) to `~/.local/state/omarchy-assistant/mail-audit.jsonl`; sent messages are copied to
the account's `Sent Mail` folder.

## Browser and desktop control

For anything involving a website or the screen, the brain reads `brain/COMPUTER.md` first.
It follows a sense, act, verify loop lifted from
[this write-up](https://www.kelvinlee.io/blog/agent-browser-cli-cdp-sense-act-verify):

- **Isolated browser by default** via the [`agent-browser`](https://github.com/vercel-labs/agent-browser)
  CLI (`npm i -g agent-browser`): `snapshot` to see, `click @ref` to act, `snapshot` or `get`
  again to verify. Observations may be retried; state-changing actions are never replayed blind.
- **Attached mode** drives your own logged-in Chromium over CDP, only on explicit request and
  only after `omarchy-assistant browser attach` gets a click on the laptop. The brain works in
  one pinned tab and never closes your browser.
- **Approval gate**: login, payment, sending, and deleting call `omarchy-assistant approve "<what>"`,
  which shows a menu on the laptop and denies after 60 seconds unattended.
- **Desktop**: `grim` screenshots the brain can read as images, `omarchy capture text` for OCR,
  `hyprctl dispatch` and `wtype` to act, another screenshot to verify. Nothing to install.
- **Escape hatch**: long multi-page jobs can be delegated once to
  `ORPHUS_ENABLE_BROWSER=1 orphus -p "..."`.

Replies must say what was verified and how; screenshots land in the vault next to the conversation.

## Config

`~/.config/omarchy/assistant/config.json`

| Key | Default | Meaning |
|---|---|---|
| `vault` | `~/Documents/Omarchy` | Obsidian vault directory |
| `port` | `7477` | TCP port for the phone app (bind with `bind`, default `0.0.0.0`) |
| `brain` | `claude` | `claude` or `codex` |
| `model` | `claude-fable-5-1` | Brain model. `claude-sonnet-5` is several times cheaper per request. |
| `minerModel` | `claude-haiku-4-5` | Tool-less extraction model for ambient text |
| `budgetUsd` | `0.10` | Hard cap per request |
| `quietHours` | `[22, 8]` | No mining, no nudges; deferred to the digest |
| `digestAt` | `08:30` | Daily "today" notification |

## HMLR memory, with Obsidian as source of truth

The deterministic `omarchy-memory-kernel` integrates
[Dossier](https://github.com/kelvincushman/HMLR-Wiki), pinned to a reviewed commit. It makes no
model calls. The assistant's model is used only after retrieval to understand the returned context
and answer the user.

This deliberately uses Dossier's document lattice rather than its optional `hmlr` dialogue client.
Enabling that client would add a second AI conversation pipeline and duplicate the existing Sonnet/Codex
brain. `omarchy-memory-kernel status` reports this distinction explicitly.

- **Immutable ingest**: changed Markdown notes become content-addressed snapshots in
  `~/.local/share/omarchy-assistant/memory/project/raw/`. A manifest prevents unchanged files from
  being ingested twice and preserves older revisions.
- **Dossier lattice**: Dossier deterministically extracts entity pages, concepts and exact facts.
  Its wiki lives directly in Obsidian at `Memory/Dossier/`; its SQLite state stays outside the vault.
- **Grounded recall**: `omarchy-assistant recall "<full question>" [--days N]` syncs first, then
  returns both Dossier candidates and capped exact `[path:line]` matches from the original notes.
  The second route covers source text that Dossier's current lexical crawler has not compiled.
- **Consolidation**: `omarchy-memory.timer` checks for changed notes every 30 minutes and runs the
  Dossier Gardener at most daily. Recall always syncs first, so a direct question sees fresh notes.
- **Standing facts**: `Memory/about-me.md` is still maintained by the user and its first 800
  characters ride with every request. The brain does not silently change it.

The runtime can be repaired or updated to the reviewed pin with `omarchy-memory-kernel setup`.
`omarchy-memory-kernel status --json` reports the pin, source count, wiki count and last runs.

## Vault layout

```
Conversations/YYYY-MM-DD/<chatId>.md   each request and reply
Overheard/YYYY-MM-DD.md                ambient lines, append-only
Notes/YYYY-MM-DD.md                    dictated notes
Proposals/<id>.md                      one file per suggestion, status in frontmatter
Tasks/Inbox.md                         accepted tasks as `- [ ] text 📅 YYYY-MM-DD`
Memory/about-me.md                     standing facts you maintain; injected into every request
Memory/Dossier/                        generated HMLR wiki (entities, concepts, sources, index)
```

Conversation, note and task sources are appended or atomically created; the memory kernel never
deletes them. `Memory/Dossier/` is a generated view, so Dossier may update or prune those pages while
the immutable raw snapshots remain outside the vault.

## Phone app contract

The daemon speaks the `omarchy-wearable` device contract over netbird. Every route needs
`X-Device-Id` + `X-Device-Token` or `Authorization: Bearer <token>`.

| Route | Purpose |
|---|---|
| `POST /api/device/text` `{text, overheard, at}` | transcript from the phone; explicit if a button event was seen in the last 90 s |
| `POST /api/device/event` `{kind:"button", code}` | 6 = ask, 7 = note, 8 = reply |
| `POST /api/device/command/poll` | drains queued LED/haptic commands (4-byte codec, `HABITAT_ALERTS`) |
| `GET /api/chat/stream?chatId=&since=` | SSE replies, replayable |

The pure contract modules in `daemon/contract/` are verbatim copies from the wearable repo; refresh them
with `scripts/sync-contract.sh <path-to-omarchy-wearable>`.

## Development

```bash
node --test daemon/                 # unit tests
systemctl --user restart omarchy-assistant
journalctl --user -u omarchy-assistant -f
```

## License

MIT. The device contract modules carry their own MIT header from omarchy-wearable.
