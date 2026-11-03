import { isTypingTarget } from "./shortcuts";

// The webview's own right click menu offers Reload, and AutoFill for whatever text box has focus.
// Keep it only where it does text work: in a text box, or over selected text to copy it.
export function keepNativeMenu(typing: boolean, selectedText: string): boolean {
  return typing || selectedText.trim() !== "";
}

export function blockNativeMenu(doc: Document): void {
  doc.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    if (keepNativeMenu(isTypingTarget(e.target), doc.getSelection()?.toString() ?? "")) return;
    e.preventDefault();
  });
}
