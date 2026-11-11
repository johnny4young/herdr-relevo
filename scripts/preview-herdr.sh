#!/bin/bash
# Run the installed, signed Herdr app against synthetic local preview data only.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
REAL_HOME="$(cd ~ && pwd -P)"
APP="$REAL_HOME/Applications/Herdr.app/Contents/MacOS/Herdr"
CORE_ROOT="$REAL_HOME/.local/share/herdr-core"
CORE="$CORE_ROOT/current/Contents/MacOS/herdr-core"
ROOT="/private/tmp/herdr-relevo-preview-$(id -u)"
PROFILE="$ROOT/preview.sb"
NODE_RUNTIME="$(node -p 'require("node:fs").realpathSync(process.execPath)')"
MARKER="$ROOT/.relevo-preview-owner"
case "$REAL_HOME" in *'"'*|*'\\'*) echo 'Unsupported home path' >&2; exit 1;; esac
# The root sits at a predictable /tmp path, so it is reused only when this user created it privately.
owned() { test ! -L "$ROOT" && test -d "$ROOT" && test "$(stat -f '%u %Lp' "$ROOT")" = "$(id -u) 700"; }
require_setup() { owned && test -f "$MARKER" && test "$(cat "$MARKER")" = "$(id -u)" || { echo 'Run setup first' >&2; exit 1; }; }
isolated() (
  cd "$ROOT/home"
  /usr/bin/env -i HOME="$ROOT/home" USER="$(id -un)" LOGNAME="$(id -un)" \
    PATH="$ROOT/bin:/Applications/Xcode.app/Contents/Developer/usr/bin:/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin" SHELL=/bin/sh TMPDIR="$ROOT/tmp/" \
    XDG_CONFIG_HOME="$ROOT/config" XDG_STATE_HOME="$ROOT/state" XDG_DATA_HOME="$ROOT/data" \
    XDG_CACHE_HOME="$ROOT/cache" XDG_RUNTIME_DIR="$ROOT/run" \
    HERDR_APP_HOME="$ROOT/app" HERDR_APP_ID=dev.herdr.relevo.preview \
    HC_SESSION=relevo-preview HC_SOCKET="$ROOT/run/core.sock" HC_LAUNCHD_DIRECT=1 \
    DO_NOT_TRACK=1 HERDR_TELEMETRY=0 HERDR_APP_NO_SOUND=1 \
    HERDR_RELEASES_URL=http://127.0.0.1:9 \
    /usr/bin/sandbox-exec -f "$PROFILE" "$@"
)
case "${1:-help}" in
setup)
  test -x "$APP" && test -x "$CORE"
  test -f "$REPO/layouts/relevo-preview.json" || { echo 'Missing layouts/relevo-preview.json' >&2; exit 1; }
  if test -e "$ROOT" || test -L "$ROOT"; then require_setup; else mkdir -m 700 "$ROOT"; id -u > "$MARKER"; fi
  test ! -L "$ROOT" || exit 1
  if test -f "$PROFILE" && isolated "$APP" status >/dev/null 2>&1; then
    echo 'Preview is running. Stop it before setup; no state was overwritten.' >&2; exit 1
  fi
  if test -f "$ROOT/launcher.pid" && kill -0 "$(cat "$ROOT/launcher.pid")" 2>/dev/null; then
    echo 'Preview launcher is alive. Stop it before setup; no state was overwritten.' >&2; exit 1
  fi
  for d in home bin config state data cache run tmp app app/mods app/layouts config/herdr-core; do mkdir -p "$ROOT/$d"; done
  # Record exactly which repository files were copied before replacing preview files.
  (cd "$REPO"; find mods -type f -exec /usr/bin/shasum -a 256 '{}' \;; /usr/bin/shasum -a 256 layouts/relevo-preview.json) > "$ROOT/source-sha256.txt"
  cp "$REPO/scripts/isolation-check.mjs" "$ROOT/isolation-check.mjs"
  cp "$REPO/scripts/preview-seed.mjs" "$ROOT/preview-seed.mjs"
  # Only repository-owned mods; never copy the user's Herdr configuration.
  /usr/bin/ditto "$REPO/mods" "$ROOT/app/mods"
  cp "$REPO/layouts/relevo-preview.json" "$ROOT/app/layouts/relevo-preview.json"
  ln -sfn "$CORE" "$ROOT/bin/hc"
  ln -sfn "$CORE" "$ROOT/bin/herdr-core"
  ln -sfn "$APP" "$ROOT/bin/herdr-app"
  printf '%s\n' '{"telemetry":false,"clipboard_write":false,"appearance":"dark"}' > "$ROOT/app/settings.json"
  printf '%s\n' '{"layout":"relevo-preview","frame.welcomed":"skipped"}' > "$ROOT/app/shared.json"
  printf '%s\n' 'notes = false' 'shell = ["/bin/sh"]' > "$ROOT/config/herdr-core/config.toml"
  cat > "$PROFILE" <<EOF
