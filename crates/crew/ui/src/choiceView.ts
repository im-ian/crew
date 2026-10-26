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

// `picked` is the saved subset. Its own index is 0 for one answer, so the
// letter has to come from the full list, which is also the stored option id.
export function answeredOptionView(options: ChoiceOption[], option: ChoiceOption) {
  const i = options.findIndex((item) => item.id === option.id);
  return optionView(option, i < 0 ? 0 : i, shortLabels(options));
}
