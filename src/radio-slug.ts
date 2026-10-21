/**
 * The readable names /radio pages go by: a station, an artist, an album.
 *
 * Shared by the server (which owns the names) and the station page's script
 * (which links the artist and album on the air), so the two always agree.
 * No imports: the web bundle carries this file as it is.
 */

/** Letters NFKD does not take apart. */
const SPELLED: Record<string, string> = { þ: "th", ð: "d", ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ł: "l", ı: "i", "&": " and " };

/** Lower-case ASCII words joined by "-", at most `max` characters, cut at a word. */
export function slugify(text: string, max = 60): string {
  const plain = String(text ?? "")
    .toLowerCase()
    .replace(/[þðøæœßđłı&]/g, (one) => SPELLED[one] ?? one)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max + 1);
  const at = cut.lastIndexOf("-");
  return (at > 8 ? cut.slice(0, at) : plain.slice(0, max)).replace(/-+$/, "");
}

/**
 * A station's name as a path: "Profullstack AI · Metal" is ai-metal, "Roaring
 * Twenties: Jazz, Blues & Dance" is roaring-twenties (what comes before a
 * colon, when that is two words or more), "Public Domain Classical" is
 * public-domain-classical.
 */
export function stationSlug(name: string): string {
  const text = String(name ?? "").trim();
  const ai = /^.{0,60}?\bAI\s*[·:|•\-–—]\s*(.+)$/i.exec(text);
  if (ai) return slugify(`ai ${ai[1]}`, 48) || "station";
  const colon = /^([^:]{3,}):\s*\S/.exec(text);
  if (colon && colon[1]!.trim().split(/\s+/).length >= 2) return slugify(colon[1]!, 48) || "station";
  return slugify(text, 48) || "station";
}

export const artistSlug = (artist: string): string => slugify(String(artist ?? "").split(/\s*;\s*/)[0] ?? "", 60);

export const albumSlug = (artist: string, album: string): string => slugify(`${artistSlug(artist)} ${album}`, 90);
