/**
 * List the jingles that ship, so nobody has to keep a list by hand.
 *
 * Drop another mp3 into web/public/jingles and it is in the rotation the next
 * time this runs -- which is part of the web build. A list written in code
 * instead would be a list that goes stale the first time somebody adds a file
 * and forgets, and the failure would be silent.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../public/jingles", import.meta.url));

export function jingleNames(dir = here, read: (at: string) => string[] = readdirSync): string[] {
  try {
    return read(dir).filter((name) => name.toLowerCase().endsWith(".mp3")).sort();
  } catch {
    return [];
  }
}

export function writeManifest(dir = here): string[] {
  const names = jingleNames(dir);
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(names, null, 2)}\n`);
  return names;
}

if (import.meta.main) {
  const names = writeManifest();
  console.log(`jingles: ${names.length === 0 ? "none" : names.join(", ")}`);
}
