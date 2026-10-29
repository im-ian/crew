import type { ChoiceOption } from "./types";

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
