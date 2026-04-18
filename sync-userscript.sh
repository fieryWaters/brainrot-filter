#!/bin/bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/userscript/brainrot.user.js"
DST="$HOME/Library/Containers/com.userscripts.macos.Userscripts-Extension/Data/Documents/scripts/brainrot.user.js"
cp "$SRC" "$DST"
echo "copied $SRC -> $DST"
echo "now click the Userscripts toolbar icon in Safari and hit Refresh."
