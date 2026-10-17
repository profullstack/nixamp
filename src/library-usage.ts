/** `nixamp library` subcommands and usage, apart so help does not load the client. */
export const LIBRARY_COMMANDS = new Set(["status", "sources", "add", "scan", "search", "show", "fix", "remove"]);

export const LIBRARY_USAGE = `nixamp library — what this server has, indexed

  nixamp library PATH                 the folder the daemon serves (set once)
  nixamp library status               items by state, sources, last scans
  nixamp library sources
  nixamp library add PATH             index another folder (inside your home, not hidden)
  nixamp library scan [SOURCE] [--force] [--wait]
  nixamp library search WORDS [--artist A] [--album A] [--state failed] [--limit 20]
  nixamp library show ITEM
  nixamp library fix ITEM --title T [--artist A] [--album A] [--genre G] [--track N] [--year N]
  nixamp library remove SOURCE        forget a folder; its files are not touched

  --json        machine-readable output
  --url, --key  another server, as with \`nixamp admin\``;
