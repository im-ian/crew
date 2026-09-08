import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  inspectPublishedArtifacts,
  stageBuildArtifacts,
} from "./release-artifacts.mjs";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "crew-release-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path, contents = "fixture") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("stageBuildArtifacts", () => {
  it("stages exactly one matched updater pair with an architecture suffix", () => {
    const root = temporaryDirectory();
    const bundle = join(root, "bundle");
    const output = join(root, "staged");
    write(join(bundle, "dmg", "Crew_0.1.0_aarch64.dmg"));
    write(join(bundle, "macos", "Crew.app.tar.gz"), "tar");
    write(join(bundle, "macos", "Crew.app.tar.gz.sig"), "sig");

    const staged = stageBuildArtifacts(bundle, output, "aarch64");

    assert.equal(basename(staged.tar), "Crew_aarch64.app.tar.gz");
    assert.equal(basename(staged.signature), "Crew_aarch64.app.tar.gz.sig");
  });

  it("rejects missing, duplicate, and mismatched build outputs", () => {
    const missing = temporaryDirectory();
    mkdirSync(join(missing, "dmg"), { recursive: true });
    mkdirSync(join(missing, "macos"), { recursive: true });
    assert.throws(
      () => stageBuildArtifacts(missing, join(missing, "out"), "aarch64"),
      /exactly one DMG/,
    );

    const duplicate = temporaryDirectory();
    write(join(duplicate, "dmg", "one.dmg"));
    write(join(duplicate, "dmg", "two.dmg"));
    write(join(duplicate, "macos", "Crew.app.tar.gz"));
    write(join(duplicate, "macos", "Crew.app.tar.gz.sig"));
    assert.throws(
      () => stageBuildArtifacts(duplicate, join(duplicate, "out"), "aarch64"),
      /exactly one DMG/,
    );

    const mismatched = temporaryDirectory();
    write(join(mismatched, "dmg", "one.dmg"));
    write(join(mismatched, "macos", "Crew.app.tar.gz"));
    write(join(mismatched, "macos", "Other.app.tar.gz.sig"));
    assert.throws(
      () => stageBuildArtifacts(mismatched, join(mismatched, "out"), "aarch64"),
      /does not match/,
    );
  });
});

describe("inspectPublishedArtifacts", () => {
  it("requires two arch-tagged DMGs and matching updater pairs", () => {
    const root = temporaryDirectory();
    write(join(root, "Crew_0.1.0_aarch64.dmg"));
    write(join(root, "Crew_0.1.0_x64.dmg"));
    write(join(root, "Crew_aarch64.app.tar.gz"), "tar-arm");
    write(join(root, "Crew_aarch64.app.tar.gz.sig"), "sig-arm");
    write(join(root, "Crew_x86_64.app.tar.gz"), "tar-x64");
    write(join(root, "Crew_x86_64.app.tar.gz.sig"), "sig-x64");

    const inspected = inspectPublishedArtifacts(root);
    assert.equal(basename(inspected.armDmg), "Crew_0.1.0_aarch64.dmg");
    assert.equal(basename(inspected.x64Tar), "Crew_x86_64.app.tar.gz");
  });

  it("rejects a mixed or incomplete artifact set", () => {
    const root = temporaryDirectory();
    write(join(root, "Crew_0.1.0_aarch64.dmg"));
    write(join(root, "Crew_aarch64.app.tar.gz"), "tar-arm");
    write(join(root, "Crew_aarch64.app.tar.gz.sig"), "sig-arm");
    assert.throws(() => inspectPublishedArtifacts(root), /expected two DMGs/);
  });
});
