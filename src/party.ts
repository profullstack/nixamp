/**
 * `nixamp party` -- a watch party, from a terminal.
 *
 * A watch party on bittorrented.com is a six-character code, a host and a
 * film. Once it is bridged (watch-party.ts) it is also a nixamp room, which
 * means this terminal can list them, join one, follow where the host is in
 * the film, and put a new one on the air -- with no browser, over ssh, on a
 * machine with no display.
 *
 * What this does NOT do is fetch the film. The media stays on the site that
 * has it, because that is the site with the rights, the torrent and the
 * bandwidth. What nixamp carries is the room: the audio channel, who is in
 * it, the chat, and the second everybody is supposed to be at. `--open`
 * hands the picture to a browser and keeps the room here, which is the
 * arrangement that actually works on a laptop.
 */
import { openInBrowser, readSession } from "./session.ts";

export interface PartyRow {
  party: {
    eventId: string;
    roomId: string;
    slug: string;
    origin: string;
    partyCode: string;
    partyUrl: string;
    mediaTitle: string;
    positionSeconds: number;
    positionNow: number;
    playing: boolean;
  };
  event: { id: string; title: string; status: string; ownerId: string; visibility: string };
  links: { nixampUrl: string; roomUrl: string; partyUrl: string };
  host: boolean;
}

/** mm:ss, or h:mm:ss once a film is long enough to need the hour. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const s = String(whole % 60).padStart(2, "0");
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function partyLines(row: PartyRow): string[] {
  const where = row.party.playing ? `▶ ${clock(row.party.positionNow)}` : `❚❚ ${clock(row.party.positionNow)}`;
  return [
    `${row.party.partyCode}  ${row.event.title}${row.host ? "  (yours)" : ""}`,
    `  ${where}${row.party.mediaTitle ? `  ${row.party.mediaTitle}` : ""}  ·  ${row.party.origin}`,
    `  watch:  ${row.links.partyUrl || row.links.nixampUrl}`,
    `  room:   ${row.links.nixampUrl}`,
  ];
}

const HELP = `nixamp party — watch parties, here and on the sites nixamp is connected to.

  nixamp party list                     the ones you could join right now
  nixamp party join CODE                the room, the links, and where the film is
  nixamp party join CODE --open         and open the picture in a browser
  nixamp party host CODE --url URL      put a party on the air as a nixamp room
  nixamp party sync CODE --at 1234      say where playback is (hosts only)
  nixamp party sync CODE --pause        ...and that it is paused
  nixamp party end CODE                 end it

A party lives on the site that has the film; nixamp carries the room. The
code is the one that site shows you — bittorrented.com prints six characters.

  --site URL   somewhere other than the nixamp you are signed in to
  --json       the raw answer, for a script
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The whole `nixamp party` command. */
export async function party(argv: string[], fetcher: typeof fetch = fetch): Promise<number> {
  const [command = "list", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }

  const session = readSession();
  if (session === null) {
    console.error("nixamp: not signed in. Try `nixamp login`.");
    return 1;
  }
  const site = (flag(rest, "--site") ?? session.site).replace(/\/+$/, "");
  const where = `${site}/api/v1/watch-parties`;
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  const asJson = rest.includes("--json");
  const code = rest.find((one) => !one.startsWith("-")) ?? "";

  const fail = async (answer: Response): Promise<number> => {
    const body = (await answer.json().catch(() => ({}))) as { error?: string };
    console.error(`nixamp: ${body.error ?? `that did not work (${answer.status})`}`);
    return 1;
  };

  try {
    if (command === "list" || command === "ls") {
      const answer = await fetcher(where, { headers });
      if (!answer.ok) return fail(answer);
      const body = (await answer.json()) as { parties?: PartyRow[] };
      const rows = body.parties ?? [];
      if (asJson) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (rows.length === 0) {
        console.log("No watch parties on right now. `nixamp party host CODE` starts one.");
        return 0;
      }
      for (const row of rows) for (const line of partyLines(row)) console.log(line);
      return 0;
    }

    if (command === "join" || command === "open" || command === "show") {
      if (!code) {
        console.error("nixamp: which party? `nixamp party join ABC123`.");
        return 64;
      }
      const answer = await fetcher(`${where}/${encodeURIComponent(code)}`, { headers });
      if (!answer.ok) return fail(answer);
      const row = (await answer.json()) as PartyRow;
      if (asJson) {
        console.log(JSON.stringify(row, null, 2));
        return 0;
      }
      for (const line of partyLines(row)) console.log(line);
      // The picture is the other site's; the room is ours. Opening one and
      // printing the other is the arrangement that works on one screen.
      if (rest.includes("--open")) {
        const target = row.links.partyUrl || row.links.nixampUrl;
        console.log(`\nOpening ${target}`);
        openInBrowser(target);
      } else {
        console.log(`\n  Listen here:  nixamp attach --url ${site} --key <listen key>`);
        console.log(`  Or open it:   nixamp party join ${row.party.partyCode} --open`);
      }
      return 0;
    }

    if (command === "host" || command === "bridge" || command === "start") {
      if (!code) {
        console.error("nixamp: which party? Give the code the site is showing, e.g. `nixamp party host ABC123`.");
        return 64;
      }
      const answer = await fetcher(where, {
        method: "POST",
        headers,
        body: JSON.stringify({
          partyCode: code,
          ...(flag(rest, "--title") ? { title: flag(rest, "--title") } : {}),
          ...(flag(rest, "--url") ? { partyUrl: flag(rest, "--url") } : {}),
          ...(flag(rest, "--media") ? { mediaTitle: flag(rest, "--media") } : {}),
          ...(rest.includes("--public") ? { visibility: "public" } : {}),
        }),
      });
      if (!answer.ok) return fail(answer);
      const row = (await answer.json()) as PartyRow;
      if (asJson) {
        console.log(JSON.stringify(row, null, 2));
        return 0;
      }
      for (const line of partyLines(row)) console.log(line);
      console.log(`\n  Share the room:  ${row.links.nixampUrl}`);
      return 0;
    }

    if (command === "sync" || command === "seek") {
      if (!code) {
        console.error("nixamp: which party? `nixamp party sync ABC123 --at 930`.");
        return 64;
      }
      const at = Number(flag(rest, "--at") ?? flag(rest, "--seconds") ?? NaN);
      if (!Number.isFinite(at) || at < 0) {
        console.error("nixamp: where to? `--at 930` is fifteen and a half minutes in.");
        return 64;
      }
      const answer = await fetcher(`${where}/${encodeURIComponent(code)}/playback`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          positionSeconds: at,
          playing: !rest.includes("--pause") && !rest.includes("--paused"),
          ...(flag(rest, "--media") ? { mediaTitle: flag(rest, "--media") } : {}),
        }),
      });
      if (!answer.ok) return fail(answer);
      const row = (await answer.json()) as PartyRow;
      console.log(`${row.party.partyCode}  ${row.party.playing ? "playing" : "paused"} at ${clock(row.party.positionSeconds)}`);
      return 0;
    }

    if (command === "end" || command === "stop") {
      if (!code) {
        console.error("nixamp: which party? `nixamp party end ABC123`.");
        return 64;
      }
      const answer = await fetcher(`${where}/${encodeURIComponent(code)}/end`, { method: "POST", headers });
      if (!answer.ok) return fail(answer);
      console.log(`Ended ${code}.`);
      return 0;
    }
  } catch (error) {
    console.error(`nixamp: could not reach ${site}: ${(error as Error).message}`);
    return 1;
  }

  console.error(`nixamp party: unknown action ${command}. Try list, join, host, sync or end.`);
  return 64;
}
