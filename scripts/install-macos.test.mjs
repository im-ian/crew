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
