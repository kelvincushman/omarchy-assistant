# Omarchy Assistant

Open the phone GUI from the **ContentSwarm** application launcher, or run
`omarchy-phone-kernel console`. The ContentSwarm installer adds the launcher.
On first use, sign in with the separate console token stored in your keyring
(`service=contentswarm`, `account=console-token`). The browser keeps a session
cookie. The agent's API credential cannot log in or approve its own drafts.

Omarchy Assistant turns an Omarchy laptop into a voice-driven personal
orchestrator. A hotkey or wearable supplies speech, a small cloud model
understands the request, and deterministic kernels perform email, memory,
phone, browser, calendar, task, and desktop operations. Conversations and
derived artifacts live in an Obsidian vault.

Developed by **Kelvin Lee** and released under the MIT License.

## Current capabilities

- Push-to-talk from the laptop with `SUPER+ALT+O`; notes use `SUPER+ALT+N`.
- Explicit voice requests through Claude Sonnet or Codex with a per-request
  budget.
- Ambient transcript capture that can propose tasks and events but cannot act.
- Obsidian conversations, notes, overheard text, proposals, tasks, and memory.
- HMLR/Dossier long-term memory compiled deterministically from Obsidian.
- Google Calendar event creation plus gentle reminder timers.
- Deterministic IMAP/SMTP email through Himalaya and Forward Email.
- Isolated and attached browser use with sense, act, verify rules.
- Desktop control through Omarchy commands, Hyprland, screenshots, OCR, and
  keyboard input.
- Android phone control through ContentSwarm and adb-agent-bridge.
- SMS and WhatsApp inspection, safe composition, approval, one-shot send, and
  verification.
- TikTok, Instagram, YouTube, X, Facebook, and LinkedIn workflows through
  semantic actions or learned deterministic phone flows.
- A Quickshell bar widget, notification replies, phone chat API, and wearable
  LED/haptic command queue.

## Architecture

```text
wearable button / phone STT / laptop hotkey
                      │
                      ▼
              Omarchy Assistant daemon
                      │
          ┌───────────┴──────────────────────┐
          │                                  │
 explicit request                     ambient transcript
          │                                  │
  Sonnet/Codex brain                  regex + tool-less miner
  understands intent                         │
          │                             proposal only
          ▼                                  │
 deterministic command kernels ◀──── human acceptance
          │
          ├─ omarchy CLI: desktop, apps, reminders, notifications
          ├─ mail kernel: Himalaya + Forward Email IMAP/SMTP
          ├─ memory kernel: Obsidian → HMLR Dossier lattice
          ├─ phone kernel: ContentSwarm → adb-agent-bridge → Android
          ├─ browser: agent-browser / approved Chromium attachment
          └─ calendar: delegated Google Calendar operation
```

The model interprets language, summarizes content, and writes drafts or
replies. Transport, storage, account selection, scheduling, device input,
approval, and audit are ordinary code wherever a deterministic interface
exists.

Three rules govern the system:

1. Ambient speech produces artifacts and never reaches a tool-enabled brain.
2. External commitments require a user action: accepting a proposal or
   approving login, payment, sending, posting, or deletion.
3. State-changing actions are attempted once and verified before success is
   reported. An uncertain result is inspected before any retry.

## Install

```bash
git clone https://github.com/kelvincushman/omarchy-assistant \
  "$HOME/Projects/omarchy-assistant"
"$HOME/Projects/omarchy-assistant/install.sh"
```

The installer:

- links the checkout to
  `~/.config/omarchy/plugins/wearable.assistant`;
- links the assistant, mail, memory, and phone kernels into `~/.local/bin`;
- creates `~/.config/omarchy/assistant/config.json` and the vault layout;
- enables `omarchy-assistant.service` and the HMLR maintenance timer;
- installs ContentSwarm into the assistant data directory and enables
  `omarchy-contentswarm.service`;
- prints Hyprland and menu snippets that remain under user control.

Requirements are Omarchy 4+, Node 22+, a logged-in `claude` CLI or configured
Codex CLI, `jq`, `curl`, `secret-tool`, `pw-record`, `voxtype`, Python 3.10+,
and Git. Phone control additionally needs Android Platform Tools:

