#!/bin/sh
# Installs or updates Relevo in the Herdr app folder. Options: --dry-run, --root <dir>. See scripts/relevo.mjs help.
set -eu
command -v node >/dev/null 2>&1 || { echo "install.sh: needs Node (see .nvmrc)" >&2; exit 1; }
exec node "$(dirname "$0")/scripts/relevo.mjs" install "$@"
