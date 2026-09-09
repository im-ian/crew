/** Anything the rail lists: a bot or a room, with a display name. */
export type Named = { id: string; name: string; kind?: string; ordinal?: number };

/**
 * Two bots may share a name on purpose, and the rail is where that stops being
 * readable — three rows reading 춘식이 with nothing to tell them apart.
 *
 * Only names that repeat within one kind are numbered, so the common case stays
 * clean, and the number follows id order rather than list order, so regrouping
 * or dragging a row does not renumber the others under the reader.
 */
export function numberDuplicateNames<T extends Named>(items: T[]): void {
  const byName = new Map<string, T[]>();
  for (const item of items) {
    // A room and a bot of the same name already read apart by their avatar, so
    // numbering across the two would only add noise to a lone bot.
    const key = `${item.kind ?? ""}\u0000${item.name}`;
    const group = byName.get(key);
    if (group) group.push(item);
    else byName.set(key, [item]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    group
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((item, i) => {
        item.ordinal = i + 1;
      });
  }
}