```bash
omarchy pkg add android-tools
```

Enable the bar widget after installation:

```bash
omarchy-shell shell rescanPlugins
omarchy plugin enable wearable.assistant
```

To skip phone installation during a minimal reinstall:

```bash
OMARCHY_ASSISTANT_INSTALL_PHONE=0 ./install.sh
```

See [docs/PHONE_SETUP.md](docs/PHONE_SETUP.md) for Android enrollment and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for trust boundaries.

## Voice and desktop use

| Action | Command or gesture |
|---|---|
| Ask | Hold `SUPER+ALT+O`, speak, release |
| Tap-to-talk | Tap `SUPER+ALT+O`, speak, tap again |
| Dictate a note | Hold/tap `SUPER+ALT+N` |
| Ask from a terminal | `omarchy-assistant ask "what is on my schedule?"` |
| Review proposals | `omarchy-assistant review` |
| Toggle ambient capture | `omarchy-assistant listen toggle` |
| Open status | `omarchy-assistant status` |
| Pair wearable app | `omarchy-assistant pair phone` |

Push-to-talk records to the user runtime directory, stops after 90 seconds,
transcribes with `voxtype transcribe`, and removes the WAV. This avoids typing
the transcript into the focused application and prevents an abandoned
recording from filling the runtime filesystem.

## Tasks, events, and nudges

Ambient speech is appended verbatim under `Overheard/`. A zero-cost regex gate
selects possible first-person commitments, then a tool-less miner may create a
proposal. The miner cannot reply, launch apps, send messages, or modify a task.

Accepted tasks use Obsidian Tasks checkbox syntax in `Tasks/Inbox.md`. Accepted
events can create a Google Calendar event through a dedicated calendar call.
Reminder timers use `systemd-run --user`: tasks normally nudge at 09:00 on the
due date; events receive T-60 and T-10 reminders. Quiet hours defer nudges to a
morning digest.

```bash
omarchy-assistant review
omarchy-assistant digest
omarchy-assistant calendar-add "Dentist" "2026-09-08T09:00"
```

## Email kernel

Email has a hard boundary. The brain may understand a message, summarize it,
or write a draft. `omarchy-mail-kernel` performs account access, IMAP/SMTP,
folders, flags, moves, drafts, sends, replies, forwards, and deletion. Normal
email work does not use a browser, connector, or model tool schema.

```bash
omarchy-assistant mail accounts
omarchy-assistant mail check aigentis
omarchy-assistant mail aigentis inbox 10
omarchy-assistant mail aigentis search 'from "person@example.com"'
omarchy-assistant mail aigentis read 42
printf '%s' 'Draft body' |
  omarchy-assistant mail aigentis draft person@example.com 'Subject'
printf '%s' 'Approved body' |
  omarchy-assistant mail aigentis send person@example.com 'Subject'
omarchy-assistant mail aigentis archive 42
```

Send, reply, forward, and delete open a desktop notification that must be
clicked within 60 seconds to allow the action once. Successful
mutations append metadata to
`~/.local/state/omarchy-assistant/mail-audit.jsonl`; bodies and credentials are
not logged. Alias passwords remain in the GNOME keyring and Himalaya reads them
at runtime.

## HMLR memory with Obsidian

