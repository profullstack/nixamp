/**
 * Who is in each AI label band: an OpenProfile page per member and one for
 * the band, so the same people sing, appear on covers and in videos every
 * time instead of whoever an image model draws next.
 *
 *     <artist folder>/artist.md                 the band: genre, sound, members, discography
 *     <artist folder>/members/<slug>.md         a member: role, look, voice, personality...
 *     <artist folder>/members/<slug>.jpg        their reference portrait
 *
 * The pages are the source of truth once written: a person may edit a
 * member's look or voice by hand, and what is generated next reads the page
 * back (readMember). Members are invented once, by a language model, as
 * fictional people; the portrait is drawn from the look and kept.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { askJson } from "./ai-text.ts";

export interface Member {
  slug: string;
  name: string;
  /** What they do in the band: "lead vocals", "lead guitar", "drums"... */
  role: string;
  /** How they look, in enough detail to draw the same person again: age, face, hair, build, signature clothes. */
  look: string;
  /** How they sound, for a singer; how they play, for the rest. */
  voice: string;
  personality: string;
  influences: string;
  bio: string;
}

export function memberSlug(name: string): string {
  return name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "member";
}

function line(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

/** A member's OpenProfile page. */
export function memberMarkdown(member: Member, band: { name: string; holder: string }): string {
  return [
    `# ${member.name}`,
    "",
    "- **Kind**: fictional musician, made with AI",
    `- **Band**: [${band.name}](../artist.md)`,
    `- **Role**: ${line(member.role)}`,
    `- **Avatar**: [portrait](${member.slug}.jpg)`,
    `- **Parent**: ${band.holder}`,
    "",
    line(member.bio),
    "",
    "## Look",
    "",
    line(member.look),
    "",
    "## Voice",
    "",
    line(member.voice),
    "",
    "## Personality",
    "",
    line(member.personality),
    "",
    "## Influences",
    "",
    line(member.influences),
    "",
  ].join("\n");
}

/** A member's page read back, so hand edits win; null when it is not one of ours. */
export function readMember(text: string, slug: string): Member | null {
  const name = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  if (!name) return null;
  const field = (label: string): string => new RegExp(`^- \\*\\*${label}\\*\\*:\\s*(.+)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const section = (heading: string): string => {
    const match = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m").exec(text);
    return (match?.[1] ?? "").trim().replace(/\s+/g, " ");
  };
  // The bio is the prose between the fields and the first section.
  const bio = (/^- \*\*Parent\*\*:.*$\n+([\s\S]*?)(?=^##\s)/m.exec(text)?.[1] ?? "").trim().replace(/\s+/g, " ");
  return { slug, name, role: field("Role"), look: section("Look"), voice: section("Voice"), personality: section("Personality"), influences: section("Influences"), bio };
}

/** The band's OpenProfile page. */
export function bandMarkdown(band: {
  name: string; genre: string; sound: string; voice: string; bio: string; themes: string; holder: string;
  members: Member[]; albums: Array<{ year: number; title: string }>;
}): string {
  return [
    `# ${band.name}`,
    "",
    "- **Kind**: band, fictional, made with AI",
    `- **Genre**: ${band.genre}`,
    `- **Label**: ${band.holder}`,
    `- **Members**: ${band.members.map((one) => `[${one.name}](members/${one.slug}.md) (${one.role})`).join(", ")}`,
    "",
    line(band.bio),
    "",
    "## Sound",
    "",
    line(band.sound),
    "",
    "## Lead voice",
    "",
    line(band.voice),
    "",
    "## Themes",
    "",
    line(band.themes),
    "",
    "## Discography",
    "",
    ...(band.albums.length ? band.albums.map((one) => `- ${one.year} · ${one.title}`) : ["- (first album on its way)"]),
    "",
  ].join("\n");
}

const MEMBERS_SYSTEM = [
  "You cast the members of a fictional band (or the one person behind a solo act) for an AI record label.",
  "Everyone is invented: never a real person, never a lookalike of one. Give each a full name, their role, and a look described",
  "precisely enough that an illustrator could draw the same person every time. Start every look with their gender and age (\"woman, 24, ...\"), then face, skin tone, hair, build, signature outfit and accessories.",
  "Answer as JSON: {\"members\": [{\"name\": \"\", \"role\": \"\", \"look\": \"at most 300 characters\", \"voice\": \"how they sing or play, at most 150 characters\",",
  "\"personality\": \"at most 150 characters\", \"influences\": \"styles and eras, never named artists, at most 120 characters\", \"bio\": \"one or two sentences\"}]}.",
].join(" ");

/** The band's people, invented once: one for a solo act, three to five for a band. */
export async function inventMembers(
  band: { name: string; genre: string; sound: string; voice: string; bio: string },
  ask: typeof askJson,
): Promise<Member[]> {
  const answer = await ask({
    system: MEMBERS_SYSTEM,
    prompt: [
      `Act: ${band.name} (${band.genre})`,
      `Sound: ${band.sound}`,
      `Lead voice: ${band.voice}`,
      band.bio ? `Who they are: ${band.bio}` : "",
      "If the name reads as one person's, cast that one person as the solo artist (role: vocals and the instrument that fits); otherwise cast the band, the lead singer first, matching the lead voice.",
    ].filter(Boolean).join("\n"),
    maxTokens: 2000,
    timeoutMs: 90_000,
  });
  const list = Array.isArray(answer.value["members"]) ? answer.value["members"] as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const members = list
    .map((one) => {
      const name = line(String(one?.["name"] ?? "")).slice(0, 60);
      return {
        slug: memberSlug(name), name,
        role: line(String(one?.["role"] ?? "")).slice(0, 80),
        look: line(String(one?.["look"] ?? "")).slice(0, 500),
        voice: line(String(one?.["voice"] ?? "")).slice(0, 300),
        personality: line(String(one?.["personality"] ?? "")).slice(0, 300),
        influences: line(String(one?.["influences"] ?? "")).slice(0, 200),
        bio: line(String(one?.["bio"] ?? "")).slice(0, 500),
      };
    })
    .filter((one) => one.name && one.look.length > 20 && !seen.has(one.slug) && seen.add(one.slug))
    .slice(0, 6);
  if (members.length === 0) throw new Error("the model cast nobody");
  return members;
}

/** How the band looks on stage, for a cover or a scene: every member by name, role and look. */
export function castLine(members: Member[]): string {
  return members.map((one) => `${one.name} (${one.role}): ${one.look}`).join("; ");
}

/** The portrait prompt for a member: the same person every time it is used as a reference. */
export function portraitPrompt(member: Member, band: { name: string; genre: string }): string {
  return `Photographic portrait of ${member.name}: ${member.look}. ${member.role} in the ${band.genre} band ${band.name}. Head and shoulders, three-quarter view, natural expression, soft studio light, plain dark background, sharp focus, 85mm lens. No text, no logos.`;
}

/** Writes the member pages and portraits that are missing; returns the members as the pages now say. */
export async function writeMembers(folder: string, members: Member[], band: { name: string; genre: string; holder: string }, draw: ((prompt: string) => Promise<Buffer | null>) | null): Promise<Member[]> {
  const dir = join(folder, "members");
  mkdirSync(dir, { recursive: true });
  const out: Member[] = [];
  for (const member of members) {
    const page = join(dir, `${member.slug}.md`);
    let current = member;
    try {
      current = readMember(readFileSync(page, "utf8"), member.slug) ?? member;
    } catch {
      writeFileSync(page, memberMarkdown(member, band));
    }
    const portrait = join(dir, `${member.slug}.jpg`);
    let drawn = true;
    try { readFileSync(portrait); } catch { drawn = false; }
    if (!drawn && draw) {
      const picture = await draw(portraitPrompt(current, band)).catch(() => null);
      if (picture) writeFileSync(portrait, picture);
    }
    out.push(current);
  }
  return out;
}

/** The members as their pages say now (hand edits included), in the order given. */
export function readMembers(folder: string, slugs: string[]): Member[] {
  return slugs.flatMap((slug) => {
    try {
      const member = readMember(readFileSync(join(folder, "members", `${slug}.md`), "utf8"), slug);
      return member ? [member] : [];
    } catch {
      return [];
    }
  });
}
