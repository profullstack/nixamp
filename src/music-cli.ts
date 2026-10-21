/**
 * `nixamp music`: the AI label's catalogue, buying, and what you bought.
 *
 *   nixamp music [list]                    what you bought (signed in with that email)
 *   nixamp music catalog [SERVER]          artists, albums and songs (live.streaming by default)
 *   nixamp music buy LINK|--server S --kind song|album|artist --artist A [--album B] [--n N]
 *                    [--email E] [--coin SOL]   prints the CoinPay page to pay on
 *   nixamp music download ID|all [--out DIR]   the zip(s) of what you bought
 *
 * Listening is free on the live stations; the files are sold: a song 10¢, an
 * album $1, everything by an artist $2.
 */
import { buy, catalogue, download, fromBuyLink, PRICE_WORDS, purchases } from "./music-client.ts";

export const MUSIC_USAGE = `nixamp music: the AI label's songs as files (${PRICE_WORDS}; live radio is free)

  nixamp music [list]                     what you bought, with its download link
  nixamp music catalog [SERVER]           the artists, albums and songs (live.streaming by default)
  nixamp music buy LINK                   a nixamp.com/buy link, or:
  nixamp music buy --server URL --kind song|album|artist --artist KEY [--album KEY] [--n N]
                   [--email you@example.com] [--coin SOL]      prints the CoinPay page to pay on
  nixamp music download ID|all [--out DIR]   save the zip(s): MP3s with art and lyrics
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export async function music(argv: string[]): Promise<number> {
  const [sub = "list", arg] = argv;
  const json = argv.includes("--json");
  try {
    if (sub === "help" || argv.includes("--help")) {
      console.log(MUSIC_USAGE);
      return 0;
    }
    if (sub === "list") {
      const mine = await purchases();
      if (json) { console.log(JSON.stringify(mine, null, 2)); return 0; }
      if (mine.purchases.length === 0) { console.log(`Nothing bought yet for ${mine.email}. Every AI label song is for sale: ${PRICE_WORDS}.`); return 0; }
      for (const one of mine.purchases) console.log(`${one.id}  ${one.kind.padEnd(6)} ${one.title} · ${one.artistName}  ${new Date(one.paidAt).toISOString().slice(0, 10)}\n  ${one.zip ?? "(not paid yet)"}`);
      return 0;
    }
    if (sub === "catalog" || sub === "catalogue") {
      const view = await catalogue(arg && !arg.startsWith("--") ? arg : undefined);
      if (json) { console.log(JSON.stringify(view, null, 2)); return 0; }
      for (const genre of view.genres) {
        console.log(`\n${genre.genre}${genre.station ? `  (live: /watch/${genre.station})` : ""}`);
        for (const artist of genre.artists) {
          console.log(`  ${artist.name}  [${artist.key}]`);
          for (const album of artist.albums) console.log(`    ${album.year}  ${album.title}  [${album.key}]  ${album.songs.length} songs${album.complete ? "" : " (recording)"}`);
        }
      }
      console.log(`\n℗ ${view.holder}. ${PRICE_WORDS}: nixamp music buy --server ${view.server ?? "URL"} --kind album --artist KEY --album KEY`);
      return 0;
    }
    if (sub === "buy") {
      const fromLink = arg && !arg.startsWith("--") ? fromBuyLink(arg) : null;
      if (arg && !arg.startsWith("--") && !fromLink) { console.error("nixamp music buy: that is not a nixamp.com/buy link"); return 2; }
      const input: Record<string, unknown> = {
        ...(fromLink ?? { server: flag(argv, "--server"), kind: flag(argv, "--kind"), artist: flag(argv, "--artist"), album: flag(argv, "--album"), n: flag(argv, "--n") ? Number(flag(argv, "--n")) : undefined }),
        coin: flag(argv, "--coin") ?? "USDC_POL",
        ...(flag(argv, "--email") ? { email: flag(argv, "--email") } : {}),
      };
      if (typeof input["n"] === "string") input["n"] = Number(input["n"]);
      const made = await buy(input);
      if (json) { console.log(JSON.stringify(made, null, 2)); return 0; }
      console.log(`Pay here: ${made.url}\nYour receipt and download, once paid: ${made.receipt}`);
      return 0;
    }
    if (sub === "download") {
      if (!arg) { console.error("nixamp music download needs a purchase id (nixamp music) or all"); return 2; }
      const mine = await purchases();
      const chosen = arg === "all" ? mine.purchases : mine.purchases.filter((one) => one.id === arg);
      if (chosen.length === 0) { console.error(`nixamp music: no purchase ${arg}`); return 1; }
      for (const one of chosen) console.log(`saved ${await download(one, flag(argv, "--out") ?? ".")}`);
      return 0;
    }
    console.error(`nixamp music: no command "${sub}".\n\n${MUSIC_USAGE}`);
    return 2;
  } catch (error) {
    console.error(`nixamp music: ${(error as Error).message}`);
    return 1;
  }
}
