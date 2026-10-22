/** A fenced block is the answer to the line above it, so they share a balloon. */
function fenceFollows(text: string, i: number): boolean {
  let j = i;
  while (text[j] === "\n") j += 1;
  return text.startsWith("```", j);
}

/** Split one assistant turn into chat balloons, one per paragraph. */
export function splitBubbles(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let fence = false;

  const flush = (end: number) => {
    const piece = text.slice(start, end).trim();
    if (piece) parts.push(piece);
  };

  while (i < text.length) {
    if (text.startsWith("```", i)) {
      fence = !fence;
      i += 3;
      continue;
    }
    if (!fence && text[i] === "\n" && text[i + 1] === "\n") {
      if (fenceFollows(text, i)) {
        i += 1;
        continue;
      }
      flush(i);
      while (text[i] === "\n") i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  flush(text.length);
  return parts;
}
