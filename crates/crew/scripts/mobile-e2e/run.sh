#!/bin/sh
# The phone E2E: a real daemon and its web server in a throwaway CREW_HOME,
# a stand-in bot, and the built UI, driven by headless WebKit as an iPhone 13.
# Nothing opens a window. Screenshots and results.json land in the folder it
# prints. See docs/mobile.md.
#
#   crates/crew/scripts/mobile-e2e/run.sh
#
# Needs: a debug build (`cargo build`), the UI built (`npm run build` in
# crates/crew/ui), node, and playwright-core with its WebKit
# (`npx playwright install webkit`). NODE_PATH may point at a
# playwright-core install; PW_WEBKIT at a WebKit binary.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
CRATE=$(cd "$HERE/../.." && pwd)
CREW_BIN=${CREW_BIN:-$(cd "$CRATE" && cargo metadata --format-version 1 --no-deps -q \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')/debug/crew}
DIST=${CREW_WEB_DIST:-$CRATE/ui/dist}
PORT=${E2E_PORT:-47899}
[ -x "$CREW_BIN" ] || { echo "no crew binary at $CREW_BIN: cargo build first" >&2; exit 1; }
[ -f "$DIST/index.html" ] || { echo "no built UI at $DIST: npm run build in crates/crew/ui" >&2; exit 1; }

E2E_DIR=$(mktemp -d /tmp/crew-mobile-e2e.XXXXXX)
export E2E_DIR E2E_PORT="$PORT"
mkdir -p "$E2E_DIR/bin" "$E2E_DIR/home" "$E2E_DIR/fixtures"
ln -s "$CREW_BIN" "$E2E_DIR/bin/crew"
cp "$HERE/fake-bot.sh" "$E2E_DIR/bin/fake-bot.sh"
cp -R "$DIST" "$E2E_DIR/dist"

# One bot that answers what it was sent, and asks a card on "카드", and one
# with a long chat written over the last five hours.
cat > "$E2E_DIR/home/agents.json" <<JSON
{"agents":[{"id":"bot-echo","name":"에코","cmd":["$E2E_DIR/bin/fake-bot.sh"],"cwd":"$E2E_DIR/work","headless":true,"routines":[]},
{"id":"bot-long","name":"긴대화","cmd":["$E2E_DIR/bin/fake-bot.sh"],"cwd":"$E2E_DIR/work","headless":true,"routines":[]}]}
JSON
mkdir -p "$E2E_DIR/home/transcripts"
python3 - "$E2E_DIR/home/transcripts/bot-long.jsonl" <<'PY'
import json, sys, time
now = int(time.time() * 1000)
with open(sys.argv[1], "w") as f:
    for i in range(300):
        ts, mine = now - (300 - i) * 60000, i % 2 == 0
        text = f"{i}번째 줄. " + "줄이 두세 줄로 접히게 조금 더 써요. " * (1 + i % 3)
        f.write(json.dumps({"id": f"{ts}-{i}", "role": "user" if mine else "assistant", "from": "user" if mine else "bot-long", "text": text, "ts": ts}, ensure_ascii=False) + "\n")
PY
# Loopback only: the throwaway daemon is not reached over Tailscale.
echo "{\"enabled\":true,\"port\":$PORT,\"loopback\":true}" > "$E2E_DIR/home/mobile.json"
# The laptop's display settings the phone should follow.
echo '{"font":"","codeFont":"","fontSize":"large"}' > "$E2E_DIR/home/display.json"
printf '대호' > "$E2E_DIR/home/user-name"
python3 - "$E2E_DIR/fixtures/photo.png" <<'PY'
import struct, sys, zlib
w, h = 64, 48
raw = b"".join(b"\x00" + bytes(c for x in range(w) for c in (x * 4 % 256, y * 5 % 256, 160)) for y in range(h))
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
PY

stop() { CREW_HOME="$E2E_DIR/home" "$E2E_DIR/bin/crew" stop >/dev/null 2>&1 || true; }
trap stop EXIT
"$HERE/start-daemon.sh" >>"$E2E_DIR/daemon.log" 2>&1 &
i=0
until curl -s -o /dev/null "http://127.0.0.1:$PORT/"; do
  i=$((i + 1)); [ $i -gt 50 ] && { echo "the daemon did not come up; see $E2E_DIR/daemon.log" >&2; exit 1; }
  sleep 0.2
done
echo "E2E folder: $E2E_DIR"
node "$HERE/e2e.cjs"
