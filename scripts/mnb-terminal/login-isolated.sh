#!/bin/sh
# Run by the user in a normal local terminal; this script performs login only.
set -eu
root=${MNB_PERF_ROOT:-/tmp/hmnb-20261102}
case "${1:-}" in
  codex|claude) ;;
  *) printf '%s\n' 'Usage: login-isolated.sh codex|claude (existing account, secure CLI login only)' >&2; exit 2 ;;
esac
test -d "$root/home" || { printf '%s\n' 'Isolated profile is missing; do not fall back to a personal profile.' >&2; exit 1; }
mnb_codex_binary=${MNB_CODEX_BINARY:-"$(command -v codex)"}
mnb_claude_binary=${MNB_CLAUDE_BINARY:-"$(command -v claude)"}
cd "$root"
if test "$1" = codex; then
  mkdir -p "$root/home/.codex-native"
  exec env -u OPENAI_API_KEY -u CODEX_API_KEY -u CODEX_ACCESS_TOKEN HOME="$root/home" CODEX_HOME="$root/home/.codex-native" "$mnb_codex_binary" login --device-auth
fi
mkdir -p "$root/home/.claude-native"
exec env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN HOME="$root/home" CLAUDE_CONFIG_DIR="$root/home/.claude-native" "$mnb_claude_binary" auth login
