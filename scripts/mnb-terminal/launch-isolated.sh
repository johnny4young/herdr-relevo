#!/bin/sh
set -eu
root=${MNB_PERF_ROOT:-/tmp/hmnb-20261102}
mnb_app_binary=${HERDR_APP_BINARY:-"$HOME/Applications/Herdr.app/Contents/MacOS/Herdr"}
mnb_core_binary=${HERDR_CORE_BINARY:-"$HOME/.local/bin/herdr-core"}
# Keep daemon cwd outside Documents; verified terminal.run/getcwd workaround.
cd "$root"
exec env -u GH_TOKEN -u GITHUB_TOKEN -u GH_CONFIG_DIR -u OPENAI_API_KEY -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN HOME="$root/home" PATH="$root/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$mnb_core_binary")" XDG_CONFIG_HOME="$root/xdg-config" XDG_DATA_HOME="$root/xdg-data" XDG_STATE_HOME="$root/xdg-state" XDG_CACHE_HOME="$root/xdg-cache" HC_SESSION=mnb-perf-20261102 HC_LAUNCHD_DIRECT=1 HERDR_APP_HOME="$root/app" HERDR_TELEMETRY=0 "$mnb_app_binary"
