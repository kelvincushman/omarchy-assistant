# Phone setup

Omarchy Assistant uses ContentSwarm as a localhost user service and
adb-agent-bridge for semantic Android control.

## 1. Install Android Platform Tools

Run this in a visible terminal so the sudo prompt can accept your password:

```bash
omarchy pkg add android-tools
```

Confirm:

```bash
adb version
adb devices -l
```

## 2. Authorize the phone

On Android:

1. Open Settings → About phone.
2. Tap Build number seven times to enable Developer Options.
3. Open Developer Options and enable USB debugging.
4. Connect a data-capable USB cable.
5. Unlock the phone and accept the computer fingerprint prompt.

`adb devices -l` should report `device`. `unauthorized` means the phone still
needs the fingerprint confirmation.

## 3. Install or update ContentSwarm

The normal assistant installer does this. To run it directly from a local
ContentSwarm checkout:

```bash
scripts/install-contentswarm.sh "$HOME/Projects/ContentSwarm"
```

Without an argument, the script clones the pinned tested revision into
`~/.local/share/omarchy-assistant/ContentSwarm`. It creates a Python virtual
environment, stores a random API token in the GNOME keyring, creates an empty
phone registry, and enables `omarchy-contentswarm.service`.

## 4. Enroll connected devices

```bash
omarchy-assistant phone status
omarchy-assistant phone discover
omarchy-assistant phone phones
```

Discovery adds each authorized ADB device and persists it to
`~/.config/omarchy/assistant/phones.json`. Generated names derive from the ADB
serial. Use the returned name in later commands.

## 5. Install ADB Keyboard

Install [ADB Keyboard](https://github.com/senzhk/ADBKeyBoard) on the phone and
enable it under Android's keyboard settings. ContentSwarm activates it for fast
Unicode entry and keeps normal Android permissions intact.

## 6. Verify without changing external state

```bash
PHONE=<name-from-phones>
omarchy-assistant phone installed "$PHONE"
omarchy-assistant phone current "$PHONE"
omarchy-assistant phone ui "$PHONE"
omarchy-assistant phone launch "$PHONE" Settings
omarchy-assistant phone key "$PHONE" BACK
omarchy-assistant phone screenshot "$PHONE"
```

The kernel confirms every allowlisted key at the ContentSwarm boundary and
requires desktop approval for `ENTER` and `DPAD_CENTER`, which can activate a
focused control.

For messaging, prepare a clearly labeled draft and back out without sending:

```bash
umask 077
MESSAGE_FILE=$(mktemp)
trap 'rm -f "$MESSAGE_FILE"' EXIT
printf '%s' 'Omarchy setup test — do not send' >"$MESSAGE_FILE"
omarchy-assistant phone compose "$PHONE" sms +447700900123 \
  --body-file "$MESSAGE_FILE"
omarchy-assistant phone ui "$PHONE"
omarchy-assistant phone key "$PHONE" BACK
```

## 7. WhatsApp and social apps

Install and log into WhatsApp, TikTok, Instagram, YouTube, X, Facebook, and
LinkedIn on the phone yourself. Complete MFA, captchas, and Android permission
prompts directly on the device.

ContentSwarm should learn repeatable navigation only up to the final external
commit. Posting, commenting, liking, following, subscribing, sharing,
reposting, sending, deleting, login, and payment remain separate approved
actions.

## Wireless ADB

After USB authorization, Android's Wireless debugging screen can pair the
laptop. Use the current Android-provided address and pairing code. Device IPs
can change, so run discovery again after reconnecting.

## Service operations

```bash
systemctl --user status omarchy-contentswarm.service
systemctl --user restart omarchy-contentswarm.service
journalctl --user -u omarchy-contentswarm -n 100
```

## Troubleshooting

| Result | Meaning and action |
|---|---|
| `adb: command not found` | Install `android-tools` in a visible terminal |
| No devices | Unlock phone, check cable, enable USB debugging |
| `unauthorized` | Accept the fingerprint prompt on the phone |
| Service says no phones | Run `omarchy-assistant phone discover` |
| UI tree is empty | App may be canvas/WebView; use screenshot and learned vision flow |
| Text does not enter | Install and enable ADB Keyboard |
| `FLAG_SECURE` screenshot | Android/app protection; verify on the phone |
| Send draft mismatch | Recipient/body changed; compose and approve again |
| Send timeout | Inspect the conversation before any retry |

ContentSwarm does not root the phone or bypass app sandboxes, end-to-end
encryption, authentication, permissions, or protected screens.
