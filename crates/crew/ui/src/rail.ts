/**
 * Anything the rail lists. `kind` is required so an `AgentInfo` cannot be
 * handed straight in — this writes `ordinal` onto what it is given, and React
 * state is not ours to write to.
 */
export type Named = { id: string; name: string; kind: string; ordinal?: number };

/**
 * macOS passes the same name around in more than one spelling: a Korean name
 * typed on the keyboard is NFC, one that arrived through a path is NFD, and
 * the two render identically. A trailing space likewise.
 */
function nameKey(name: string): string {
  return name.normalize("NFC").trim();
}

/**
 * Two bots may share a name on purpose, and the rail is where that stops being
 * readable — three rows reading 춘식이 with nothing to tell them apart.
 *
 * Only names that repeat are numbered, so the common case stays clean. Rooms
 * and bots share one numbering space; numbering them separately would put two
 * rows reading "출시 1" on screen, which is worse than not numbering at all.
 *
 * Order comes from the id under numeric collation rather than list order, so
 * regrouping or dragging a row does not renumber the others — and `bot-10`
 * lands after `bot-2` instead of between `bot` and it, which is where a plain
 * string compare puts it and where adding an eleventh bot would shift every
 * row after the first under the reader.
 */
export function numberDuplicateNames<T extends Named>(items: T[]): void {
  const byName = new Map<string, T[]>();
  for (const item of items) {
    const key = nameKey(item.name);
    const group = byName.get(key);
    if (group) group.push(item);
    else byName.set(key, [item]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) {
      // "Set only when another item shares this name" has to hold both ways,
      // or a renamed bot keeps a number nothing else answers to.
      for (const item of group) delete item.ordinal;
      continue;
    }
    group
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .forEach((item, i) => {
        item.ordinal = i + 1;
      });
  }
}
