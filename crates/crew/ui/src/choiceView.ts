import type { ChoiceOption, ChoiceQuestion } from "./types";

export function shortLabels(options: ChoiceOption[]): boolean {
  return options.every((o) => (o.label || "").trim().length <= 3);
}

export function optionView(o: ChoiceOption, i: number, short: boolean) {
  const label = (o.label || "").trim() || String.fromCharCode(65 + i);
  const desc = (o.description || "").trim();
  const badge = short ? label : String.fromCharCode(65 + (i % 26));
  const title = short ? desc : label;
  const sub = !short && desc && desc !== label ? desc : null;
  return { badge, title, sub };
}

// The answered row is not rendered at its place in the question, so the badge uses that place.
export function answeredOptionView(options: ChoiceOption[], option: ChoiceOption) {
  const i = options.findIndex((item) => item.id === option.id);
  return optionView(option, i < 0 ? 0 : i, shortLabels(options));
}


// The letter after the options, skipping any a short label already uses as
// its badge, so a typed answer never looks like one of the options.
export function otherBadge(options: ChoiceOption[]): string {
  const short = shortLabels(options);
  const taken = new Set(options.map((o, i) => optionView(o, i, short).badge));
  for (let k = 0; k < 26; k++) {
    const letter = String.fromCharCode(65 + ((options.length + k) % 26));
    if (!taken.has(letter)) return letter;
  }
  return "+";
}

/**
 * Whether the user gave this question anything. Nothing is required: a card
 * can go back with questions left blank, and they read as no answer.
 */
export function questionDone(
  q: ChoiceQuestion,
  picks: string[] = [],
  values: string[] = [],
  other = "",
): boolean {
  const picked = (q.options || []).length > 0 && (picks.length > 0 || other.trim() !== "");
  return picked || values.some((v) => v.trim() !== "");
}

/** One question's answer as one line, for the summary card. Secrets stay hidden. */
export function answerSummary(
  q: ChoiceQuestion,
  picks: string[] = [],
  values: string[] = [],
  other = "",
): string {
  const parts = (q.options || [])
    .filter((o) => picks.includes(o.id))
    .map((o) => (o.label || "").trim() || o.id);
  if (other.trim()) parts.push(other.trim());
  (q.fields || []).forEach((f, fi) => {
    const v = (values[fi] || "").trim();
    if (!v) return;
    parts.push(`${f.label}: ${f.secret ? "••••••" : v}`);
  });
  return parts.join(", ");
}
