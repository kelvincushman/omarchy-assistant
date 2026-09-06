# Omarchy Assistant

A voice assistant for [Omarchy](https://omarchy.org): hold a key (or press the button on the
[omarchy-wearable](https://github.com/kelvincushman/omarchy-wearable)), say what you want, and a
headless coding agent does it on your laptop using the `omarchy` CLI. Everything you say lands in
an Obsidian vault. Things you overhear yourself committing to ("I'll send Bob the quote on Tuesday")
turn into suggestions that need one click before they become tasks, calendar events or gentle nudges.

Built on what Omarchy already ships: `voxtype` for speech-to-text, `omarchy-notification-send`
for click-to-run notifications, `systemd-run` for scheduling, the Quickshell plugin API for the bar,
and `claude -p` (or `codex exec`) as the brain. About 1,000 lines of glue, no dependencies.

## How it works

```
hotkey / wearable button ──▶ voxtype or phone STT ──▶ daemon ──▶ claude -p ──▶ omarchy CLI
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
It then prints the snippets to add to `bindings.lua`, `voxtype/config.toml` and the menu extension.
Enable the bar widget with:

```bash
omarchy-shell shell rescanPlugins && omarchy plugin enable wearable.assistant
```

Requirements: Omarchy 4.x, `node` 22+ (ships with the `claude` CLI via mise), `claude` logged in,
`voxtype` running (`omarchy voxtype install`).

## Use

| Action | How |
|---|---|
| Ask for something | hold `SUPER+ALT+O`, speak, release |
| Dictate a note | hold `SUPER+ALT+N`, speak, release |
| Same from a terminal | `omarchy-assistant ask "remind me in 10 minutes to stretch"` |
| Review suggestions | click the notification, or `omarchy-assistant review`, or the bar widget |
| Mute ambient listening | right-click the bar widget, or `omarchy-assistant listen off` |
| Pair the phone app | `omarchy-assistant pair phone` (prints the token once) |
| Status | `omarchy-assistant status` |

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

## Vault layout

```
Conversations/YYYY-MM-DD/<chatId>.md   each request and reply
Overheard/YYYY-MM-DD.md                ambient lines, append-only
Notes/YYYY-MM-DD.md                    dictated notes
Proposals/<id>.md                      one file per suggestion, status in frontmatter
Tasks/Inbox.md                         accepted tasks as `- [ ] text 📅 YYYY-MM-DD`
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
