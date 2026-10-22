/** `nixamp library` subcommands and usage, apart so help does not load the client. */
export const LIBRARY_COMMANDS = new Set(["status", "sources", "add", "scan", "search", "show", "fix", "remove", "playlists", "playlist", "publish", "vods", "unpublish"]);

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
  nixamp library playlists
  nixamp library playlist new NAME [ITEM...]
  nixamp library playlist show|delete PLAYLIST
  nixamp library playlist add PLAYLIST ITEM...
  nixamp library publish ITEM... | FOLDER | WORDS --basis B [--title T] [--note N] [--dry-run]
                                      on demand on live.streaming: a link that plays each from the start,
                                      from any of your servers (needs nixamp login); --here for this server's own guide
                                      (B: owned, permission, licensed, creative-commons, public-domain)
  nixamp library vods                 what is published on demand, with each link
  nixamp library unpublish VOD        take one off

  --json        machine-readable output
  --url, --key  another server, as with \`nixamp admin\``;
