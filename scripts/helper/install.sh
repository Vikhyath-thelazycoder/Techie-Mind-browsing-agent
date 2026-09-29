#!/bin/sh
# One-time setup: lets the Techie Mind extension switch Laya and the voice server on and off.
# Usage: sh scripts/helper/install.sh <extension-id>
# (Settings → AI & Models shows this exact command with your extension id.)
set -e
ID="$1"
if [ -z "$ID" ]; then
  echo "Usage: sh scripts/helper/install.sh <extension-id>   (see Settings → AI & Models)" >&2
  exit 1
fi
case "$ID" in *[!a-p]*) echo "That is not a Chrome extension id: $ID" >&2; exit 1 ;; esac

HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/techie_mind_helper.py"
chmod +x "$HELPER"
DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$DIR"
cat > "$DIR/com.techiemind.helper.json" <<EOF
{
  "name": "com.techiemind.helper",
  "description": "Techie Mind: switch local Laya and voice server on/off",
  "path": "$HELPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
echo "Installed. Reload the extension, then use the switches in Settings."
