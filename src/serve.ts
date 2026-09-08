/**
 * The server on its own, with no terminal UI attached.
 *
 * `nixamp serve` reaches the same code through main.ts, but the desktop app
 * spawns this file directly: it pulls in no TUI, so what it has to load is the
 * four modules that decode and serve and nothing else.
 */
import { version } from "./meta.ts";
import { serve } from "./server.ts";

await serve(process.argv.slice(2), version());
