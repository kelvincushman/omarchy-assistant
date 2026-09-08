#!/bin/bash

set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/omarchy-assistant"
DEST="$DATA_HOME/ContentSwarm"
SOURCE=${1:-}
CONTENTSWARM_REF=${CONTENTSWARM_REF:-8a88c0a0d8edffa99288fdf4374c44efa1c1ba41}
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/assistant"

command -v python >/dev/null || { echo "python is required" >&2; exit 1; }
command -v secret-tool >/dev/null || { echo "secret-tool is required" >&2; exit 1; }
mkdir -p "$DATA_HOME" "$CONF_DIR" "$HOME/.config/systemd/user" "$HOME/.local/bin"

if [[ -n $SOURCE ]]; then
  SOURCE=$(cd "$SOURCE" && pwd)
  [[ -f $SOURCE/run_server.py ]] || { echo "not a ContentSwarm checkout: $SOURCE" >&2; exit 2; }
  rm -rf "$DEST"
  ln -s "$SOURCE" "$DEST"
elif [[ -L $DEST ]]; then
  [[ -f $DEST/run_server.py ]] || { echo "existing ContentSwarm symlink is broken: $DEST" >&2; exit 2; }
elif [[ ! -d $DEST/.git ]]; then
  rm -rf "$DEST"
  git clone https://github.com/kelvincushman/ContentSwarm "$DEST"
  git -C "$DEST" checkout "$CONTENTSWARM_REF"
else
  git -C "$DEST" fetch origin
  git -C "$DEST" checkout "$CONTENTSWARM_REF"
fi

python -m venv "$DEST/.venv"
"$DEST/.venv/bin/pip" install -q -r "$DEST/requirements.txt" -r "$DEST/dashboard/requirements.txt"
"$DEST/.venv/bin/pip" install -q -e "$DEST"
[[ -f $CONF_DIR/phones.json ]] || printf '{"phones":[]}\n' >"$CONF_DIR/phones.json"
mkdir -p "$DATA_HOME/phone-flows"

if ! secret-tool lookup service contentswarm account api-token >/dev/null; then
  python -c 'import secrets; print(secrets.token_urlsafe(32))' |
    secret-tool store --label="ContentSwarm API" service contentswarm account api-token
fi

ln -sf "$HERE/bin/omarchy-phone-kernel" "$HOME/.local/bin/omarchy-phone-kernel"
chmod +x "$HERE/bin/omarchy-phone-kernel" "$HERE/bin/omarchy-contentswarm-service"
cp "$HERE/systemd/omarchy-contentswarm.service" "$HOME/.config/systemd/user/omarchy-contentswarm.service"
systemctl --user daemon-reload
systemctl --user enable --now omarchy-contentswarm.service

echo "ContentSwarm installed. Service: omarchy-contentswarm.service"
if ! command -v adb >/dev/null; then
  echo "Android Platform Tools are still required: omarchy pkg add android-tools" >&2
fi
