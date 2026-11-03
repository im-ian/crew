// Layers Escape already closes. While one is open, macOS must not also
// leave fullscreen. A new sheet joins this list.
export const ESCAPE_LAYERS = [
  ".modal.open",
  ".overlay.open",
  ".img-preview",
  ".peek-room",
  ".ctx.open",
  ".mention-menu",
  "[data-popover-open]",
  "html.rail-dragging",
  ".composer-box.has-reply",
] as const;

export function escapeLayerSelector(): string {
  return ESCAPE_LAYERS.join(", ");
}

export function escapeLayerOpen(root: { querySelector(selector: string): unknown }): boolean {
  return root.querySelector(escapeLayerSelector()) != null;
}
