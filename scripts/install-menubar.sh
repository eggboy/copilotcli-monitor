#!/usr/bin/env bash
# Install the Copilot CLI menu bar monitor into SwiftBar or xbar.
#
# What it does:
#   1. Detects SwiftBar or xbar (or offers to install SwiftBar)
#   2. Symlinks the plugin wrapper into the plugins directory
#   3. Makes scripts executable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
PLUGIN_SCRIPT="${SCRIPT_DIR}/copilot-monitor.5s.sh"
HELPER_SCRIPT="${SCRIPT_DIR}/copilot-menubar.ts"

function usage() {
  cat <<EOF
Usage: $(basename "${0}") [-h|--help]

Install the Copilot CLI menu bar monitor into SwiftBar or xbar.

Options:
  -h, --help  Show this help message and exit

Examples:
  ./install-menubar.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

# Cleanup on interruption: remove partial symlink if created
LINK_TARGET=""
trap 'if [[ -n "${LINK_TARGET}" && -L "${LINK_TARGET}" ]]; then rm -f "${LINK_TARGET}"; echo "Interrupted — removed partial symlink" >&2; fi' INT TERM

echo "🔍 Looking for SwiftBar or xbar..."

PLUGINS_DIR=""

# Check SwiftBar first (preferred)
if [[ -d "/Applications/SwiftBar.app" ]]; then
  # SwiftBar stores plugin dir in its preferences
  PREF_DIR=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)
  if [[ -n "${PREF_DIR}" && -d "${PREF_DIR}" ]]; then
    PLUGINS_DIR="${PREF_DIR}"
  else
    PLUGINS_DIR="${HOME}/Library/Application Support/SwiftBar/Plugins"
  fi
  echo "✅ Found SwiftBar — plugins dir: ${PLUGINS_DIR}"
elif [[ -d "/Applications/xbar.app" ]]; then
  PLUGINS_DIR="${HOME}/Library/Application Support/xbar/plugins"
  echo "✅ Found xbar — plugins dir: ${PLUGINS_DIR}"
else
  echo "⚠️  Neither SwiftBar nor xbar is installed." >&2
  echo "" >&2
  read -rp "Install SwiftBar via Homebrew? [Y/n] " answer
  if [[ "${answer:-Y}" =~ ^[Yy]$ ]]; then
    echo "📦 Installing SwiftBar..."
    brew install --cask swiftbar
    PLUGINS_DIR="${HOME}/Library/Application Support/SwiftBar/Plugins"
    echo "✅ SwiftBar installed"
    echo ""
    echo "⚠️  Please launch SwiftBar and set the plugin directory when prompted." >&2
    echo "   Recommended: ${PLUGINS_DIR}" >&2
    echo "" >&2
    read -rp "Press Enter once SwiftBar is configured, or Ctrl+C to abort..."
  else
    echo "❌ Aborted. Install SwiftBar or xbar manually, then re-run this script." >&2
    exit 1
  fi
fi

# Check for a TypeScript runtime
if ! command -v bun &>/dev/null && ! command -v tsx &>/dev/null && ! command -v npx &>/dev/null; then
  echo "⚠️  No TypeScript runtime found (bun, tsx, or npx)." >&2
  echo "   The plugin requires one to run. Install bun:" >&2
  echo "   brew install oven-sh/bun/bun" >&2
fi

# Create plugins dir if needed
mkdir -p "${PLUGINS_DIR}"

# Symlink the plugin script
LINK_TARGET="${PLUGINS_DIR}/copilot-monitor.5s.sh"
if [[ -L "${LINK_TARGET}" || -f "${LINK_TARGET}" ]]; then
  echo "♻️  Replacing existing plugin at ${LINK_TARGET}"
  rm -f "${LINK_TARGET}"
fi

ln -s "${PLUGIN_SCRIPT}" "${LINK_TARGET}"
echo "🔗 Symlinked plugin → ${LINK_TARGET}"

# Remove stale helper symlink if present (SwiftBar treats it as a separate plugin)
HELPER_LINK="${PLUGINS_DIR}/copilot-menubar.ts"
if [[ -L "${HELPER_LINK}" || -f "${HELPER_LINK}" ]]; then
  rm -f "${HELPER_LINK}"
  echo "🧹 Removed stale helper symlink (the wrapper resolves it via readlink)"
fi

# Ensure scripts are executable
chmod +x "${PLUGIN_SCRIPT}" "${HELPER_SCRIPT}"
echo "🔑 Made scripts executable"

echo ""
echo "✅ Installation complete!"
echo ""
echo "   The Copilot CLI monitor should appear in your menu bar within 5 seconds."
echo "   If SwiftBar/xbar isn't running, launch it from /Applications."
echo ""
echo "   To uninstall: rm '${LINK_TARGET}'"
