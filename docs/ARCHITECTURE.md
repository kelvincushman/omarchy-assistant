# Architecture and trust boundaries

Omarchy Assistant uses a small language brain around deterministic local
kernels. The brain receives a short request context and Bash/Read tools. It
does not receive broad connector schemas for normal work.

## Trust zones

| Zone | Data and authority | Boundary |
|---|---|---|
| Explicit input | Hotkey or wearable-button transcript | May reach the tool-enabled brain |
| Ambient input | All-day nearby transcript | Append and tool-less proposal extraction only |
| Brain | Intent, summary, drafted text, command selection | Must use documented kernels |
| Mail kernel | IMAP/SMTP and mailbox mutations | Keyring secrets and desktop approval |
| Memory kernel | Obsidian hashes, raw snapshots, HMLR index | No model calls; source citations returned |
| Phone kernel | ContentSwarm CLI and phone mutations | Keyring token, approval, prepared-state binding |
| Browser/Desktop | Public, isolated, or approved logged-in UI | Sense-act-verify and approval boundaries |
| Vault | Conversations, notes, tasks, proposals, memory | Source of truth; append/atomic writes |

## Request lifecycle

An explicit request is written to JSONL and the Obsidian conversation before
the brain starts. The daemon sends the date, active window, standing facts,
three recent turns, and transcript to a fresh headless model process. The
system prompt tells the model which kernel owns each capability. The result is
written back to JSONL and Obsidian, streamed to the phone, shown as a desktop
notification, and mapped to wearable feedback.

Each request uses a fresh model context. Long-term recall is explicit through
the memory kernel, which prevents an ever-growing chat history from entering
every prompt.

## Ambient lifecycle

Ambient lines are appended under `Overheard/` and never enter the explicit
request handler. A regex gate queues likely first-person commitments. A
tool-less miner returns structured task/event candidates. Candidates become
pending Markdown proposals. Only a review action can accept one and create a
task, calendar event, or nudge.

## Kernel rule

The brain may interpret unstructured content and produce text. Code performs
the mechanics:

- email account/folder/message operations: `omarchy-mail-kernel`;
- Obsidian ingestion and retrieval: `omarchy-memory-kernel`;
- Android devices and apps: `omarchy-phone-kernel`;
- Omarchy OS operations: the `omarchy` command;
- repeat social actions: ContentSwarm learned-flow replay.

This keeps model calls focused on decisions that require language or visual
understanding. It also gives tests stable seams: each kernel can replace its
transport and approval commands with fakes.

## Approval protocol

Login, payment, sending, posting, commenting, following, liking, subscribing,
sharing, reposting, and deleting stop immediately before the commit action.
A desktop notification must be clicked within sixty seconds to allow the
concrete action once. A locked or unattended session therefore denies.

Approval is bound to concrete data where possible. The phone kernel stores the
prepared phone, channel, exact recipient, and SHA-256 body hash in the runtime
directory. A send refuses changed values and requires a new composition. The
email kernel displays sender, recipient, and subject. Both audit metadata after
the transport responds; neither audit stores bodies or credentials.

## Retry protocol

Read-only sensing may retry. State-changing operations execute once. If a
transport fails after a tap or request, the state is uncertain: inspect through
a fresh UI tree, screenshot, mailbox read, calendar search, or saved artifact
before deciding whether another action is needed.

## Credential storage

- Forward Email alias passwords: GNOME keyring, read by Himalaya.
- ContentSwarm bearer token: GNOME keyring attributes
  `service=contentswarm`, `account=api-token`.
- Wearable device tokens: hashed registry under the assistant config directory.
- Model authentication: the installed Claude/Codex harness credential store.

Secrets are not committed, inserted into Obsidian, or written into audit logs.

## Network listeners

- Assistant device API: configured port 7477, intended for the phone bridge
  over NetBird, with per-device authentication and rate limits.
- ContentSwarm: localhost `127.0.0.1:5055` by default, bearer-authenticated even
  though it is local.
- Browser CDP: localhost 9222 only while Chromium was explicitly started in
  approved attached mode.

## Failure containment

The Quickshell plugin only renders state and invokes the CLI. The Node daemon,
ContentSwarm service, memory timer, browser processes, and model calls run
outside Omarchy Shell, so their failures do not take down the bar or lock
screen. Systemd restarts the long-running user services.
