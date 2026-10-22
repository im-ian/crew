const FENCE_OPEN = /^ {0,3}(`{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,})\s*$/;

/** Split one assistant turn into chat balloons, one per paragraph. */
export function splitBubbles(text: string): string[] {
  const parts: string[] = [];
  let lines: string[] = [];
  let fence = "";
  let gap = false;

  const flush = () => {
    const piece = lines.join("\n").trim();
    if (piece) parts.push(piece);
    lines = [];
  };

  for (const line of text.split("\n")) {
    if (fence) {
      // Only a bare run at least as long as the opener closes it, so a
      // ```` block can show a ``` one.
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1].length >= fence.length) fence = "";
    } else if (!line.trim()) {
      gap = true;
    } else {
      const open = FENCE_OPEN.exec(line);
      // A fenced block is the answer to the line above it, so they share a balloon.
      if (gap && !open) flush();
      gap = false;
      if (open) fence = open[1];
    }
    lines.push(line);
  }
  flush();
  return parts;
}
