const NEW_START = /[가-힣ㄱ-ㅎㅏ-ㅣA-Z*`#「“"'‘-]/;

function isSentenceEnd(ch: string): boolean {
  return ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "…";
}

function isNewStart(ch: string): boolean {
  return NEW_START.test(ch);
}

function lastContentChar(text: string, end: number): string {
  let j = end - 1;
  while (j >= 0 && (text[j] === "*" || text[j] === "`")) j -= 1;
  return j >= 0 ? text[j] : "";
}

/** A table row's cells are not sentences, and a split inside one breaks the table. */
function inTableRow(text: string, i: number): boolean {
  return text.slice(text.lastIndexOf("\n", i - 1) + 1, i).trimStart().startsWith("|");
}

function maybeSplitAfterMarkup(
  text: string,
  i: number,
  markLen: number,
  flush: (end: number, next: number) => void,
) {
  const last = text[i - markLen - 1];
  if (!isSentenceEnd(last) || inTableRow(text, i)) return;
  const next = text[i];
  if (next && next !== " " && next !== "\n" && (isNewStart(next) || next === "*")) {
    flush(i, i);
  }
}

/** A fenced block is the answer to the line above it, so they share a balloon. */
function fenceFollows(text: string, i: number): boolean {
  let j = i;
  while (text[j] === "\n") j += 1;
  return text.startsWith("```", j);
}

/** Split one assistant turn into chat balloons (blank lines, or glued sentences). */
export function splitBubbles(text: string): string[] {
  if (!text) return [];
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  let fence = false;
  let bold = false;
  let code = false;

  const flush = (end: number, next: number) => {
    const piece = text.slice(start, end).trim();
    if (piece) parts.push(piece);
    start = next;
  };

  while (i < text.length) {
    if (!code && text.startsWith("```", i)) {
      fence = !fence;
      i += 3;
      continue;
    }
    if (fence) {
      i += 1;
      continue;
    }
    if (text[i] === "`") {
      const closing = code;
      code = !code;
      i += 1;
      if (closing) maybeSplitAfterMarkup(text, i, 1, flush);
      continue;
    }
    if (!code && text.startsWith("**", i)) {
      const closing = bold;
      bold = !bold;
      i += 2;
      if (closing) maybeSplitAfterMarkup(text, i, 2, flush);
      continue;
    }
    if (!code && !bold && text[i] === "\n" && text[i + 1] === "\n") {
      if (fenceFollows(text, i)) {
        i += 1;
        continue;
      }
      flush(i, i);
      while (text[i] === "\n") i += 1;
      start = i;
      continue;
    }
    // Only a sentence glued to the next with no space is two messages run
    // together; sentences in one paragraph are one thought and share a balloon.
    if (!code && !bold && isSentenceEnd(text[i]) && !inTableRow(text, i)) {
      const next = text[i + 1];
      const prev = lastContentChar(text, i);
      const afterHangul = /[가-힣]/.test(prev);
      if (
        next &&
        (isNewStart(next) || (afterHangul && /[a-z*]/.test(next)))
      ) {
        flush(i + 1, i + 1);
      }
    }
    i += 1;
  }
  const rest = text.slice(start).trim();
  if (rest) parts.push(rest);
  return parts;
}