(version 1)
(allow default)
; No internet or TCP/UDP loopback. Only isolated filesystem Unix sockets.
(deny network*)
(allow network* (local unix-socket (subpath "$ROOT")) (remote unix-socket (subpath "$ROOT")))
; The process tree cannot write to the original app, core, config, or projects.
(deny file-write*)
(allow file-write* (subpath "$ROOT"))
(allow file-write-data (literal "/dev/null"))
; Native terminal PTYs only: no permissions or device metadata changes.
(allow file-write-data (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))
; Deny personal files, even if a library ignores the synthetic HOME.
(deny file-read* (subpath "$REAL_HOME"))
(allow file-read* (literal "$NODE_RUNTIME") (subpath "$REAL_HOME/Applications/Herdr.app") (subpath "$CORE_ROOT"))
EOF
  printf 'Prepared %s\n' "$ROOT"
  ;;
preflight)
  require_setup
  isolated "$APP" --help >/dev/null
  isolated "$CORE" --help >/dev/null
  # The repo README is deliberately not accessible to the app process tree.
  if isolated /bin/cat "$REPO/README.md" >/dev/null 2>&1; then echo 'Personal-file read isolation failed' >&2; exit 1; fi
  isolated "$NODE_RUNTIME" "$ROOT/isolation-check.mjs" "$ROOT"
  echo 'Executable/profile and personal-file read isolation checks passed. GUI not started.'
  ;;
check)
  require_setup
  isolated "$APP" check "$ROOT/app/mods/${2:-relevo}"
  ;;
launch)
  require_setup
  if test -f "$ROOT/launcher.pid" && kill -0 "$(cat "$ROOT/launcher.pid")" 2>/dev/null; then
    echo 'Preview launcher is already alive; use status. No process was touched.' >&2; exit 1
  fi
  /usr/bin/nohup /bin/bash "$REPO/scripts/preview-herdr.sh" run > "$ROOT/app.log" 2>&1 < /dev/null &
  echo "$!" > "$ROOT/launcher.pid"
  echo "Preview launcher started. Log: $ROOT/app.log"
  ;;
run)
  require_setup
  isolated "$APP"
  ;;
seed)
  require_setup
  isolated "$APP" status >/dev/null
  isolated "$NODE_RUNTIME" "$ROOT/preview-seed.mjs" "$ROOT" "$APP" "$CORE"
  ;;
close)
  require_setup
  isolated "$APP" do app.quit
  ;;
status)
  require_setup; isolated "$APP" status
  ;;
shot)
  require_setup
  # Deliberately cannot write screenshots outside the isolated tree.
  isolated "$APP" shot "$ROOT/relevo-preview.png"
  ;;
stop)
  require_setup
  # App control is selected by the dedicated app-home Unix socket. Never kill by name/PID.
  isolated "$APP" do app.quit
  isolated "$CORE" server stop
  echo 'Requested graceful stop of preview app and preview core only. Scratch files retained.'
  ;;
*)
  echo 'Usage: scripts/preview-herdr.sh {setup|preflight|check [mod]|launch|seed|status|shot|stop}'
  echo 'No production configuration is copied. Network is denied. Scratch data is retained.'
  ;;
esac
