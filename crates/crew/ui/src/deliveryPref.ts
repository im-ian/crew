const KEY = "crew.delivery";

/** How a message leaves the composer while a bot is working. */
export type Delivery = "queue" | "interrupt";

/** Missing or unknown values stay on the queue. Interrupt is opt-in. */
export function deliveryFrom(stored: string | null): Delivery {
  return stored === "interrupt" ? "interrupt" : "queue";
}

export function loadDelivery(): Delivery {
  try {
    return deliveryFrom(localStorage.getItem(KEY));
  } catch {
    return "queue";
  }
}

export function saveDelivery(mode: Delivery) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* private mode */
  }
}

/**
 * A normal send waits, unless the setting says to cut in.
 * The steer shortcut cuts in either way. Neither applies once the bot is idle.
 */
export function sendSteers(
  shortcut: boolean,
  mode: Delivery,
  canSteer: boolean,
): boolean {
  return canSteer && (shortcut || mode === "interrupt");
}
