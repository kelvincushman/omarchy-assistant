# Using the browser and the desktop

Read this when a request involves a website, a web app, or the screen. The rule is
**sense, act, verify**: look before acting, act once, then prove the outcome through a
different channel than the action. Never report an attempt as a result.

## Choose the least powerful route

1. A structured route exists (an `omarchy` command, `agent-browser read <url>` for plain
   reading, a public API via `curl`): use it. No browser.
2. The page itself must be exercised: use the isolated browser below.
3. The task needs the user's logged-in accounts: attached mode below, which asks the user.
4. Login, payment, sending a message or email, deleting anything, or any irreversible step:
   run `omarchy-assistant approve "<what you are about to do>"` first and continue only if
   it prints `allowed`. If it prints `denied`, stop and say so. Ask once, never twice.

## Isolated browser (default)

`agent-browser` launches a throwaway Chromium with no cookies or accounts.

```
agent-browser open <url>                 # launch and navigate
agent-browser snapshot                   # accessibility tree with refs like @e12  ← SENSE
agent-browser click @e12                 # act by ref
agent-browser fill @e7 "text"            # clear and type
agent-browser find text "Sign In" click  # semantic locators: role|text|label|placeholder
agent-browser wait --text "Saved"        # wait for evidence, not for time
agent-browser get title | get url | get text @e3
agent-browser read                       # readable text of the current page
agent-browser screenshot <path>          # evidence for the user
agent-browser close                      # always, when done
```

Contract:
- `snapshot`, `get`, `read`, `screenshot` are observations: repeat them freely.
- `open`, `click`, `fill`, `type` change state: never repeat one blind. If it fails or the
  effect is uncertain, `snapshot` again and decide from what you see.
- A click that reports a covering element (cookie banner, modal): deal with the cover, then
  snapshot again before retrying the original ref.
- Prefer `agent-browser batch` for a known sequence of steps to save process startups.
- Budget: each browser step is cheap, but the whole request has a dollar cap shown in the
  request header. Plan the shortest path; do not explore.

## Attached mode (the user's own Chromium, only on explicit request)

Only when the user clearly asks to use their own account or browser. Run
`omarchy-assistant browser attach "<site>"`; it asks the user on screen and either prints
`attached: …` or a reason it cannot. Then use `agent-browser --cdp 9222 --pin-tab open <url>`
and keep working in that one tab with `--cdp 9222` on every command. When finished, close
only your tab with `agent-browser --cdp 9222 tab close`. **Never run `agent-browser close`
against the attached browser**: it is the user's real session.

## Desktop (windows, typing, reading the screen)

- Sense: `grim /tmp/screen.png` then `Read /tmp/screen.png` (you can see images), or
  `omarchy capture text` for OCR of the visible screen. `hyprctl activewindow -j` for the
  focused window; `hyprctl clients -j | jq '.[] | {class,title,workspace}'` for all windows.
- Act: Omarchy's `hyprctl dispatch` takes a Lua dispatcher, not a string:
  `hyprctl dispatch 'hl.dsp.focus({ window = "address:0x…" })'` (address from `hyprctl clients -j`),
  `hyprctl dispatch 'hl.dsp.focus({ window = "class:md.obsidian.Obsidian" })'`,
  `hyprctl dispatch 'hl.dsp.focus({ workspace = "3" })'`. Window classes are exact and often
  namespaced (Obsidian is `md.obsidian.Obsidian`, not `obsidian`). `omarchy launch …` opens apps,
  `xdg-open <uri>` hands a file or `obsidian://open?path=<url-encoded>` to its app, `wtype "text"`
  types into the focused window, `wtype -k Return` sends keys, `wl-copy`/`wl-paste` for the clipboard.
- Prefer the least powerful route: writing a file into the vault and opening it beats typing it.
- Verify: take another screenshot or OCR pass and check the state changed as intended.
- Typing into a window the user may be using is a state change: focus the right window
  first, and never type secrets.

## Escape hatch for long multi-page jobs

For a job with many pages or a form-heavy workflow, delegate once instead of looping:

```
ORPHUS_ENABLE_BROWSER=1 orphus -p "<the task, with the verification you need>"
```

Orphus runs its own isolated browser with the same retry contract and reports back.
Use it sparingly; it is a second agent with its own token bill.

## Evidence in your reply

State what you verified and how: the page title or URL, the text you read, the file path of
a screenshot. If you could not verify, say what is unverified. Save screenshots the user
should see under `<Vault>/Conversations/<today>/assets/` (the vault path is in the request
header) so they appear beside the conversation in Obsidian.
