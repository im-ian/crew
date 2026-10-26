#!/usr/bin/env bash
# Build Crew from this checkout and install the release binary.
# The prebuilt app installer is scripts/install-macos.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: this setup only supports macOS" >&2
  exit 1
fi

bin_dir="${CREW_BIN_DIR:-$HOME/.local/bin}"
case "$bin_dir" in
  ""|[!/]*|/|//*|*/|*//*|*/.|*/..|*/./*|*/../*|*$'\n'*|*$'\r'*)
    echo "error: CREW_BIN_DIR must be a normalized absolute directory other than /" >&2
    exit 1
    ;;
esac

if ! xcode-select -p >/dev/null 2>&1; then
  echo "Xcode Command Line Tools are not installed."
  echo "Finish the installer dialog, then run this script again."
  xcode-select --install || true
  exit 1
fi

if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust..."
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --show-error --silent --location \
    https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js..."
    brew install node
  else
    echo "error: Node.js 20+ is required. Install it from https://nodejs.org or Homebrew, then run this script again." >&2
    exit 1
  fi
fi

node_version="$(node -v)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
if [[ ! "$node_major" =~ ^[0-9]+$ || "$node_major" -lt 20 ]]; then
  echo "error: Node.js 20+ is required (found ${node_version})" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required and ships with Node.js 20+" >&2
  exit 1
fi

echo "Building Crew..."
cargo build --release --locked -p crew

artifact="${CARGO_TARGET_DIR:-$root/target}/release/crew"
if [[ ! -f "$artifact" ]]; then
  echo "error: release binary not found at $artifact" >&2
  exit 1
fi
mkdir -p "$bin_dir"
if [[ -L "$bin_dir/crew" ]]; then
  echo "note: replacing the existing symlink at $bin_dir/crew"
fi
install -m 755 "$artifact" "$bin_dir/crew"
echo "Installed $bin_dir/crew"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "note: add $bin_dir to PATH, then open a new shell" ;;
esac

cli_on_path() {
  local name="$1"
  local dir
  if command -v "$name" >/dev/null 2>&1; then
    return 0
  fi
  for dir in "$HOME/.grok/bin" "$HOME/.local/bin" "$HOME/.cargo/bin" /opt/homebrew/bin /usr/local/bin; do
    if [[ -x "$dir/$name" ]]; then
      return 0
    fi
  done
  return 1
}

missing=()
for cmd in grok claude codex agy gemini copilot opencode; do
  if ! cli_on_path "$cmd"; then
    missing+=("$cmd")
  fi
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "note: these agent CLIs were not found (install only the ones you use): ${missing[*]}"
fi

echo "Run: crew"
echo "Stop the background daemon with: crew stop"
