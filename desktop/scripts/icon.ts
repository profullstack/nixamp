/**
 * The desktop icon, drawn from the same source as the PWA's so the two cannot
 * drift apart. electron-builder wants at least 512×512; it gets 1024.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drawIcon, encodePng } from "../../web/scripts/icons.ts";

const buildDir = join(new URL("..", import.meta.url).pathname, "build");
mkdirSync(buildDir, { recursive: true });

const path = join(buildDir, "icon.png");
writeFileSync(path, encodePng(drawIcon(1024, false)));
console.log(`wrote ${path}`);
