#!/bin/bash
# Installs the daemon for the current user. Prints, but never edits, the
# snippets that belong in files you own (bindings.lua, menu, voxtype).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
PLUGIN_DIR="$HOME/.config/omarchy/plugins/wearable.assistant"
CONF_DIR="$HOME/.config/omarchy/assistant"
VAULT=$(jq -r --arg d "$HOME/Documents/Omarchy" '.vault // $d' "$CONF_DIR/config.json" 2>/dev/null || echo "$HOME/Documents/Omarchy")

command -v node >/dev/null || { echo "node is required (it ships with the claude CLI via mise)"; exit 1; }
command -v claude >/dev/null || echo "warning: claude CLI not found; the brain will fail until it is installed"

if [[ ! -e $PLUGIN_DIR ]]; then
  mkdir -p "$(dirname "$PLUGIN_DIR")"
  ln -s "$HERE" "$PLUGIN_DIR"
  echo "linked $PLUGIN_DIR -> $HERE"
fi

mkdir -p "$HOME/.local/bin" "$CONF_DIR" "$HOME/.config/systemd/user"
ln -sf "$HERE/bin/omarchy-assistant" "$HOME/.local/bin/omarchy-assistant"
chmod +x "$HERE/bin/omarchy-assistant"
[[ -f $CONF_DIR/config.json ]] || cat >"$CONF_DIR/config.json" <<EOF
{
  "vault": "$VAULT",
  "port": 7477,
  "brain": "claude",
  "model": "claude-fable-5-1",
  "minerModel": "claude-haiku-4-5",
  "budgetUsd": 0.10,
  "quietHours": [22, 8]
}
EOF
mkdir -p "$VAULT"/{Conversations,Overheard,Notes,Proposals,Tasks}
[[ -f $VAULT/Tasks/Inbox.md ]] || printf '# Inbox\n\n' >"$VAULT/Tasks/Inbox.md"
[[ -f $VAULT/Memory/about-me.md ]] || { mkdir -p "$VAULT/Memory"; printf -- '---\ntags: [omarchy, memory]\n---\n# About me\n\nFacts the assistant should always know (first 800 characters are sent with every request).\n\n- Name:\n- Regular places:\n- People:\n- Preferences:\n' >"$VAULT/Memory/about-me.md"; }

cp "$HERE/systemd/omarchy-assistant.service" "$HOME/.config/systemd/user/omarchy-assistant.service"
systemctl --user daemon-reload
systemctl --user enable --now omarchy-assistant.service
sleep 1
systemctl --user --no-pager --lines=3 status omarchy-assistant.service || true

cat <<'EOF'

Done. Now add these yourself (they live in files you own):

1. ~/.config/hypr/bindings.lua
   o.bind("SUPER + ALT + O", "Ask Omarchy (hold)", "omarchy-assistant ptt start")
   o.bind("SUPER + ALT + O", "Ask Omarchy (release)", "omarchy-assistant ptt stop", { release = true })
   o.bind("SUPER + ALT + N", "Note to Omarchy (hold)", "omarchy-assistant ptt start note")
   o.bind("SUPER + ALT + N", "Note to Omarchy (release)", "omarchy-assistant ptt stop", { release = true })

2. voxtype: nothing to change. The hotkeys record with pw-record and call
   `voxtype transcribe`, so F9 dictation and the assistant never interfere.

3. ~/.config/omarchy/extensions/omarchy-menu.jsonc  (inside the outer braces)
   "assistant": {"icon":"󰚩","label":"Assistant","aliases":["assistant","omarchy assistant"]},
   "assistant.review": {"icon":"󰃰","label":"Review suggestions","action":"omarchy-assistant review"},
   "assistant.vault": {"icon":"󰎞","label":"Open vault","action":"omarchy-launch-or-focus obsidian obsidian"},
   "assistant.listen": {"icon":"󰍬","label":"Ambient listening","action":"omarchy-assistant listen toggle","checked":"omarchy-assistant listening"},
   "assistant.pair": {"icon":"󰄜","label":"Pair a phone","action":"omarchy-launch-floating-terminal-with-presentation 'omarchy-assistant pair phone; read -n1'"},
   "assistant.status": {"icon":"󰋼","label":"Status","action":"omarchy-launch-floating-terminal-with-presentation 'omarchy-assistant status; read -n1'"},

4. Bar widget: omarchy-shell shell rescanPlugins && omarchy plugin enable wearable.assistant

5. Open the vault once in Obsidian so it is registered:  obsidian "$VAULT"
EOF
