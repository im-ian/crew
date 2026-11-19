/** What the daemon says of mobile access (`mobile_status`). */
export type MobileStatus = {
  enabled: boolean;
  port: number;
  /** Where a phone opens Crew. The MagicDNS name first, when there is one. */
  urls: string[];
  tailnet: { ips: string[]; dns?: string | null; owner?: string | null } | null;
  /** The Tailscale CLI is installed. */
  tailscale: boolean;
  devices: MobileDevice[];
  /** An address Crew could not listen on. */
  error?: string | null;
};

export type MobileDevice = { id: string; name: string; created: number; lastSeen: number };

export type MobilePair = { code: string; expiresIn: number; url: string; qrSvg: string };

/** "3분 12초 남음" style countdown parts from seconds left. */
export function minutesSeconds(left: number): { m: number; s: number } {
  const n = Math.max(0, Math.floor(left));
  return { m: Math.floor(n / 60), s: n % 60 };
}


/** What an address is: the Mac's MagicDNS name, its Tailscale IP, or this Mac only. */
export type AddressKind = "dns" | "ip" | "local";
export type Address = { url: string; kind: AddressKind; /** Shown without the scheme. */ label: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function addressKind(url: string): AddressKind {
  const host = hostOf(url).replace(/^\[|\]$/g, "");
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return "local";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "ip";
  return "dns";
}

/**
 * The address to open on the phone, and the rest: the MagicDNS name first,
 * else the Tailscale IP. A loopback address only opens on this Mac, so it is
 * never the main one and comes last among the others.
 */
export function phoneAddresses(urls: readonly string[]): { main: Address | null; others: Address[] } {
  const all = urls.map((url) => ({ url, kind: addressKind(url), label: url.replace(/^https?:\/\//, "").replace(/\/$/, "") }));
  const main = all.find((a) => a.kind === "dns") ?? all.find((a) => a.kind === "ip") ?? null;
  const rank: Record<AddressKind, number> = { dns: 0, ip: 1, local: 2 };
  const others = all.filter((a) => a !== main).sort((a, b) => rank[a.kind] - rank[b.kind]);
  return { main, others };
}
