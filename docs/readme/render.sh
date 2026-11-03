#!/bin/sh
# Rebuild README art. The three screens are the real app on demo data
# (crates/crew/ui/src/readme.tsx), served by Vite on 127.0.0.1:1430.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
UI="$PWD/../../crates/crew/ui"

for face in face-circle face-triangle face-cloud face-square face-teardrop; do
  rsvg-convert -w 128 "$face.svg" > "$face.png"
done

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1600,720 \
  --screenshot="$PWD/hero.png" "file://$PWD/hero.html"
sips -z 720 1600 hero.png >/dev/null

if ! curl -fs http://127.0.0.1:1430/readme.html >/dev/null; then
  (cd "$UI" && npx vite --port 1430 --strictPort >/dev/null 2>&1) &
  VITE=$!
  trap 'kill $VITE 2>/dev/null' EXIT
  until curl -fs http://127.0.0.1:1430/readme.html >/dev/null; do sleep 0.3; done
fi

TMP=$(mktemp -d)
shot() { # name window-height
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1120,$2 --virtual-time-budget=9000 \
    --screenshot="$TMP/$1.png" "http://127.0.0.1:1430/readme.html?shot=$1"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=1280,$(($2 + 120)) \
    --screenshot="$PWD/$1.png" "file://$PWD/frame.html?img=$TMP/$1.png&h=$2"
}
shot window 740
shot new-bot 740
shot routines 740
rm -r "$TMP"
echo "wrote $PWD/hero.png window.png new-bot.png routines.png"
