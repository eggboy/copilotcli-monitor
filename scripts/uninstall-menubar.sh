#!/usr/bin/env bash
# Uninstall the Copilot CLI menu bar monitor from SwiftBar or xbar.

set -euo pipefail

PLUGIN_NAME="copilot-monitor.5s.sh"
HELPER_NAME="copilot-menubar.ts"  # legacy: clean up if present

function usage() {
  cat <<EOF
Usage: $(basename "${0}") [-h|--help]

Uninstall the Copilot CLI menu bar monitor from SwiftBar or xbar.
Removes symlinks from the plugins directory. Source files are left untouched.

Options:
  -h, --help  Show this help message and exit

Examples:
  ./uninstall-menubar.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

trap 'echo "Interrupted" >&2' INT TERM

echo "🔍 Looking for installed plugin..."

FOUND=0

for DIR in \
  "$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)" \
  "${HOME}/Library/Application Support/SwiftBar/Plugins" \
  "${HOME}/Library/Application Support/xbar/plugins"; do

  [[ -z "${DIR}" ]] && continue
  TARGET="${DIR}/${PLUGIN_NAME}"
  HELPER_TARGET="${DIR}/${HELPER_NAME}"

  if [[ -L "${TARGET}" || -f "${TARGET}" ]]; then
    rm -f "${TARGET}"
    echo "✅ Removed ${TARGET}"
    FOUND=1
  fi
  if [[ -L "${HELPER_TARGET}" || -f "${HELPER_TARGET}" ]]; then
    rm -f "${HELPER_TARGET}"
    echo "✅ Removed ${HELPER_TARGET}"
    FOUND=1
  fi
done

if [[ "${FOUND}" -eq 0 ]]; then
  echo "⚠️  Plugin not found in any known SwiftBar/xbar plugins directory." >&2
  echo "   If you installed it elsewhere, remove the file manually:" >&2
  echo "   rm /path/to/plugins/${PLUGIN_NAME}" >&2
  exit 1
else
  echo ""
  echo "✅ Uninstall complete. The menu bar item will disappear shortly."
fi
