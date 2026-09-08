#!/usr/bin/env node
import { main } from "../dist/main.js";

main().catch((error) => {
  // A message we wrote is a message the user can act on; anything else is a
  // bug and deserves its stack.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith("nixamp:") ? message : error);
  process.exit(1);
});
