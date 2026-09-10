/**
 * A fixture, as one line: who is playing whom, the score, and where the game
 * has got to. nichedb's sports collection answers with both teams, their
 * logos and scores, the state of play and a clock; this turns that into the
 * words and pictures the meta line draws, and nothing else, so it can be
 * tested without a page.
 */

/** As much of nichedb's fixture as is read here. */
export interface FixtureLike {
  published_at?: string | null;
  year?: number | null;
  data: Record<string, unknown>;
  tags?: string[];
}

export interface Side {
  name: string;
  score: number | null;
  logo: string;
}

export interface ScoreLine {
  away: Side;
  home: Side;
  state: "pre" | "in" | "post";
  /** "Bills 17 – Chiefs 21": the row, in words, for a title or a test. */
  text: string;
  /** The chip beside the row: "LIVE · Q3 4:12", "Kicks off 7:30 PM", "FINAL". */
  status: string;
  /** League and broadcaster, when the fixture says. */
  chips: string[];
}

interface Team {
  name?: unknown;
  displayName?: unknown;
  abbreviation?: unknown;
  logoUrl?: unknown;
  score?: unknown;
}

function side(team: Team | undefined, fallbackScore: unknown): Side {
  const name = String(team?.name ?? team?.displayName ?? team?.abbreviation ?? "");
  const score = typeof team?.score === "number" ? team.score : typeof fallbackScore === "number" ? fallbackScore : null;
  const logo = typeof team?.logoUrl === "string" && /^https?:\/\//.test(team.logoUrl) ? team.logoUrl : "";
  return { name, score, logo };
}

/** Where the game has got to, from the data or the tags, and "pre" when neither says. */
export function fixtureState(fixture: FixtureLike): "pre" | "in" | "post" {
  const said = String(fixture.data["state"] ?? fixture.tags?.find((t) => t.startsWith("state:"))?.slice(6) ?? "");
  return said === "in" || said === "post" ? said : "pre";
}

/**
 * When it starts, in the viewer's own clock. The day is named when it is not
 * today, since "Kicks off 7:30 PM" on Tuesday's game read as tonight's.
 */
export function kickoff(when: string | null | undefined, options: { now?: Date; locale?: string; timeZone?: string } = {}): string {
  if (!when) return "";
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) return "";
  const now = options.now ?? new Date();
  const tz = options.timeZone ? { timeZone: options.timeZone } : {};
  const sameDay = at.toLocaleDateString(options.locale, tz) === now.toLocaleDateString(options.locale, tz);
  return at.toLocaleString(options.locale, {
    ...tz,
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export function scoreLine(fixture: FixtureLike, options: { now?: Date; locale?: string; timeZone?: string } = {}): ScoreLine {
  const d = fixture.data;
  const away = side(d["away"] as Team | undefined, d["awayScore"]);
  const home = side(d["home"] as Team | undefined, d["homeScore"]);
  const state = fixtureState(fixture);
  const detail = typeof d["statusDetail"] === "string" ? (d["statusDetail"] as string).trim() : "";
  let status: string;
  if (state === "in") status = detail ? `LIVE · ${detail}` : "LIVE";
  else if (state === "post") status = "FINAL";
  else {
    const when = kickoff(fixture.published_at, options);
    status = when ? `Kicks off ${when}` : detail || "Upcoming";
  }
  const chips: string[] = [];
  const league = d["league"] as { abbreviation?: unknown; name?: unknown } | undefined;
  const leagueName = String(league?.abbreviation ?? league?.name ?? "");
  if (leagueName) chips.push(leagueName);
  if (typeof d["broadcast"] === "string" && d["broadcast"].trim()) chips.push(d["broadcast"].trim());
  // Before the game the scores are noise: 0 – 0 says nothing has happened.
  const showScore = state !== "pre";
  const num = (s: Side): string => (showScore && s.score !== null ? ` ${s.score}` : "");
  return {
    away, home, state, status, chips,
    text: `${away.name}${num(away)} – ${home.name}${num(home)}`,
  };
}
