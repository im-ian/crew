import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = readFileSync(new URL("./install-macos.sh", import.meta.url), "utf8");

test("the installer parses", () => {
  const r = spawnSync("bash", ["-n", fileURLToPath(new URL("./install-macos.sh", import.meta.url))]);
  assert.equal(r.status, 0, String(r.stderr));
});

test("expects the new bundle identifier and still takes the one up to 0.15.1", () => {
  assert.match(script, /^expected_bundle_id="com\.imian\.crew"$/m);
  assert.match(script, /^legacy_bundle_id="dev\.jthefloor\.crew"$/m);
  assert.match(
    script,
    /\[\[ "\$bundle_id" != "\$expected_bundle_id" && "\$bundle_id" != "\$legacy_bundle_id" \]\]/,
  );
});

test("says so when it replaces an app that has another identifier", () => {
  assert.match(script, /installed_bundle_id="\$\(\/usr\/libexec\/PlistBuddy[^)]*Info\.plist"/);
  assert.match(script, /"\$installed_bundle_id" != "\$bundle_id"/);
  // It reads the installed app's identifier before the app is removed.
  assert.ok(script.indexOf("installed_bundle_id=") < script.indexOf('run_install_cmd rm -rf "$target_app"'));
});

test("the app's own identifier is the new one", () => {
  const conf = JSON.parse(readFileSync(new URL("../crates/crew/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(conf.identifier, "com.imian.crew");
});

test("no longer strips the quarantine flag, or asks for the tool that did", () => {
  assert.doesNotMatch(script, /xattr/);
  assert.doesNotMatch(script, /com\.apple\.quarantine/);
});

test("takes only an app Gatekeeper accepts as notarized, before it replaces anything and after it installs", () => {
  assert.match(script, /spctl --assess --type execute --verbose=2 "\$1"/);
  assert.match(script, /source=Notarized Developer ID/);
  assert.match(script, /^for tool in [^\n]*\bspctl\b/m);
  const before = script.indexOf('require_gatekeeper "$source_app"');
  const removes = script.indexOf('run_install_cmd rm -rf "$target_app"');
  const after = script.indexOf('require_gatekeeper "$target_app"');
  const link = script.indexOf('ln -sf "${target_app}/Contents/MacOS/crew"');
  assert.ok(before > 0 && before < removes, "checked in the disk image first");
  assert.ok(removes < after && after < link, "checked again once installed, before the CLI is linked");
  // A refusal says why and what the way out of an old build is.
  assert.match(script, /does not accept \$\{app_name\}/);
  assert.match(script, /0\.15\.1 and later/);
});

test("the README and the release notes say the same", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  // The one-liner for an old build is the only xattr left, and the unsigned warning is gone.
  assert.equal(readme.match(/xattr/g)?.length, 1);
  assert.doesNotMatch(readme, /서명·공증되지 않은 빌드/);
  assert.match(readme, /0\.15\.1부터 Crew는 Apple Developer ID로 서명되고 Apple 공증을 받아요/);
  const release = readFileSync(new URL("../docs/release.md", import.meta.url), "utf8");
  assert.doesNotMatch(release, /그때 정리해요/);
  assert.match(release, /0\.15\.1부터 서명·공증된 릴리스가 나가서/);
});
