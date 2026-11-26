import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SIGNING_SECRETS, signingMode } from "./macos-signing.mjs";

const all = Object.fromEntries(SIGNING_SECRETS.map((name) => [name, "value"]));
const script = fileURLToPath(new URL("./macos-signing.mjs", import.meta.url));

describe("signingMode", () => {
  it("builds ad-hoc with no secrets, as before", () => {
    assert.equal(signingMode({}), "unsigned");
    assert.equal(signingMode(Object.fromEntries(SIGNING_SECRETS.map((n) => [n, ""]))), "unsigned");
    // A secret GitHub does not have comes through as an empty string.
    assert.equal(signingMode({ APPLE_CERTIFICATE: "  " }), "unsigned");
  });

  it("signs with every secret", () => {
    assert.equal(signingMode(all), "signed");
  });

  it("stops on some, naming what is missing", () => {
    const some = { ...all, APPLE_API_KEY_P8: "", APPLE_API_ISSUER: "" };
    assert.throws(() => signingMode(some), /APPLE_API_ISSUER, APPLE_API_KEY_P8 missing/);
  });
});

describe("macos-signing.mjs check", () => {
  const run = (env) =>
    execFileSync(process.execPath, [script, "check"], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

  it("prints the mode, never a value", () => {
    assert.equal(run({}).trim(), "unsigned");
    const out = run({ ...all, APPLE_CERTIFICATE_PASSWORD: "hunter2" });
    assert.equal(out.trim(), "signed");
    assert.ok(!out.includes("hunter2"));
  });

  it("fails on a half set", () => {
    assert.throws(() => run({ APPLE_CERTIFICATE: "x" }), (error) => {
      assert.equal(error.status, 1);
      assert.match(String(error.stderr), /half set up/);
      return true;
    });
  });
});
