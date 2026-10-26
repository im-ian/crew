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

cargo_env="${CARGO_HOME:-$HOME/.cargo}/env"
if ! command -v cargo >/dev/null 2>&1 && [[ -f "$cargo_env" ]]; then
  # shellcheck disable=SC1090
  source "$cargo_env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Installing Rust..."
  if [[ ! -x /usr/bin/curl ]]; then
    echo "error: /usr/bin/curl is required to install Rust" >&2
    exit 1
  fi
  /usr/bin/curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --show-error --silent --location \
    --connect-timeout 15 --max-time 60 --max-filesize 2097152 \
    https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  if [[ ! -f "$cargo_env" ]]; then
    echo "error: Rust installed but ${cargo_env} is missing" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$cargo_env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo is not on PATH" >&2
  exit 1
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
artifact="$(
  cargo build --release --locked -p crew --message-format=json | node -e '
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { buf += chunk; });
process.stdin.on("end", () => {
  let found = "";
  for (const line of buf.split("\n")) {
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.reason !== "compiler-artifact") continue;
    const target = msg.target || {};
    const kinds = target.kind || [];
    if (target.name !== "crew" || !kinds.includes("bin")) continue;
    if (typeof msg.executable === "string" && msg.executable) found = msg.executable;
  }
  if (!found) {
    console.error("error: cargo did not report a crew executable");
    process.exit(1);
  }
  process.stdout.write(found);
});
'
)"
if [[ -z "$artifact" || ! -f "$artifact" ]]; then
  echo "error: release binary not found at ${artifact:-unknown path}" >&2
  exit 1
fi
mkdir -p "$bin_dir"
if [[ -L "$bin_dir/crew" ]]; then
  echo "note: replacing the existing symlink at $bin_dir/crew"
fi
install -m 755 "$artifact" "$bin_dir/crew"
echo "Installed $bin_dir/crew"

hash -r
resolved="$(command -v crew 2>/dev/null || true)"
if [[ -n "$resolved" && "$resolved" != "$bin_dir/crew" ]]; then
  echo "note: \`crew\` on PATH is $resolved, not $bin_dir/crew"
fi
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
