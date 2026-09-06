# Omarchy Assistant

A voice assistant for [Omarchy](https://omarchy.org): hold a key (or press the button on the
[omarchy-wearable](https://github.com/kelvincushman/omarchy-wearable)), say what you want, and a
headless coding agent does it on your laptop using the `omarchy` CLI. Everything you say lands in
an Obsidian vault. Things you overhear yourself committing to ("I'll send Bob the quote on Tuesday")
turn into suggestions that need one click before they become tasks, calendar events or gentle nudges.

Built on what Omarchy already ships: `voxtype transcribe` and `pw-record` for speech-to-text, `omarchy-notification-send`
for click-to-run notifications, `systemd-run` for scheduling, the Quickshell plugin API for the bar,
and `claude -p` (or `codex exec`) as the brain. About 1,000 lines of glue, no dependencies.

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

## Memory is the vault

The brain has no hidden memory store. Obsidian is the memory:

- **Recall**: when a request refers to the past, a person, a place or a plan, the brain runs
  `omarchy-assistant recall <words> [--days N]`, a capped ripgrep over the vault, newest files first,
  and quotes what it found with the date. It searches only when asked something that needs it.
- **Standing facts**: `Memory/about-me.md` is a note you edit in Obsidian. Its first 800 characters
  ride along with every request. The brain never writes to it; it asks you to add things.
- **Links**: suggestions link back to the day they were overheard, so a proposal, the ambient line,
  the accepted task and the conversation are one click apart in Obsidian's graph.

A compiled layer such as [Dossier](https://github.com/kelvincushman/HMLR-Wiki) can be added later
by ingesting the same folders; nothing here needs to change for that.

## Vault layout

```
Conversations/YYYY-MM-DD/<chatId>.md   each request and reply
Overheard/YYYY-MM-DD.md                ambient lines, append-only
Notes/YYYY-MM-DD.md                    dictated notes
Proposals/<id>.md                      one file per suggestion, status in frontmatter
Tasks/Inbox.md                         accepted tasks as `- [ ] text 📅 YYYY-MM-DD`
Memory/about-me.md                     standing facts you maintain; injected into every request
```

Files are only ever appended or atomically created. Nothing is deleted.

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
