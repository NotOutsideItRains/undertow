#!/bin/sh
# Updates yt-dlp (and deno) on purpose, and shows what changed. Run it on the Undertow machine as the service user, for example:
#   sudo -u undertow /opt/undertow/tools/update-ytdlp.sh
# Videos stop working when YouTube changes something until yt-dlp is updated; this is the only thing that updates it (unless YTDLP_AUTOUPDATE=1).
set -eu
VENV="${VENV:-/opt/undertow/venv}"
echo "before:"; "$VENV/bin/pip" freeze | grep -iE '^(yt-dlp|yt-dlp-ejs|deno)=='
"$VENV/bin/pip" install --no-cache-dir -q -U "yt-dlp[default]" deno
echo "after:";  "$VENV/bin/pip" freeze | grep -iE '^(yt-dlp|yt-dlp-ejs|deno)=='
echo "Check a video still plays, then record the versions in tools/venv-requirements.txt ('pip freeze')."
