# Using Android phones

Read this for every request involving a phone, Android app, SMS, WhatsApp, or
social network. Use only `omarchy-phone-kernel`; never invoke `adb`, import
ContentSwarm modules, or call the ContentSwarm API directly.

The brain interprets language and writes reply or draft text. The kernel owns
device discovery, app launch, UI inspection, input, messaging transport,
approval, execution, verification metadata, and audit logs.

## Sense, act, verify

1. Run `omarchy-phone-kernel phones`; use a real connected phone name.
2. Sense with `current`, `installed`, `ui`, `messages`, or `screenshot`.
3. Choose the narrowest action: `launch`, `tap`, `type`, `key`, or `swipe`;
   use `replay` for a healthy known flow.
4. Use `learn` once for a reusable unknown workflow. Use `run` only for an
   open-ended one-off task.
5. Inspect again after acting. Report the evidence and any uncertainty.

Observation calls may be retried. Never blindly retry a state-changing action.
If a call times out after a tap, send, post, payment, or delete, inspect first.

## SMS and WhatsApp

1. Read visible state with `omarchy-phone-kernel messages PHONE sms|whatsapp`.
2. Put the final message in a mode-600 temporary file.
3. Prepare it with `compose PHONE CHANNEL RECIPIENT --body-file FILE`. This
   cannot send.
4. Call `send PHONE CHANNEL RECIPIENT --expect-body-file FILE`. The kernel
   shows the exact recipient and body in the desktop Allow/Deny gate.
5. Report success only when the returned JSON has `verified: true`. Inspect the
   conversation for stronger proof. Delete the temporary file.

Use AI only to understand incoming visible text and draft a reply. The kernel
performs all other communication mechanics.

If Android displays a saved contact name instead of its number, add
`--recipient-label "Exact visible name"` to `compose`. Composition fails closed
unless both the exact body and recipient identity are visible. Its five-minute,
single-use prepared token stays in the runtime directory and never enters the
brain response.

## Social media

Use the existing ContentSwarm flows and app skills for TikTok, Instagram,
YouTube, X, Facebook, and LinkedIn. A learned flow must stop before Post, Send,
Comment, Like, Follow, Subscribe, Repost, Share, Delete, Login, or Pay. Invoke
the final semantic `tap`; the kernel opens an approval gate when its selector
is sensitive.

The kernel also gates sensitive natural-language `run` and `learn` tasks. Do
not rephrase a request to avoid a gate.

## Limits

The phone kernel uses ordinary ADB, Android intents, accessibility trees, and
screenshots. It cannot root a phone, bypass permissions or authentication,
read private app databases, defeat WhatsApp encryption, or capture a
`FLAG_SECURE` screen. Ask the user to unlock, log in, complete MFA, or grant a
permission on the phone when Android requires it.
