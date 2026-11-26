#!/usr/bin/env node
// Whether a release is signed with an Apple Developer ID and notarized.
//
// All of the secrets below set: signed and notarized. None: an ad-hoc build,
// as before. Some but not all: the release stops and names the missing ones,
// so a half-set key never ships an ad-hoc build by mistake.
//
//   node scripts/macos-signing.mjs check   # prints `signed` or `unsigned`
//
// It reads only whether each variable is empty; no value is printed.

import { fileURLToPath } from "node:url";

export const SIGNING_SECRETS = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_P8",
];

/** `signed`, `unsigned`, or an error naming the secrets still missing. */
export function signingMode(env) {
  const set = SIGNING_SECRETS.filter((name) => (env[name] ?? "").trim() !== "");
  if (set.length === 0) return "unsigned";
  if (set.length === SIGNING_SECRETS.length) return "signed";
  const missing = SIGNING_SECRETS.filter((name) => !set.includes(name));
  throw new Error(
    `macOS signing is half set up: ${set.join(", ")} set, but ${missing.join(", ")} missing. ` +
      "Set all of them to sign and notarize, or none to build ad-hoc.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command] = process.argv.slice(2);
  if (command !== "check") {
    console.error("usage: macos-signing.mjs check");
    process.exit(2);
  }
  try {
    console.log(signingMode(process.env));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