Obsidian is the source of truth. `omarchy-memory-kernel` pins the Dossier
implementation from [HMLR-Wiki](https://github.com/kelvincushman/HMLR-Wiki),
copies changed Markdown into an immutable raw store, ingests each content hash
once, and exposes the generated lattice under `Memory/Dossier/` in the vault.
This synchronization and retrieval layer makes no model calls.

```bash
omarchy-assistant memory status
omarchy-assistant memory sync
omarchy-assistant memory garden
omarchy-assistant recall "What did I say about the electrician quote?"
omarchy-assistant recall "What was planned last week?" --days 7
```

Recall combines ranked HMLR pages with exact `[path:line]` matches from the
original vault. The answering brain must cite those sources and say when the
memory contains no support. `Memory/about-me.md` supplies up to 800 characters
of standing facts on every explicit request; only the user edits it.

The maintenance timer runs incremental syncs. Generated Dossier pages are
excluded from re-ingestion so the lattice cannot recursively ingest itself.

## Phone kernel

Phone operations use
[ContentSwarm](https://github.com/kelvincushman/ContentSwarm) as the Android
service and
[adb-agent-bridge](https://github.com/kelvincushman/adb-agent-bridge) for
semantic sensing and constrained input. The brain invokes only
`omarchy-phone-kernel`.

```bash
omarchy-assistant phone status
omarchy-assistant phone discover
omarchy-assistant phone phones
omarchy-assistant phone installed primary
omarchy-assistant phone current primary
omarchy-assistant phone ui primary
omarchy-assistant phone launch primary WhatsApp
omarchy-assistant phone tap primary --text Continue
omarchy-assistant phone type primary "caption text"
omarchy-assistant phone key primary BACK
omarchy-assistant phone screenshot primary
```

The wrapper supplies ContentSwarm's exact confirmation flag for every key
event. `ENTER` and `DPAD_CENTER` also open the click-to-allow desktop gate because
they can activate a focused Send, Post, Delete, Login, or payment control.

### SMS and WhatsApp

Composition cannot send. The send command requires the same phone, channel,
recipient, and body hash that were prepared, then displays the exact recipient
and body in the desktop approval notification:

```bash
umask 077
MESSAGE_FILE=$(mktemp)
trap 'rm -f "$MESSAGE_FILE"' EXIT
printf '%s' 'I will arrive at 09:00.' >"$MESSAGE_FILE"
omarchy-assistant phone compose primary whatsapp +447700900123 \
  --body-file "$MESSAGE_FILE"
omarchy-assistant phone send primary whatsapp +447700900123 \
  --expect-body-file "$MESSAGE_FILE"
```

When Android shows a saved contact name instead of its number, add
`--recipient-label "Exact visible name"` to the compose command. ContentSwarm
verifies the visible recipient and exact body, then returns a five-minute,
single-use prepared token. The kernel keeps that token in the runtime directory
and binds it to the approved values.

After approval, ContentSwarm checks the expected text in an enabled editor,
finds one enabled Send control, taps once, and verifies that the composer
cleared. The audit log at
`~/.local/state/omarchy-assistant/phone-audit.jsonl` stores action metadata and
a masked recipient, without bodies or API tokens.

### Social media

Use `omarchy-assistant phone social accounts` and
`phone social context --account ID --query WORDS` for account-scoped voice,
knowledge and prior posts/replies. `phone social remember --account ID --file FILE`
adds a sourced observation. Accounts and recurring draft schedules are edited
in the ContentSwarm console; its optional systemd user timer wakes once a minute.
See [ContentSwarm's social guide](https://github.com/kelvincushman/ContentSwarm/blob/main/dashboard/SOCIAL.md)
for setup, lease handling, calibration and current delivery limits.

Choose **Reply to a conversation** in Accounts & schedules to supply a source
link, author and original message. Draft immediately or on an editable schedule.
The worker retrieves the account soul and thread context, applies Humanizer and
queues the response for review. Recurring reply schedules reuse that target;
they do not automatically discover new replies.

The ContentSwarm mobile console at `http://127.0.0.1:5055` provides tasks,
phone preview, learned workflows, and an X/LinkedIn/Facebook reply review queue.
Sign in with the separate ContentSwarm console token. Humanizer 3.0.0 is bundled for the
drafting agent. Compare original messages with drafts, approve, reject or edit.
The queue is a handoff for an external agent; approval alone does not publish.
Phone action approvals still apply when delivering a reviewed draft.

`omarchy-assistant phone reviews` lists records. `phone review-add FILE` submits
a draft; `phone review-action ID claim|complete|uncertain --revision N` supports
worker handoff. No automatic background collector is installed.

ContentSwarm includes skills and learn/replay support for TikTok, Instagram,
YouTube, X, Facebook, and LinkedIn. The brain uses semantic actions first,
then an existing learned flow, then learns a new flow once. Routine replay
uses no model. Flows stop before Post, Comment, Like, Follow, Subscribe, Share,
Repost, Delete, Login, or Pay; the final semantic tap opens the approval gate.

Phone access uses normal ADB, Android intents, accessibility, and screenshots.
It cannot root a phone, bypass permissions or authentication, read private app
databases, defeat WhatsApp encryption, or capture `FLAG_SECURE` screens.

## Browser and computer use

For websites and GUI applications, the brain reads `brain/COMPUTER.md` and
follows sense, act, verify:

- Public and isolated browsing uses `agent-browser` with a throwaway Chromium
  profile and accessibility-tree references.
- Logged-in Chromium is available only after `omarchy-assistant browser attach`
  obtains approval. The assistant controls one pinned tab and never closes the
  user's browser.
- Desktop fallback uses screenshots or OCR to sense, Omarchy/Hyprland/wtype to
  act, and a second channel or saved artifact to verify.
- Login, payment, sending, and deletion always stop at the approval gate.

```bash
omarchy-assistant browser status
omarchy-assistant browser attach github.com
omarchy-assistant browser detach
```

## Configuration and data

Main config: `~/.config/omarchy/assistant/config.json`

```json
{
  "vault": "/home/you/Documents/Obsidian Vault",
  "port": 7477,
  "brain": "claude",
  "model": "claude-sonnet-5",
  "minerModel": "claude-haiku-4-5",
  "budgetUsd": 0.30,
  "quietHours": [22, 8]
}
```

ContentSwarm binds to `127.0.0.1:5055` by default. Its bearer token is stored
as `service=contentswarm, account=api-token` in the GNOME keyring. Phone names
are persisted in `~/.config/omarchy/assistant/phones.json`; learned flows live
under `~/.local/share/omarchy-assistant/phone-flows`.

Vault layout:

```text
Conversations/YYYY-MM-DD/<chat>.md
Overheard/YYYY-MM-DD.md
Notes/YYYY-MM-DD.md
Proposals/<id>.md
Tasks/Inbox.md
Memory/about-me.md
Memory/Dossier/{entities,concepts,sources}/
Articles/
```

Runtime sockets, recordings, and prepared-message bindings live under
`$XDG_RUNTIME_DIR/omarchy-assistant` and disappear at logout. Persistent audit
logs live under `$XDG_STATE_HOME/omarchy-assistant`.

Phone screenshots are restricted to that runtime directory or the Obsidian
vault. With no `-o`, the kernel creates a timestamped runtime PNG.

## Phone app and wearable API

The assistant daemon listens on port 7477 for the Flutter phone bridge over
NetBird. Pairing returns a device id, base URL, and one-time token. Authenticated
routes accept explicit or overheard text, device events, command polling, and
chat SSE. The laptop never accepts raw audio through this interface; the phone
transcribes first.

```bash
omarchy-assistant pair phone
```

The wearable command queue carries four-byte LED/haptic commands for queued,
running, awaiting-input, done, error, and budget-warning states. The separate
`omarchy-wearable` repository owns firmware and Flutter implementation.

## Services and diagnostics

```bash
systemctl --user status omarchy-assistant.service
systemctl --user status omarchy-contentswarm.service
systemctl --user status omarchy-memory.timer
journalctl --user -u omarchy-assistant -n 50
journalctl --user -u omarchy-contentswarm -n 50
omarchy-assistant memory status
omarchy-assistant phone status
```

## Development

```bash
npm test
bash -n bin/omarchy-assistant bin/omarchy-mail-kernel \
  bin/omarchy-phone-kernel bin/omarchy-contentswarm-service \
  install.sh scripts/install-contentswarm.sh
```

The Node daemon has no npm runtime dependencies. Kernel tests replace every
external transport and approval command with fakes, so denial and no-send paths
are verified without touching accounts or phones.

## Documentation

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Phone installation and enrollment](docs/PHONE_SETUP.md)
- [Browser and desktop operating contract](brain/COMPUTER.md)
- [Phone brain contract](brain/PHONE.md)
- [ContentSwarm](https://github.com/kelvincushman/ContentSwarm)
- [HMLR-Wiki](https://github.com/kelvincushman/HMLR-Wiki)

## License

MIT — see [LICENSE](LICENSE).
