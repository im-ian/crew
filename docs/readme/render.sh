#!/bin/sh
# Rebuild README art: hero.png and window.png from the HTML in this folder.
set -e
cd "$(dirname "$0")"
ROOT="$(cd ../../.. && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for face in face-circle face-triangle face-cloud face-square face-teardrop; do
  rsvg-convert -w 128 "$face.svg" > "$face.png"
done
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1600,720 \
  --screenshot="$PWD/hero.png" "file://$PWD/hero.html"
sips -z 720 1600 hero.png >/dev/null
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,860 \
  --screenshot="$PWD/window.png" "file://$PWD/window.html"
echo "wrote $PWD/hero.png and $PWD/window.png"
