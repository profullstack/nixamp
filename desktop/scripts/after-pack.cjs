/**
 * Put the CLI's dependencies into the packaged app.
 *
 * electron-builder refuses to copy a directory named `node_modules` through
 * `extraResources` — it assumes any such directory is the app's own dependency
 * tree, which it packs separately. Ours is not: it is the tree the bundled CLI
 * resolves against when Electron runs it as Node, and without it `nixamp` in
 * the bundle cannot find hqtui. So it is copied after packing, by hand.
 */
"use strict";

const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const from = join(__dirname, "..", "staging", "cli", "node_modules");
  if (!existsSync(from)) throw new Error(`nixamp: ${from} is missing — run the stage script first`);

  const resources = context.packager.platform.name === "mac"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");

  const to = join(resources, "cli", "node_modules");
  cpSync(from, to, { recursive: true, dereference: true });
  console.log(`  • bundled the CLI's dependencies  to=${to}`);
};
