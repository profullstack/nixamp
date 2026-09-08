import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRoot, readManifest, uninstall, update } from "../src/manage.ts";

/** A tree shaped the way the installer leaves one. */
function installed(): { prefix: string; share: string; cleanup: () => void } {
  const prefix = mkdtempSync(join(tmpdir(), "nixamp-manage-"));
  const share = join(prefix, "share", "nixamp");
  mkdirSync(join(share, "cli", "dist"), { recursive: true });
  writeFileSync(
    join(share, "manifest.json"),
    JSON.stringify({
      version: "9.9.9",
      method: "cli-tarball",
      installer: "https://nixamp.com/install.sh",
      installedAt: "2026-01-01T00:00:00Z",
      prefix,
      desktop: false,
      paths: [join(prefix, "bin", "nixamp"), share],
    }),
  );
  return { prefix, share, cleanup: () => rmSync(prefix, { recursive: true, force: true }) };
}

const withoutHome = <T,>(run: () => T): T => {
  const saved = process.env["NIXAMP_HOME"];
  delete process.env["NIXAMP_HOME"];
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env["NIXAMP_HOME"];
    else process.env["NIXAMP_HOME"] = saved;
  }
};

test("NIXAMP_HOME wins, because the shim is the thing that knows", () => {
  const { share, cleanup } = installed();
  try {
    process.env["NIXAMP_HOME"] = share;
    assert.equal(installRoot(), share);
  } finally {
    delete process.env["NIXAMP_HOME"];
    cleanup();
  }
});

test("a shim from an older install is found by walking up", () => {
  const { share, cleanup } = installed();
  try {
    withoutHome(() => {
      assert.equal(installRoot(join(share, "cli", "dist")), share);
    });
  } finally {
    cleanup();
  }
});

test("the walk finds share/nixamp from the prefix as well", () => {
  const { prefix, share, cleanup } = installed();
  try {
    withoutHome(() => {
      assert.equal(installRoot(prefix), share);
    });
  } finally {
    cleanup();
  }
});

test("an uninstalled copy is reported as one, not acted on", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-loose-"));
  try {
    withoutHome(() => {
      // A checkout or an npx run has no manifest anywhere above it, so both
      // commands must decline rather than guess at paths to delete.
      process.env["NIXAMP_HOME"] = join(dir, "nowhere");
      assert.equal(installRoot(dir), null);
      assert.equal(uninstall(["--yes"]), 69);
      assert.equal(update([]), 69);
      delete process.env["NIXAMP_HOME"];
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall without --yes changes nothing", () => {
  const { share, cleanup } = installed();
  try {
    process.env["NIXAMP_HOME"] = share;
    // No uninstall.sh is written here: reaching it would be the failure.
    assert.equal(uninstall([]), 0);
    assert.equal(readManifest(share)?.version, "9.9.9");
  } finally {
    delete process.env["NIXAMP_HOME"];
    cleanup();
  }
});

test("a missing uninstall script is an error, not a guess", () => {
  const { share, cleanup } = installed();
  try {
    process.env["NIXAMP_HOME"] = share;
    assert.equal(uninstall(["--yes"]), 1);
  } finally {
    delete process.env["NIXAMP_HOME"];
    cleanup();
  }
});

test("a manifest that is not there reads as null rather than throwing", () => {
  assert.equal(readManifest(join(tmpdir(), "nixamp-does-not-exist")), null);
});
