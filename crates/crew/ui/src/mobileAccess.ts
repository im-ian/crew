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

/** The address to show first: one a phone on the tailnet can reach. */
export function phoneUrl(status: MobileStatus): string | null {
  return status.urls.find((u) => !u.includes("127.0.0.1") && !u.includes("[::1]")) ?? null;
}
