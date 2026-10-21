/**
 * `nixamp school`: classes on backtoschool.help from the terminal.
 *
 * A class is a live event on nixamp's accounts, so `nixamp login` is the
 * sign-in here too. `teach` is the short path: a station link in, a class on
 * the air out. `check` and `prune` exist because a class stays live after
 * its broadcast is gone, and the page then shows a player that never plays.
 */
import {
  broadcastHealth, checkClasses, classUrl, createClass, deleteClass, getClass, listClasses, moveClass, teach, updateClass,
  type SchoolClass,
} from "./school-client.ts";

export const SCHOOL_USAGE = `nixamp school: classes on backtoschool.help (sign in with \`nixamp login\`)

  nixamp school [list] [--status live|scheduled|draft|ended] [--mine]
  nixamp school show SLUG                 one class, and whether its broadcast plays
  nixamp school teach LINK --title T [--description D] [--topic T] [--unlisted|--private]
                                          make a class of a broadcast and start it now
  nixamp school create --title T [LINK] [--starts 2026-11-01T17:00:00Z] [--description D] [--topic T]
  nixamp school update SLUG [--title T] [--description D] [--topic T] [--link URL] [--public|--unlisted|--private]
  nixamp school start SLUG
  nixamp school end SLUG
  nixamp school delete SLUG
  nixamp school check                     your live classes, and which ones no longer play
  nixamp school prune [--end|--delete]    end or delete the ones that no longer play (prints them without a flag)

LINK is what plays: a station link (\`nixamp station show ID\`), a nixamp.com share link, a
Pairux room, or an https .m3u8/.mp4/.mp3. SLUG is the class's slug or its /live/ link.
  --json   machine-readable      NIXAMP_SCHOOL_URL   another site (backtoschool.help by default)
`;

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/** The first argument after the command that is not a flag or a flag's value. */
function positional(argv: string[]): string | undefined {
  const valued = new Set(["--title", "--description", "--topic", "--starts", "--link", "--status"]);
  for (let at = 1; at < argv.length; at += 1) {
    const one = argv[at]!;
    if (valued.has(one)) { at += 1; continue; }
    if (!one.startsWith("--")) return one;
  }
  return undefined;
}

function fields(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, key] of [["--title", "title"], ["--description", "description"], ["--topic", "topic"], ["--starts", "startsAt"], ["--link", "broadcastUrl"]] as const) {
    const value = flag(argv, name);
    if (value !== undefined) out[key] = value;
  }
  for (const visibility of ["public", "unlisted", "private"]) if (argv.includes(`--${visibility}`)) out["visibility"] = visibility;
  return out;
}

function print(item: SchoolClass): void {
  console.log(`${item.status.padEnd(9)} ${item.title}\n          ${classUrl(item)}${item.broadcastUrl ? `\n          plays ${item.broadcastUrl}` : ""}`);
}

export async function school(argv: string[]): Promise<number> {
  const [sub = "list"] = argv;
  const json = argv.includes("--json");
  const slug = positional(argv);
  const out = (value: unknown, human: () => void): void => { if (json) console.log(JSON.stringify(value, null, 2)); else human(); };
  try {
    if (sub === "help" || argv.includes("--help")) {
      console.log(SCHOOL_USAGE);
      return 0;
    }
    if (sub === "list") {
      const status = flag(argv, "--status");
      const items = await listClasses({ ...(status ? { status } : {}), mine: argv.includes("--mine") });
      out(items, () => { if (items.length === 0) console.log("No classes match."); for (const one of items) print(one); });
      return 0;
    }
    if (sub === "check" || sub === "prune") {
      const checked = await checkClasses();
      const broken = checked.filter((one) => one.health.ok === false);
      const act = sub === "prune" ? (argv.includes("--delete") ? "delete" : argv.includes("--end") ? "end" : "") : "";
      for (const { item } of act ? broken : []) {
        if (act === "delete") await deleteClass(item.id);
        else await moveClass(item.id, "end");
      }
      out(checked.map(({ item, health }) => ({ slug: item.slug, ok: health.ok, reason: health.reason, ...(act && health.ok === false ? { done: act } : {}) })), () => {
        if (checked.length === 0) console.log("You have no live classes.");
        for (const { item, health } of checked) console.log(`${health.ok === true ? "plays " : health.ok === false ? "BROKEN" : "  ?   "}  ${item.slug}  (${health.reason})`);
        if (sub === "prune" && broken.length > 0) console.log(act ? `\n${act === "delete" ? "Deleted" : "Ended"} ${broken.length}.` : `\n${broken.length} no longer play. --end or --delete them.`);
      });
      return 0;
    }
    if (sub === "teach" || sub === "create") {
      const input = fields(argv);
      if (slug) input["broadcastUrl"] = slug;
      if (!input["title"]) { console.error(`nixamp school ${sub} needs --title`); return 2; }
      if (sub === "teach" && !input["broadcastUrl"]) { console.error("nixamp school teach needs the LINK that plays"); return 2; }
      const item = sub === "teach" ? await teach(input) : await createClass(input);
      out(item, () => { print(item); if (sub === "create") console.log(`\nnixamp school start ${item.slug} puts it on the air.`); });
      return 0;
    }
    if (!slug) { console.error(`nixamp school ${sub} needs a class (its slug or /live/ link)\n\n${SCHOOL_USAGE}`); return 2; }
    if (sub === "show") {
      const item = await getClass(slug);
      const health = await broadcastHealth(item.broadcastUrl);
      out({ ...item, broadcast: health }, () => { print(item); console.log(`          broadcast: ${health.ok === true ? "playing" : health.ok === false ? "NOT playing" : "unknown"} (${health.reason})`); });
      return 0;
    }
    if (sub === "update") {
      const item = await updateClass(slug, fields(argv));
      out(item, () => print(item));
      return 0;
    }
    if (sub === "start" || sub === "end") {
      const item = await moveClass(slug, sub);
      out(item, () => print(item));
      return 0;
    }
    if (sub === "delete" || sub === "rm") {
      await deleteClass(slug);
      out({ ok: true, slug }, () => console.log(`Deleted ${slug}.`));
      return 0;
    }
    console.error(`nixamp school: no command "${sub}".\n\n${SCHOOL_USAGE}`);
    return 2;
  } catch (error) {
    console.error(`nixamp school: ${(error as Error).message}`);
    return 1;
  }
}
