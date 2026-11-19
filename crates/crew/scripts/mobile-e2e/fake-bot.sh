#!/bin/sh
# A stand-in bot for the phone E2E: answers the last line it was sent.
for a; do last=$a; done
line=$(printf '%s\n' "$last" | tail -n 1)
case "$line" in
  *카드*)
    ans=$(crew ask --question "어느 쪽으로 할까요?" --option "왼쪽" --option "오른쪽")
    echo "고른 것: $ans" ;;
  *) echo "받았어요: $line" ;;
esac
