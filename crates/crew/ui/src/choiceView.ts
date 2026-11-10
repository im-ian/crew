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

/** What a card holds while it waits: every pick, field and typed answer, and the question in front. */
export type ChoiceDraft = {
  picks: string[][];
  values: string[][];
  others: string[];
  step: number;
};

/** The card as the bot sent it, before the user touched anything. */
export function blankDraft(questions: ChoiceQuestion[]): ChoiceDraft {
  return {
    picks: questions.map((q) => q.selected || []),
    values: questions.map((q) => (q.fields || []).map((f) => f.value || "")),
    others: questions.map((q) => q.other || ""),
    step: 0,
  };
}

/** Whether the answers differ from the blank card. The step alone is not an answer. */
export function draftTouched(questions: ChoiceQuestion[], draft: ChoiceDraft): boolean {
  const blank = blankDraft(questions);
  const same = (a: string[] = [], b: string[] = []) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return questions.some(
    (_, i) =>
      !same(draft.picks[i], blank.picks[i]) ||
      !same(draft.values[i], blank.values[i]) ||
      (draft.others[i] || "") !== blank.others[i],
  );
}

// Leaving the chat unmounts the card, so its draft waits here by card id.
// Memory only: a field can be a secret, and nothing typed should reach disk.
const drafts = new Map<string, ChoiceDraft>();

export function readChoiceDraft(id: string): ChoiceDraft | undefined {
  return drafts.get(id);
}

export function keepChoiceDraft(id: string, questions: ChoiceQuestion[], draft: ChoiceDraft) {
  if (draft.step === 0 && !draftTouched(questions, draft)) drafts.delete(id);
  else drafts.set(id, draft);
}

export function dropChoiceDraft(id: string) {
  drafts.delete(id);
}

/** Two options are one click each, so "select all" only shows from three up. */
export function offersSelectAll(q: ChoiceQuestion): boolean {
  return !!q.multi && (q.options || []).length > 2;
}

/** Whether every option of the question is picked. */
export function allPicked(options: ChoiceOption[], row: string[] = []): boolean {
  return options.length > 0 && options.every((o) => row.includes(o.id));
}

/**
 * The picks after "select all": every option in their order, or none once
 * all are already on. A typed "other" answer is not an option, so it stays.
 */
export function toggleAll(options: ChoiceOption[], row: string[] = []): string[] {
  return allPicked(options, row) ? [] : options.map((o) => o.id);
}

/**
 * A question card's answer goes on to the bot as the user's line. Once it has
 * gone, the answered card says it, so the line is not drawn too. While it
 * waits for a busy bot, it shows, so it can still be taken back.
 */
export function answerLineHidden(m: { answer?: boolean; queued?: boolean }): boolean {
  return !!m.answer && !m.queued;
}
