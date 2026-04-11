#!/usr/bin/env bash
# <xbar.title>Copilot CLI Monitor</xbar.title>
# <xbar.desc>Real-time monitoring of GitHub Copilot CLI sessions</xbar.desc>
# <xbar.author>eggboy</xbar.author>
# <xbar.var>string(COPILOT_MENUBAR_SCRIPT="${HOME}/scripts/copilot-menubar.ts"): Path to the helper script</xbar.var>

# SwiftBar/xbar plugin wrapper — delegates to the bun/tsx helper script.
# Filename convention: copilot-monitor.5s.sh → refreshes every 5 seconds.

set -euo pipefail

# SwiftBar/xbar launches with a minimal PATH that excludes Homebrew.
# Add common install locations so bun/node/npx are found.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.bun/bin:${HOME}/.local/bin:${PATH}"

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"

# Resolve symlinks to find the real script directory
REAL_SCRIPT="${0}"
if [[ -L "${REAL_SCRIPT}" ]]; then
  REAL_SCRIPT="$(readlink "${0}")"
  # Handle relative symlinks
  [[ "${REAL_SCRIPT}" != /* ]] && REAL_SCRIPT="${SCRIPT_DIR}/${REAL_SCRIPT}"
fi
REAL_DIR="$(cd "$(dirname "${REAL_SCRIPT}")" && pwd)"

# Resolve helper script: try real dir first, then sibling, then env var
HELPER="${REAL_DIR}/copilot-menubar.ts"
if [[ ! -f "${HELPER}" ]]; then
  HELPER="${SCRIPT_DIR}/copilot-menubar.ts"
fi
if [[ ! -f "${HELPER}" ]]; then
  HELPER="${COPILOT_MENUBAR_SCRIPT:-}"
fi

if [[ -z "${HELPER}" || ! -f "${HELPER}" ]]; then
  # Exit 0 intentionally — non-zero causes SwiftBar to show an error badge
  echo "⚪ | size=14"
  echo "---"
  echo "❌ Helper script not found | color=red"
  echo "Expected: ${SCRIPT_DIR}/copilot-menubar.ts | size=11 color=#888888"
  exit 0
fi

# Try runtimes in order: bun > tsx > npx tsx
if command -v bun &>/dev/null; then
  exec bun run "${HELPER}"
elif command -v tsx &>/dev/null; then
  exec tsx "${HELPER}"
elif command -v npx &>/dev/null; then
  exec npx --yes tsx "${HELPER}" 2>/dev/null
else
  # Exit 0 intentionally — non-zero causes SwiftBar to show an error badge
  echo "⚪ | size=14"
  echo "---"
  echo "❌ No TypeScript runtime found | color=red"
  echo "Install one of: bun, tsx, or Node.js | size=11 color=#888888"
  echo "---"
  echo "brew install oven-sh/bun/bun | bash='brew install oven-sh/bun/bun' terminal=true"
  exit 0
fi
