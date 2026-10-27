// A press on the dimmed area around a dialog.
export type BackdropPress = {
  onBackdrop: boolean;
  /** The press is on a native select, which opens its menu. */
  onSelect: boolean;
  popoverOpen: boolean;
  /** That select menu is already open. */
  selectMenuOpen: boolean;
};

/** What the dimmed layer should do with this press. */
export type BackdropResult = "close" | "keep" | "arm" | "ignore";

/** An open picker or native menu takes the outside press. The dialog stays. */
export function backdropPress(state: BackdropPress): BackdropResult {
  if (state.onSelect) return "arm";
  if (!state.onBackdrop) return "ignore";
  if (state.popoverOpen || state.selectMenuOpen) return "keep";
  return "close";
}

function opensNativeSelect(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("select")) return true;
  const id = target.closest("label")?.getAttribute("for");
  if (!id) return false;
  return root.querySelector("#" + CSS.escape(id)) instanceof HTMLSelectElement;
}

// The menu's dismissing press would otherwise land on whatever sits under it.
function swallowFollowingClick(root: HTMLElement): void {
  const stop = (ev: Event) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  root.addEventListener("click", stop, true);
  window.setTimeout(() => root.removeEventListener("click", stop, true), 0);
}

export function handleBackdropPointerDown(
  e: { target: EventTarget | null; currentTarget: EventTarget & HTMLElement },
  onClose: () => void,
): void {
  const root = e.currentTarget;
  const selectMenuOpen = root.dataset.selectOpen === "1";
  const result = backdropPress({
    onBackdrop: e.target === root,
    onSelect: opensNativeSelect(e.target, root),
    popoverOpen: root.querySelector("[data-popover-open]") != null,
    selectMenuOpen,
  });
  if (result === "arm") {
    root.dataset.selectOpen = "1";
    return;
  }
  if (selectMenuOpen || result === "keep") swallowFollowingClick(root);
  if (result === "close") onClose();
  else delete root.dataset.selectOpen;
}

/** The menu closes on blur before the press that dismissed it is handled. */
export function rememberSelectClose(root: HTMLElement, target: EventTarget | null): void {
  if (!(target instanceof HTMLSelectElement)) return;
  window.setTimeout(() => {
    delete root.dataset.selectOpen;
  }, 0);
}
