import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  assertMatchingReleaseVersions,
  assertReleaseIsNewer,
  compareReleaseTags,
  readRepositoryVersions,
  releaseVersionFromTag,
} from "./validate-release-version.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("releaseVersionFromTag", () => {
  it("accepts stable and prerelease semantic versions", () => {
    assert.equal(releaseVersionFromTag("v1.25.0"), "1.25.0");
    assert.equal(releaseVersionFromTag("v2.0.0-beta.1"), "2.0.0-beta.1");
  });

  it("rejects malformed, newline-bearing, and zero-padded tags", () => {
    for (const tag of [
      "1.25.0",
      "v1.25",
      "v01.25.0",
      "v1.25.0-01",
      "v1.25.0\nextra",
    ]) {
      assert.equal(releaseVersionFromTag(tag), null);
    }
  });
});

describe("assertMatchingReleaseVersions", () => {
  it("requires every shipped manifest to match the tag", () => {
    assert.equal(
      assertMatchingReleaseVersions("v0.1.0", {
        "package.json": "0.1.0",
        "tauri.conf.json": "0.1.0",
        "Cargo.toml": "0.1.0",
      }),
      "0.1.0",
    );

    for (const source of ["package.json", "tauri.conf.json", "Cargo.toml"]) {
      const versions = {
        "package.json": "0.1.0",
        "tauri.conf.json": "0.1.0",
        "Cargo.toml": "0.1.0",
        [source]: "0.0.9",
      };
      assert.throws(
        () => assertMatchingReleaseVersions("v0.1.0", versions),
        new RegExp(source),
      );
    }
  });
});

describe("release ordering", () => {
  it("uses semantic-version precedence", () => {
    assert.equal(compareReleaseTags("v2.0.0", "v1.99.99"), 1);
    assert.equal(compareReleaseTags("v2.0.0", "v2.0.0"), 0);
    assert.equal(compareReleaseTags("v2.0.0-beta.2", "v2.0.0-beta.10"), -1);
    assert.equal(compareReleaseTags("v2.0.0", "v2.0.0-rc.1"), 1);
  });

  it("rejects stable latest-pointer rollback or replay", () => {
    assert.throws(
      () => assertReleaseIsNewer("v0.0.9", "v0.1.0"),
      /not newer/,
    );
    assert.throws(
      () => assertReleaseIsNewer("v0.1.0", "v0.1.0"),
      /not newer/,
    );
  });
});

describe("readRepositoryVersions", () => {
  it("reads the workspace Cargo version and nested Tauri/UI manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-release-version-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "crates/crew/ui"), { recursive: true });
    writeFileSync(
      join(root, "Cargo.toml"),
      '[workspace]\nmembers = ["crates/crew"]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n',
    );
    writeFileSync(
      join(root, "crates/crew/tauri.conf.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    writeFileSync(
      join(root, "crates/crew/ui/package.json"),
      JSON.stringify({ version: "0.1.0" }),
    );

    assert.deepEqual(readRepositoryVersions(root), {
      "crates/crew/ui/package.json": "0.1.0",
      "crates/crew/tauri.conf.json": "0.1.0",
      "Cargo.toml": "0.1.0",
    });
  });
});
