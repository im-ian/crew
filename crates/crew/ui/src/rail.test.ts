import { describe, expect, it } from "vitest";
import { numberDuplicateNames, type Named } from "./rail";

function items(...triples: Array<[string, string, string?]>): Named[] {
  return triples.map(([id, name, kind = "agent"]) => ({ id, name, kind }));
}

describe("numberDuplicateNames", () => {
  it("leaves a name that appears once alone", () => {
    const list = items(["bot", "춘식이"], ["bot-2", "죠르디"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([undefined, undefined]);
  });

  it("numbers every row of a repeated name, not just the later ones", () => {
    const list = items(["bot", "춘식이"], ["bot-2", "춘식이"], ["bot-3", "죠르디"]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([1, 2, undefined]);
  });

  it("orders ids the way they were minted, not the way they sort as text", () => {
    // The real shape: `slug_id` sends every name without ASCII to `bot`, so a
    // roster reads bot, bot-2 … bot-10. A plain compare puts bot-10 second.
    const list = items(
      ["bot", "춘식이"],
      ["bot-2", "춘식이"],
      ["bot-9", "춘식이"],
      ["bot-10", "춘식이"],
    );
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it("does not renumber the rows on screen when one is added", () => {
    const before = items(["bot", "춘식이"], ["bot-2", "춘식이"], ["bot-9", "춘식이"]);
    numberDuplicateNames(before);
    const after = items(
      ["bot", "춘식이"],
      ["bot-2", "춘식이"],
      ["bot-9", "춘식이"],
      ["bot-10", "춘식이"],
    );
    numberDuplicateNames(after);
    expect(after.slice(0, 3).map((i) => i.ordinal)).toEqual(
      before.map((i) => i.ordinal),
    );
  });

  it("numbers rooms and bots in one space, so no two rows read alike", () => {
    const list = items(
      ["room-a", "출시", "channel"],
      ["room-b", "출시", "channel"],
      ["bot-a", "출시", "agent"],
      ["bot-b", "출시", "agent"],
    );
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal).sort()).toEqual([1, 2, 3, 4]);
  });

  it("groups a name spelled NFD with the same name spelled NFC", () => {
    const list = items(["bot", "춘식이"], ["bot-2", "춘식이".normalize("NFD")]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it("groups a name that differs only by trailing space", () => {
    const list = items(["bot", "춘식이"], ["bot-2", "춘식이 "]);
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it("clears the number when a name stops repeating", () => {
    const list = items(["bot", "춘식이"], ["bot-2", "춘식이"]);
    numberDuplicateNames(list);
    list[1].name = "죠르디";
    numberDuplicateNames(list);
    expect(list.map((i) => i.ordinal)).toEqual([undefined, undefined]);
  });
});
