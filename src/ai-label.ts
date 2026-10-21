/**
 * The AI label: a roster of original artists who put out albums on their own.
 *
 * Where AI radio (ai-radio.ts) is a station that grows a track at a time, the
 * label is a record company in miniature. Each artist has a name, a genre, a
 * sound and a voice. When an artist is due -- its first albums at once, then
 * one every `everyDays` -- a language model plans an album (a title, a
 * concept, a running order with a brief per song), writes each song's words
 * in English, and a music model sings them. Every song lands as
 *
 *     <root>/<genre>/<artist>/<year>-<album>/001. <title>.mp3
 *     <root>/<genre>/<artist>/<year>-<album>/001. <title>.lyrics.txt
 *
 * with the album's cover.jpg and album.json beside them, tagged with the
 * artist, album, track number, the words (so lyrics-publish.ts sends them to
 * nichedb) and the label's rights holder as publisher and copyright. Each
 * genre is one station on the public guide, kept in step as songs land, and
 * the whole catalogue has a page anybody can read and play (label-routes.ts).
 *
 * Planning is saved before anything is composed, and each song is composed on
 * its own, so a restart, a failure or a month's cap resumes where it stopped.
 * Composition is metered in seconds a month like AI radio, and a provider out
 * of credit pauses the label until the owner resumes it.
 *
 * The rights holder's declaration is what makes the music "owned" here; it is
 * not legal clearance, and how much of a machine's work copyright covers is
 * the holder's question to settle.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { aiKey } from "./ai-keys.ts";
import { composerFromEnv, OutOfCredit, type Composer } from "./ai-radio.ts";
import { askJson, hasModel } from "./ai-text.ts";
import type { LibraryIndex, Probed } from "./library-index.ts";
import type { StationRunner } from "./station-runner.ts";
import { StationError, type StationStore } from "./stations.ts";

export interface LabelSong {
  /** Its place on the album, from 1. */
  n: number;
  title: string;
  /** The production brief the music model is given beside the artist's sound. */
  style: string;
  /** The words, with [Verse]/[Chorus] section lines; "" until written. */
  lyrics: string;
  seconds: number;
  /** The MP3, "" until composed. */
  file: string;
  lyricsFile: string;
  /** Its music video (001. <title>.mp4), "" until made; absent on songs from before videos. */
  video?: string;
  /** Who wrote the words and who sang them, e.g. "llama-3.3 + elevenlabs/music_v2_5". */
  made: string;
  composedAt: number;
}

export interface LabelAlbum {
  key: string;
  title: string;
  year: number;
  concept: string;
  /** The album's folder. */
  folder: string;
  /** cover.jpg in the folder, "" when there is none. */
  cover: string;
  coverTried: boolean;
  songs: LabelSong[];
  /** Which model planned it. */
  writer: string;
  plannedAt: number;
  /** When its last song landed; 0 while it is being made. */
  doneAt: number;
}

export interface LabelArtist {
  key: string;
  name: string;
  genre: string;
  /** The music in words: every song's brief starts from it. */
  sound: string;
  /** The lead voice. */
  voice: string;
  bio: string;
  /** What the songs are about. */
  themes: string;
  enabled: boolean;
  albums: LabelAlbum[];
  createdAt: number;
  lastAttemptAt: number;
  lastError: string;
  failures: number;
}

export interface LabelSettings {
  /** Who holds the rights: publisher and copyright on every file, and the station's declaration. */
  holder: string;
  enabled: boolean;
  /** Seconds of music a month across the label; 0 for no cap. */
  monthlySeconds: number;
  /** Days between an artist's albums once it has its first ones (only when albumsPerDay is 0). */
  everyDays: number;
  /**
   * Once every artist has its first albums: new albums a day across the label,
   * each by an artist picked at random or, now and then, a new one invented
   * in one of the owner's genres. 0 goes back to one per artist every everyDays.
   */
  albumsPerDay: number;
  /** How often (0-1) the day's album is by a newly invented artist. */
  newArtistChance: number;
  /** Albums every artist gets as soon as it can. */
  seedAlbums: number;
  songsPerAlbum: number;
  songSeconds: number;
  /** A music video for every song (the cover over itself, blurred, and the song's waveform), and a TV station of them. */
  videos: boolean;
  /** Public, listed and owned, so the genre stations are on the guide. */
  publish: boolean;
  /** Songs made at the same time (ElevenLabs takes several requests at once on a paid plan). */
  parallel: number;
  /** Genres whose artists get their albums first, in this order. */
  genreOrder: string[];
  /** Set by a provider that is out of credit; cleared by `resume`. */
  pausedReason: string;
}

export type ArtistPreset = Pick<LabelArtist, "name" | "genre" | "sound" | "voice" | "bio" | "themes">;

/**
 * The label's first roster: invented names, one genre each, sung in English.
 * `nixamp station label artist add --preset KEY`, or all of them with `--roster`.
 */
export const ROSTER: Record<string, ArtistPreset> = {
  "velvet-ruckus": {
    name: "Velvet Ruckus", genre: "Rock",
    sound: "gritty alternative rock, crunchy overdriven guitars, big room drums, melodic bass, anthemic choruses, 120-150 BPM",
    voice: "raspy, powerful female alto with a wide belt and a little growl",
    bio: "A four-piece that sounds like a basement show that got too big for the basement.",
    themes: "small-town escape, late shifts, loyalty, burning bridges and building better ones",
  },
  "juno-kincaid": {
    name: "Juno Kincaid", genre: "Hip-Hop",
    sound: "modern boom-bap hip hop, dusty sampled-sounding keys, hard swung drums, deep 808s, vinyl texture, 85-95 BPM",
    voice: "confident male rapper, clear diction, warm low register, conversational flow with sung hooks",
    bio: "A night-bus storyteller who raps like he is reading you his diary on the last train home.",
    themes: "ambition, city nights, family, hustle and doubt, coming up from nothing",
  },
  "chrome-orchard": {
    name: "Chrome Orchard", genre: "Synthwave",
    sound: "retro 80s synthwave, gated reverb drums, analog bass arpeggios, lush neon pads, soaring lead synth, 100-118 BPM",
    voice: "airy male tenor, slightly reverbed, wistful and cinematic",
    bio: "Soundtracks for a film about driving that nobody has made yet.",
    themes: "night drives, neon cities, lost summers, the future we were promised",
  },
  "delta-wren": {
    name: "Delta Wren", genre: "Country",
    sound: "modern country and Americana, acoustic and electric guitars, pedal steel, fiddle, warm bass, steady backbeat, 80-110 BPM",
    voice: "clear, twangy female soprano with heart and a little grit",
    bio: "A porch-light songwriter with a pickup truck full of second chances.",
    themes: "back roads, hometowns, heartbreak and healing, working hands, Saturday nights",
  },
  "ashen-cartography": {
    name: "Ashen Cartography", genre: "Metal",
    sound: "melodic metalcore, down-tuned chugging riffs, twin lead guitars, blast beats into half-time breakdowns, cinematic synths, 140-180 BPM",
    voice: "male vocalist alternating fierce harsh screams in the verses with soaring clean singing in the choruses",
    bio: "Maps of places that burned down, drawn at full volume.",
    themes: "ruins, resilience, storms, rebuilding from ashes, defiance",
  },
  "iron-lantern-society": {
    name: "Iron Lantern Society", genre: "Classic Rock",
    sound: "bluesy classic hard rock, swaggering riffs, Hammond organ, cowbell grooves, big guitar solos, 100-128 BPM",
    voice: "gravelly male baritone with a wide rasp and a rock-and-roll howl",
    bio: "Five road dogs who think every song should end in a bar fight or a sunrise.",
    themes: "the open road, hard luck, loyalty among misfits, last calls and new starts",
  },
  "highway-sermon": {
    name: "Highway Sermon", genre: "Classic Rock",
    sound: "1970s classic rock, twin harmony lead guitars, warm analog bass, piano, big open drums, arena choruses, 96-124 BPM",
    voice: "soaring, slightly raspy male tenor with a wide vibrato",
    bio: "Four friends who found a crate of their fathers' records and never gave them back.",
    themes: "freedom, the open highway, small-town legends, love and leaving",
  },
  "copper-jubilee": {
    name: "Copper Jubilee", genre: "Classic Rock",
    sound: "southern classic rock, slide guitar, honky-tonk piano, Hammond organ, swampy groove, gospel backing vocals, 88-116 BPM",
    voice: "powerful bluesy female belter with grit and gospel runs",
    bio: "A riverboat revue that plugged in and turned it up.",
    themes: "rivers, revival nights, rebellion, home cooking and heartbreak",
  },
  "the-bent-spokes": {
    name: "The Bent Spokes", genre: "Punk",
    sound: "fast melodic skate punk, palm-muted power chords, driving eighth-note bass, snappy double-time drums, gang vocal choruses, 180-210 BPM",
    voice: "snotty, energetic male tenor with shouted group backing vocals",
    bio: "Three teenagers who never stopped being teenagers, and a drummer who might be a skateboard.",
    themes: "boredom, suburbia, friendship, skipping school, refusing to grow up",
  },
  "gutter-velvet": {
    name: "Gutter Velvet", genre: "Punk",
    sound: "raw street punk, distorted buzzsaw guitars, thumping bass, stomping drums, chant-along choruses, 160-190 BPM",
    voice: "furious, raspy female shouter with a sneer",
    bio: "Born in a squat, raised on a photocopier.",
    themes: "rent, landlords, solidarity, the city at 3 a.m., not backing down",
  },
  "no-refunds": {
    name: "No Refunds", genre: "Punk",
    sound: "pop punk, bright crunchy guitars, bouncy bass, big singalong hooks, half-time bridges, 160-185 BPM",
    voice: "catchy, slightly nasal male lead with harmonized choruses",
    bio: "Mall-parking-lot punk with a heart of gold and a dented van.",
    themes: "crushes, bad jobs, summer, best friends, second chances",
  },
  "muddy-ledger": {
    name: "Muddy Ledger", genre: "Blues",
    sound: "electric Chicago blues, stinging lead guitar, harmonica, walking bass, shuffle drums, slow 12-bar and mid-tempo shuffles, 60-110 BPM",
    voice: "deep, gravelly male baritone with call-and-response guitar",
    bio: "Plays like he owes the guitar money.",
    themes: "hard times, trains, lost love, payday, getting even",
  },
  "delta-ruby": {
    name: "Delta Ruby", genre: "Blues",
    sound: "soulful blues, Hammond organ, horn section, slow-burning guitar, brushed and backbeat drums, 60-100 BPM",
    voice: "rich, powerful female contralto with soaring gospel-blues phrasing",
    bio: "A juke-joint queen with a voice that rattles the windows.",
    themes: "heartbreak, strength, the river, Saturday night, survival",
  },
  "rattlesnake-porch": {
    name: "Rattlesnake Porch", genre: "Blues",
    sound: "acoustic delta blues, slide resonator guitar, foot stomps, harmonica, hand claps, 70-110 BPM",
    voice: "weathered male voice, half-sung, half-spoken storytelling",
    bio: "A porch, a slide and a hundred stories, all of them true enough.",
    themes: "crossroads, floods, the devil's bargains, home, honest work",
  },
  "blue-hour-quartet": {
    name: "The Blue Hour Quartet", genre: "Jazz",
    sound: "smoky vocal jazz, upright bass, brushed drums, piano trio comping, muted trumpet solos, swing and ballads, 70-140 BPM",
    voice: "velvety female jazz alto with relaxed phrasing and occasional scat",
    bio: "A jazz club that only opens after the last train leaves.",
    themes: "late nights, rain on windows, old flames, city lights, small joys",
  },
  "sterling-hayes": {
    name: "Sterling Hayes", genre: "Jazz",
    sound: "big band swing and crooner jazz, brass section, walking bass, swing drums, lush strings on ballads, 100-180 BPM",
    voice: "smooth, warm male crooner baritone",
    bio: "A crooner who never got the memo that it isn't 1958.",
    themes: "romance, dancing, champagne nights, wistful goodbyes",
  },
  "nightcap-collective": {
    name: "Nightcap Collective", genre: "Jazz",
    sound: "modern soul-jazz, Rhodes piano, tenor sax, laid-back hip hop influenced drums, warm bass, 80-100 BPM",
    voice: "silky male and female duet vocals trading verses",
    bio: "A rotating cast of night owls who meet at the same bar every Thursday.",
    themes: "slow evenings, conversation, love that takes its time, the city after dark",
  },
  "satin-avenue": {
    name: "Satin Avenue", genre: "R&B",
    sound: "smooth modern R&B, lush chords, deep 808s, crisp snaps, warm synth pads, falsetto ad-libs, 65-90 BPM",
    voice: "silky female R&B soprano with agile runs",
    bio: "Late-night R&B for the drive home after a long week.",
    themes: "love, trust, self-worth, late-night phone calls",
  },
  "jalen-reign": {
    name: "Jalen Reign", genre: "R&B",
    sound: "neo-soul and contemporary R&B, live bass, Rhodes, tight pocket drums, gospel-tinged harmonies, 70-95 BPM",
    voice: "warm, soulful male tenor with a smooth falsetto",
    bio: "Church-raised, club-tested, heart on his sleeve.",
    themes: "devotion, apologies, growing together, Sunday mornings",
  },
  "paper-satellites": {
    name: "Paper Satellites", genre: "Rock",
    sound: "jangly indie rock, chorus-drenched guitars, driving eighth-note bass, crisp drums, shout-along choruses, 130-160 BPM",
    voice: "earnest male tenor, slightly nasal, with gang vocals in the choruses",
    bio: "Bedroom recordings that grew up and got a van.",
    themes: "growing up, small apartments, friendship, leaving and coming back",
  },
  "mira-solace": {
    name: "Mira Solace", genre: "Hip-Hop",
    sound: "melodic modern trap, airy pads, rolling hi-hats, sliding 808s, sparse piano, 130-145 BPM half-time",
    voice: "confident female rapper with a smoky tone who switches to sung melodic hooks",
    bio: "Writes verses on her phone between shifts and performs them like a closing argument.",
    themes: "self-belief, heartbreak turned into fuel, sisterhood, getting paid",
  },
  "cold-brew-cipher": {
    name: "Cold Brew Cipher", genre: "Hip-Hop",
    sound: "jazzy laid-back hip hop, upright bass, muted trumpet, dusty drum breaks, vinyl warmth, 84-92 BPM",
    voice: "relaxed male rapper with a warm baritone, wordplay-heavy, with a soulful sung chorus",
    bio: "A coffee-shop cipher that never closed.",
    themes: "slow mornings, neighbourhood characters, gratitude, wit and wordplay",
  },
  "vapor-meridian": {
    name: "Vapor Meridian", genre: "Synthwave",
    sound: "dark synthwave, pulsing bass sequences, cold arpeggios, gated snares, cinematic swells, 90-110 BPM",
    voice: "cool, breathy female alto, close-miked and haunting",
    bio: "The soundtrack to a neon noir that only exists after midnight.",
    themes: "rain-soaked cities, secrets, rogue machines, love in the static",
  },
  "static-riviera": {
    name: "Static Riviera", genre: "Synthwave",
    sound: "sunny outrun synthwave, bright saw leads, funky slap bass, sax hooks, sunset pads, 110-124 BPM",
    voice: "smooth male tenor with a touch of vocoder on the hooks",
    bio: "A beach-town cassette left in the sun since 1986.",
    themes: "summer nights, coastal highways, arcades, retro romance",
  },
  "boone-calloway": {
    name: "Boone Calloway", genre: "Country",
    sound: "outlaw country, twangy Telecaster, train-beat drums, honky-tonk piano, dobro, 90-120 BPM",
    voice: "deep, weathered male baritone with a slow drawl",
    bio: "Sings like he has been thrown out of every bar in three counties and misses all of them.",
    themes: "freedom, regret, dusty highways, family, whiskey and redemption",
  },
  "gravel-hollow": {
    name: "The Gravel Hollow Band", genre: "Country",
    sound: "bluegrass and Americana, banjo rolls, mandolin chops, fiddle, upright bass, stacked harmonies, 100-140 BPM",
    voice: "a lead male tenor with tight three-part mountain harmonies",
    bio: "A porch band that never learned to play quietly.",
    themes: "mountains, rivers, hard work, faith, homecoming",
  },
  "hollow-sovereign": {
    name: "Hollow Sovereign", genre: "Metal",
    sound: "symphonic doom metal, crushing slow riffs, choirs, strings, thundering double-kick climaxes, 60-90 BPM",
    voice: "soaring operatic female soprano over deep male growled counterpoints",
    bio: "A cathedral of riffs built in the ruins of a kingdom that never was.",
    themes: "fallen empires, myth, grief, endurance, crowns and chains",
  },
  "rust-cathedral": {
    name: "Rust Cathedral", genre: "Metal",
    sound: "fast thrash metal, palm-muted gallop riffs, shredding solos, pounding double kick, 180-220 BPM",
    voice: "aggressive male shout-singing with high screams",
    bio: "Factory-floor thrash forged from overtime and broken machines.",
    themes: "industry, rebellion, machines, the working class fighting back",
  },
  "theo-marlowe": {
    name: "Theo Marlowe", genre: "Pop",
    sound: "groovy funk-pop, slap bass, tight disco drums, bright brass stabs, falsetto hooks, 112-122 BPM",
    voice: "smooth male pop tenor with a playful falsetto",
    bio: "A charmer with a dance floor in his back pocket.",
    themes: "flirting, confidence, summer romance, good nights out",
  },
  "glass-hearts-club": {
    name: "Glass Hearts Club", genre: "Pop",
    sound: "shimmering synth-pop, gated drums, glassy synths, big layered chorus vocals, 118-128 BPM",
    voice: "a trio of bright female voices trading lines and stacking harmonies",
    bio: "Three best friends turning group chats into choruses.",
    themes: "friendship, crushes, breakups survived together, dancing until the lights come on",
  },
  "lumi-kestrel": {
    name: "Lumi Kestrel", genre: "Pop",
    sound: "bright modern dance pop, punchy four-on-the-floor drums, glossy synths, plucky guitar, big pre-chorus lifts, 110-124 BPM",
    voice: "bright, agile female pop soprano with breathy verses and a powerful chorus",
    bio: "Glitter on the outside, journal entries on the inside.",
    themes: "first nights out, confidence, crushes, friendship, dancing it off",
  },
};

export const DEFAULTS: Omit<LabelSettings, "pausedReason"> = {
  holder: "Profullstack, Inc.",
  enabled: true,
  monthlySeconds: 3600,
  everyDays: 30,
  albumsPerDay: 1,
  newArtistChance: 0.25,
  seedAlbums: 1,
  songsPerAlbum: 8,
  songSeconds: 150,
  publish: true,
  videos: true,
  parallel: 1,
  genreOrder: ["Punk", "Blues", "Country", "Jazz", "Classic Rock", "Metal", "Hip-Hop", "Pop", "R&B"],
};

const DAY = 86_400_000;
/** Between tries after a failure: 5 min, doubling, at most 6 h. */
const BACKOFF_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 40 * 60_000, 80 * 60_000, 6 * 3600_000];

/** A name as a folder or file name: what a filesystem or a zip refuses is dropped. */
export function fileName(text: string): string {
  return text.normalize("NFC").replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 100).trim() || "Untitled";
}

/** A genre's folder and station key: "Hip-Hop" is hip-hop, "R&B" is rnb. */
export function genreSlug(genre: string): string {
  return genre.normalize("NFKD").toLowerCase().replace(/&/g, "n").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "music";
}

/** "001. Title", the start of a song's file names. */
export function songBase(song: Pick<LabelSong, "n" | "title">): string {
  return `${String(song.n).padStart(3, "0")}. ${fileName(song.title)}`;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

/** Words as a singer gets them: section lines kept, the model's own notes and fences dropped. */
export function cleanLyrics(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^```[a-z]*\n?|```$/gm, "")
    .split("\n")
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 3000);
}

const PLAN_SYSTEM = [
  "You are the A&R director and lead songwriter of an independent record label whose artists are AI.",
  "Everything is original: never name, quote or imitate a real artist, band, song, album or label. Write in English.",
  "Plan one album. Answer as JSON: {\"title\": \"1-6 words\", \"concept\": \"what the album is about, at most 300 characters\",",
  "\"songs\": [{\"title\": \"1-6 words\", \"style\": \"the production brief for this song, at most 300 characters: tempo in BPM, mood, key or mode, featured instruments, arrangement\"}]}.",
  "Vary tempo, mood and arrangement across the running order, within the artist's sound; open strong, end memorable.",
].join(" ");

const LYRICS_SYSTEM = [
  "You write original English song lyrics for an AI singer. Never quote or imitate an existing song and never name a real artist.",
  "Put each section tag on its own line: [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro].",
  "Use two verses of four lines, a four-line chorus sung two or three times, a pre-chorus of two lines and a bridge of two to four lines; vivid, specific, singable lines that rhyme where it sounds natural. Never just one line under a section.",
  "Only the words that are sung, no stage directions or notes. Answer as JSON: {\"lyrics\": \"the lyrics, lines separated by \\n\"}.",
].join(" ");

export async function planAlbum(
  artist: Pick<LabelArtist, "name" | "genre" | "sound" | "voice" | "bio" | "themes" | "albums">,
  songs: number,
  ask: typeof askJson = askJson,
): Promise<{ title: string; concept: string; songs: Array<{ title: string; style: string }>; model: string }> {
  const before = artist.albums.slice(-4).map((one) => `"${one.title}" (${one.songs.map((song) => song.title).join("; ")})`);
  const answer = await ask({
    system: PLAN_SYSTEM,
    prompt: [
      `Artist: ${artist.name}`,
      `Genre: ${artist.genre}`,
      `Sound: ${artist.sound}`,
      `Voice: ${artist.voice}`,
      artist.bio ? `Who they are: ${artist.bio}` : "",
      artist.themes ? `What they sing about: ${artist.themes}` : "",
      before.length ? `Albums already out (do not reuse their titles or song titles; take the story somewhere new): ${before.join(" | ")}` : "This is the artist's debut album.",
      `The album has exactly ${songs} songs.`,
    ].filter(Boolean).join("\n"),
    maxTokens: 2048,
    timeoutMs: 90_000,
  });
  const title = clean(answer.value["title"], 80).replace(/"/g, "");
  const concept = clean(answer.value["concept"], 400);
  const list = Array.isArray(answer.value["songs"]) ? answer.value["songs"] as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const planned = list
    .map((one) => ({ title: clean(one?.["title"], 80).replace(/"/g, ""), style: clean(one?.["style"], 400) }))
    .filter((one) => one.title && one.style && !seen.has(one.title.toLowerCase()) && seen.add(one.title.toLowerCase()))
    .slice(0, songs);
  if (!title || planned.length < Math.min(3, songs)) throw new Error("the model planned no album (a title and at least three songs)");
  return { title, concept, songs: planned, model: answer.model };
}

const ARTIST_SYSTEM = [
  "You invent original recording artists for an independent record label whose artists are AI and sing in English.",
  "The name must be new: never a real artist, band or label, and never imitating one.",
  "Answer as JSON: {\"name\": \"1-4 words\", \"sound\": \"the music in words, at most 300 characters: subgenre, instruments, production, tempo in BPM\",",
  "\"voice\": \"the lead voice, at most 150 characters\", \"bio\": \"one striking sentence\", \"themes\": \"what they sing about, at most 150 characters\"}.",
].join(" ");

/** A new artist for this genre, unlike the ones already signed. */
export async function inventArtist(genre: string, taken: string[], ask: typeof askJson = askJson): Promise<ArtistPreset> {
  const answer = await ask({
    system: ARTIST_SYSTEM,
    prompt: `Genre: ${genre}\nAlready on the label (do not reuse or echo these names or sounds): ${taken.slice(-40).join(", ") || "nobody yet"}`,
    maxTokens: 600,
    timeoutMs: 60_000,
  });
  const name = clean(answer.value["name"], 60).replace(/"/g, "");
  const sound = clean(answer.value["sound"], 400);
  if (!name || sound.length < 10) throw new Error("the model invented no artist");
  if (taken.some((one) => one.toLowerCase() === name.toLowerCase())) throw new Error(`the model reused the name ${name}`);
  return { name, genre, sound, voice: clean(answer.value["voice"], 200) || "expressive lead vocal", bio: clean(answer.value["bio"], 300), themes: clean(answer.value["themes"], 200) };
}

export async function writeLyrics(
  artist: Pick<LabelArtist, "name" | "genre" | "voice" | "themes">,
  album: Pick<LabelAlbum, "title" | "concept">,
  song: Pick<LabelSong, "title" | "style" | "seconds">,
  ask: typeof askJson = askJson,
): Promise<{ lyrics: string; model: string }> {
  const answer = await ask({
    system: LYRICS_SYSTEM,
    prompt: [
      `Artist: ${artist.name} (${artist.genre}); voice: ${artist.voice}`,
      artist.themes ? `What they sing about: ${artist.themes}` : "",
      `Album: "${album.title}"${album.concept ? `: ${album.concept}` : ""}`,
      `Song: "${song.title}": ${song.style}`,
      `The song lasts about ${song.seconds} seconds: keep the words under ${Math.max(600, Math.round(song.seconds * 10))} characters.`,
    ].filter(Boolean).join("\n"),
    maxTokens: 1500,
    timeoutMs: 90_000,
  });
  const lyrics = cleanLyrics(String(answer.value["lyrics"] ?? ""));
  if (lyrics.replace(/\[[^\]]*\]/g, "").trim().length < 40) throw new Error("the model wrote no lyrics");
  return { lyrics, model: answer.model };
}

/**
 * A cover from Cloudflare Workers AI (flux-1-schnell), when the language model
 * slot is Workers AI (NIXAMP_OPENAI_URL is an account's /ai/v1 and
 * OPENAI_API_KEY its token); null when there is no image model to ask.
 */
export async function workersAiCover(prompt: string, env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<Buffer | null> {
  const account = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/([A-Za-z0-9]+)\/ai\/v1\/?$/.exec(aiKey("NIXAMP_OPENAI_URL", env))?.[1];
  const token = aiKey("OPENAI_API_KEY", env);
  if (!account || !token) return null;
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`, {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 8 }),
  });
  if (!response.ok) throw new Error(`the cover model answered HTTP ${response.status}`);
  const body = await response.json() as { result?: { image?: string } };
  const image = body.result?.image ? Buffer.from(body.result.image, "base64") : null;
  if (!image || image.length < 1024) throw new Error("the cover model answered with no picture");
  return image;
}

/** Writes the tags (and the cover, as the attached picture) into a copy of the file. */
/**
 * A song's music video: its album cover over a blurred copy of itself, the
 * song's waveform along the bottom, 720p H.264 with the MP3's audio copied in.
 * Without a cover, a dark plate.
 */
export function renderVideo(ffmpeg: string[], audio: string, cover: string, out: string): Promise<void> {
  const picture = cover ? ["-loop", "1", "-framerate", "25", "-i", cover] : ["-f", "lavfi", "-i", "color=c=0x0d1410:s=1280x720:r=25"];
  const graph = [
    "[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,boxblur=24:2,eq=brightness=-0.18[bg]",
    "[0:v]scale=500:500[fg]",
    "[1:a]showwaves=s=1280x150:mode=cline:rate=25:colors=white@0.85,format=rgba,colorkey=0x000000:0.1:0[viz]",
    "[bg][fg]overlay=(W-w)/2:40[a]",
    "[a][viz]overlay=0:H-160,format=yuv420p[v]",
  ].join(";");
  const args = [...ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-y", ...picture, "-i", audio, "-filter_complex", graph,
    "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-r", "25", "-c:a", "copy", "-shortest", "-movflags", "+faststart", out];
  return new Promise((done, fail) => {
    execFile(ffmpeg[0]!, args, { timeout: 20 * 60_000 }, (error) => (error ? fail(new Error(`the video failed: ${error.message}`)) : done()));
  });
}

function tagFile(ffmpeg: string[], from: string, to: string, tags: Record<string, string>, cover: string): Promise<void> {
  const args = [...ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-y", "-i", from];
  if (cover) args.push("-i", cover, "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic");
  else args.push("-map", "0:a", "-c", "copy");
  args.push("-id3v2_version", "3");
  for (const [name, value] of Object.entries(tags)) args.push("-metadata", `${name}=${value}`);
  args.push(to);
  return new Promise((done, fail) => {
    execFile(ffmpeg[0]!, args, { timeout: 120_000 }, (error) => (error ? fail(new Error(`tagging failed: ${error.message}`)) : done()));
  });
}

function monthOf(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export interface AiLabelDeps {
  index: LibraryIndex;
  store: StationStore;
  runner: StationRunner;
  probe: (path: string) => Promise<Probed>;
  ffmpeg: string[];
  /** Where the label's music goes: <root>/<genre>/<artist>/<year>-<album>/. */
  root: string;
  owner: string;
  mayStart: () => boolean;
  composer?: () => Composer | null;
  ask?: typeof askJson;
  canAsk?: () => boolean;
  /** A cover picture for this prompt, or null when nothing can draw one. */
  cover?: (prompt: string) => Promise<Buffer | null>;
  tag?: (from: string, to: string, tags: Record<string, string>, cover: string) => Promise<void>;
  /** Renders a song's music video to `out`; ffmpeg by default (renderVideo). */
  video?: (audio: string, cover: string, out: string) => Promise<void>;
  /** The day's pick (artist, genre, new or not); Math.random by default. */
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
}

/** What one step of the schedule did. */
type Step = "composed" | "planned" | "idle";

export class AiLabel {
  private artists = new Map<string, LabelArtist>();
  private settings: LabelSettings = { ...DEFAULTS, pausedReason: "" };
  private usage: Record<string, number> = {};
  private running = false;
  /** Songs being made now, by `<album>:<n>`. */
  private claims = new Map<string, { label: string; seconds: number }>();
  /** Artists whose next album is being planned now. */
  private planning = new Set<string>();
  private covering = new Map<string, Promise<void>>();
  private filming: Promise<number> | null = null;
  /** Songs whose video failed since this server started. */
  private videoFailed = new Set<string>();
  /** The day's album is tried at most every 30 minutes, so a failing model is not hammered. */
  private dailyTriedAt = 0;
  /** Genre stations are kept in step one change at a time. */
  private placing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly file: string, private readonly deps: AiLabelDeps) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { artists?: LabelArtist[]; settings?: Partial<LabelSettings>; usage?: Record<string, number> };
      for (const one of parsed.artists ?? []) if (one?.key) this.artists.set(one.key, { ...one, albums: one.albums ?? [] });
      this.settings = { ...this.settings, ...(parsed.settings ?? {}) };
      this.usage = parsed.usage ?? {};
    } catch {
      // Nothing yet.
    }
  }

  static fileFor(stateDir: string, port: number): string {
    return join(stateDir, `ai-label-${port}.json`);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.deps.log?.(`  ai label: ${line}`);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 1, settings: this.settings, usage: this.usage, artists: [...this.artists.values()] }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private composer(): Composer | null {
    return this.deps.composer ? this.deps.composer() : composerFromEnv();
  }

  private canAsk(): boolean {
    return (this.deps.canAsk ?? hasModel)();
  }

  /** The library source the root is in: the one that already holds it, else a managed one of its own. */
  private source(): string {
    const root = resolve(this.deps.root);
    mkdirSync(root, { recursive: true });
    const holding = this.deps.index.sources().find((one) => one.enabled && (root === one.root || root.startsWith(one.root + sep)));
    return (holding ?? this.deps.index.addManagedSource(root)).id;
  }

  get root(): string {
    return resolve(this.deps.root);
  }

  list(): LabelArtist[] {
    return [...this.artists.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(key: string): LabelArtist | undefined {
    return this.artists.get(key);
  }

  holder(): string {
    return this.settings.holder;
  }

  private budgetLeft(): number {
    if (this.settings.monthlySeconds === 0) return Number.POSITIVE_INFINITY;
    return this.settings.monthlySeconds - (this.usage[monthOf(this.now())] ?? 0);
  }

  /** When this artist's next album is due: its first ones at once, then every `everyDays`, staggered by artist. */
  dueAt(artist: LabelArtist): number {
    if (!artist.enabled) return -1;
    if (artist.albums.length < this.settings.seedAlbums) return 0;
    // On the daily schedule an artist's next album is whenever the day's pick lands on it.
    if (this.settings.albumsPerDay > 0) return -1;
    const last = artist.albums[artist.albums.length - 1]!;
    const stagger = (parseInt(artist.key.slice(0, 6), 16) % Math.max(1, Math.floor(this.settings.everyDays / 4))) * DAY;
    return last.plannedAt + this.settings.everyDays * DAY + stagger;
  }

  private backingOff(artist: LabelArtist, now: number): boolean {
    return artist.failures > 0 && now < artist.lastAttemptAt + BACKOFF_MS[Math.min(artist.failures, BACKOFF_MS.length) - 1]!;
  }

  status(): Record<string, unknown> {
    const month = monthOf(this.now());
    const composer = this.composer();
    const why = !this.settings.enabled ? "the label is switched off"
      : this.settings.pausedReason
        || (composer ? "" : "no composer: set ELEVENLABS_API_KEY (nixamp station ai key ELEVENLABS_API_KEY) or NIXAMP_AI_MUSIC_COMMAND")
        || (this.canAsk() ? "" : "no language model to write the albums: set GEMINI_API_KEY, OPENAI_API_KEY (or NIXAMP_OPENAI_URL) or ANTHROPIC_API_KEY")
        || (this.budgetLeft() < this.settings.songSeconds ? `this month's ${this.settings.monthlySeconds} s are used` : "");
    return {
      root: this.root,
      composer: composer?.name ?? null,
      writer: this.canAsk() ? "language model" : null,
      busy: this.running ? ([...this.claims.values()].map((one) => one.label).join("; ") || "planning") : "",
      recording: [...this.claims.values()].map((one) => one.label),
      month,
      secondsThisMonth: this.usage[month] ?? 0,
      settings: this.settings,
      waiting: why,
      roster: Object.entries(ROSTER).map(([key, one]) => ({ key, name: one.name, genre: one.genre, signed: this.list().some((artist) => artist.name === one.name) })),
      stations: this.genres().map((genre) => ({ genre, station: this.stationFor(genre)?.id ?? "" })),
      artists: this.list().map((one) => ({
        key: one.key, name: one.name, genre: one.genre, enabled: one.enabled, lastError: one.lastError, failures: one.failures,
        nextAlbumAt: this.dueAt(one),
        albums: one.albums.map((album) => ({
          key: album.key, title: album.title, year: album.year, plannedAt: album.plannedAt, doneAt: album.doneAt,
          songs: album.songs.length, composed: album.songs.filter((song) => song.file).length, cover: Boolean(album.cover),
        })),
      })),
    };
  }

  configure(input: Record<string, unknown>): LabelSettings {
    const whole = (name: string, min: number, max: number): number | undefined => {
      if (input[name] === undefined) return undefined;
      const value = Number(input[name]);
      if (!Number.isInteger(value) || value < min || value > max) throw new StationError(`invalid_${name}`, `${name} is a whole number from ${min} to ${max}`);
      return value;
    };
    const monthly = whole("monthlySeconds", 0, 1_000_000);
    const every = whole("everyDays", 1, 365);
    const seed = whole("seedAlbums", 0, 10);
    const songs = whole("songsPerAlbum", 3, 20);
    const seconds = whole("songSeconds", 30, 300);
    if (monthly !== undefined) this.settings.monthlySeconds = monthly;
    if (every !== undefined) this.settings.everyDays = every;
    if (seed !== undefined) this.settings.seedAlbums = seed;
    if (songs !== undefined) this.settings.songsPerAlbum = songs;
    if (seconds !== undefined) this.settings.songSeconds = seconds;
    if (typeof input["holder"] === "string" && input["holder"].trim()) this.settings.holder = clean(input["holder"], 120);
    if (input["enabled"] !== undefined) this.settings.enabled = input["enabled"] !== false;
    if (input["publish"] !== undefined) this.settings.publish = input["publish"] !== false;
    if (input["videos"] !== undefined) this.settings.videos = input["videos"] !== false;
    const perDay = whole("albumsPerDay", 0, 24);
    if (perDay !== undefined) this.settings.albumsPerDay = perDay;
    if (input["newArtistChance"] !== undefined) {
      const chance = Number(input["newArtistChance"]);
      if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new StationError("invalid_newArtistChance", "newArtistChance is from 0 to 1");
      this.settings.newArtistChance = chance;
    }
    const parallel = whole("parallel", 1, 8);
    if (parallel !== undefined) this.settings.parallel = parallel;
    if (input["genreOrder"] !== undefined) {
      const list = Array.isArray(input["genreOrder"]) ? input["genreOrder"] : String(input["genreOrder"]).split(",");
      this.settings.genreOrder = list.map((one) => clean(one, 40)).filter(Boolean).slice(0, 30);
    }
    if (input["resume"] === true) this.settings.pausedReason = "";
    this.save();
    if (this.settings.enabled) void this.tick();
    return this.settings;
  }

  /** Sign an artist: a preset from the roster, or a name, genre and sound of the owner's own. */
  sign(input: Record<string, unknown>): LabelArtist {
    const preset = typeof input["preset"] === "string" ? ROSTER[input["preset"]] : undefined;
    if (input["preset"] !== undefined && !preset) throw new StationError("unknown_preset", `presets: ${Object.keys(ROSTER).join(", ")}`);
    const name = clean(input["name"] ?? preset?.name, 80);
    const genre = clean(input["genre"] ?? preset?.genre, 40);
    const sound = clean(input["sound"] ?? preset?.sound, 600);
    if (!name) throw new StationError("name_required", "an artist needs a name (or a preset)");
    if (!genre) throw new StationError("genre_required", "an artist needs a genre");
    if (sound.length < 10) throw new StationError("sound_required", "describe the music in a few words: instruments, tempo, mood");
    if (this.list().some((one) => one.name.toLowerCase() === name.toLowerCase())) throw new StationError("already_signed", `${name} is already on the label`, 409);
    const artist: LabelArtist = {
      key: randomBytes(5).toString("hex"),
      name, genre, sound,
      voice: clean(input["voice"] ?? preset?.voice ?? "expressive lead vocal", 300),
      bio: clean(input["bio"] ?? preset?.bio ?? "", 400),
      themes: clean(input["themes"] ?? preset?.themes ?? "", 300),
      enabled: input["enabled"] !== false,
      albums: [],
      createdAt: this.now(),
      lastAttemptAt: 0,
      lastError: "",
      failures: 0,
    };
    this.artists.set(artist.key, artist);
    this.save();
    void this.tick();
    return artist;
  }

  update(key: string, input: Record<string, unknown>): LabelArtist {
    const artist = this.require(key);
    for (const [field, max] of [["sound", 600], ["voice", 300], ["bio", 400], ["themes", 300]] as const) {
      if (typeof input[field] === "string") artist[field] = clean(input[field], max);
    }
    if (input["enabled"] !== undefined) artist.enabled = input["enabled"] !== false;
    artist.failures = 0;
    artist.lastError = "";
    this.save();
    return artist;
  }

  /** Let an artist go. Its music stays (and stays on the air) unless `files` is true. */
  async drop(key: string, files = false): Promise<void> {
    const artist = this.require(key);
    this.artists.delete(key);
    this.save();
    if (files) {
      rmSync(join(this.root, genreSlug(artist.genre), fileName(artist.name)), { recursive: true, force: true });
      await this.place(artist.genre);
    }
  }

  /** Plan the next album for this artist now, whatever its schedule; it is composed song by song from here. */
  async plan(key: string): Promise<LabelAlbum> {
    const artist = this.require(key);
    if (!this.canAsk()) throw new StationError("no_writer", "no language model to write the album: set GEMINI_API_KEY, OPENAI_API_KEY (or NIXAMP_OPENAI_URL) or ANTHROPIC_API_KEY", 409);
    const pending = artist.albums.find((one) => !one.doneAt);
    if (pending) throw new StationError("album_in_progress", `"${pending.title}" is still being made`, 409);
    const plan = await planAlbum(artist, this.settings.songsPerAlbum, this.deps.ask ?? askJson);
    const year = new Date(this.now()).getUTCFullYear();
    let title = plan.title;
    if (artist.albums.some((one) => one.title.toLowerCase() === title.toLowerCase())) title = `${title} II`;
    const album: LabelAlbum = {
      key: randomBytes(4).toString("hex"),
      title,
      year,
      concept: plan.concept,
      folder: join(this.root, genreSlug(artist.genre), fileName(artist.name), `${year}-${fileName(title)}`),
      cover: "",
      coverTried: false,
      songs: plan.songs.map((one, index) => ({ n: index + 1, title: one.title, style: one.style, lyrics: "", seconds: this.settings.songSeconds, file: "", lyricsFile: "", made: "", composedAt: 0 })),
      writer: plan.model,
      plannedAt: this.now(),
      doneAt: 0,
    };
    artist.albums.push(album);
    this.save();
    this.writeAlbumJson(artist, album);
    this.log(`${artist.name} has a new album planned: "${album.title}" (${album.songs.length} songs)`);
    return album;
  }

  startSchedule(everyMs = 5 * 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); void this.videos(); }, everyMs);
    this.timer.unref?.();
    void this.tick();
    void this.videos();
  }

  /**
   * Music videos for every released song without one, one at a time (a
   * video is CPU, not credit), and the TV station of them kept in step. A
   * video that fails is tried again after the next restart, not in a loop.
   */
  videos(): Promise<number> {
    if (!this.settings.videos) return Promise.resolve(0);
    // One run at a time; asking during one waits for it.
    this.filming ??= this.film().finally(() => { this.filming = null; });
    return this.filming;
  }

  private async film(): Promise<number> {
    let total = 0;
    // Songs that land while videos are being made are picked up by the next pass.
    for (let made = await this.filmPass(); made > 0; made = await this.filmPass()) total += made;
    return total;
  }

  private async filmPass(): Promise<number> {
    let made = 0;
    {
      for (const artist of this.list()) {
        for (const album of artist.albums) {
          if (!album.cover && !album.coverTried) continue;
          for (const song of album.songs) {
            if (!song.file || song.video || this.videoFailed.has(song.file) || !this.settings.videos) continue;
            const out = join(album.folder, `${songBase(song)}.mp4`);
            const partial = join(album.folder, `.${randomBytes(4).toString("hex")}.video.mp4`);
            try {
              await (this.deps.video ?? ((audio, cover, to) => renderVideo(this.deps.ffmpeg, audio, cover, to)))(song.file, album.cover, partial);
              renameSync(partial, out);
              song.video = out;
              made += 1;
              this.save();
              // On the air as soon as it is made, not after the whole pass.
              await this.placeVideos().catch(() => undefined);
            } catch (error) {
              this.videoFailed.add(song.file);
              this.log(`no video for "${song.title}": ${(error as Error).message}`);
            } finally {
              rmSync(partial, { force: true });
            }
          }
        }
      }
    }
    return made;
  }

  /** The label's music videos as one TV station: free to watch, with its breaks. */
  private placeVideos(): Promise<void> {
    const next = this.placing.then(async () => {
      await this.deps.index.scan(this.source(), this.deps.probe).done;
      const files = this.list()
        .flatMap((artist) => artist.albums.flatMap((album) => album.songs.map((song) => song.video ?? "")))
        .filter((file) => file && this.deps.index.itemAt(file)?.state === "ready");
      if (files.length === 0) return;
      const existing = this.deps.store.byAuto("ai:label:videos");
      if (existing) {
        this.deps.store.update(existing.id, {}, files);
        return;
      }
      const label = this.settings.holder.replace(/,?\s+(inc|llc|ltd|gmbh|co)\.?$/i, "");
      const made = this.deps.store.create({ name: `${label} AI · Music Videos`, description: `Music videos by ${label}'s AI artists, every genre.`, shuffle: true, repeat: true, video: true }, files, this.deps.owner);
      this.deps.store.markAuto(made.id, "ai:label:videos");
      if (this.settings.publish) {
        this.deps.store.setAccess(made.id, {
          visibility: "public",
          listed: true,
          rights: { basis: "owned", note: `Music videos made for ${this.settings.holder} from its AI artists' songs and covers; no third-party material. ℗ ${this.settings.holder}.` },
        }, this.deps.owner || "ai-label");
      }
      if (this.deps.mayStart()) await this.deps.runner.start(made.id).catch(() => undefined);
    });
    this.placing = next.catch(() => undefined);
    return next;
  }

  stopSchedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Everything that is due, `parallel` songs at a time, until nothing is or
   * something stops it. Each worker claims a song (or an artist to plan for),
   * so two never make the same one.
   */
  async tick(limit = 200): Promise<void> {
    if (this.running || !this.settings.enabled || this.settings.pausedReason) return;
    this.running = true;
    let steps = 0;
    const worker = async (): Promise<void> => {
      while (steps < limit && !this.settings.pausedReason) {
        steps += 1;
        if ((await this.step().catch(() => "idle" as Step)) === "idle") return;
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.max(1, this.settings.parallel) }, worker));
    } finally {
      this.running = false;
    }
  }

  /** Where the artist's genre comes in the owner's order (genreOrder); unlisted genres after. */
  private rank(genre: string): number {
    const at = this.settings.genreOrder.findIndex((one) => genreSlug(one) === genreSlug(genre));
    return at === -1 ? this.settings.genreOrder.length : at;
  }

  private async step(): Promise<Step> {
    const now = this.now();
    const composer = this.composer();
    if (!composer) return "idle";
    const claimedSeconds = [...this.claims.values()].reduce((sum, one) => sum + one.seconds, 0);
    // A song of an album already planned that nobody is making, oldest album first.
    const making = this.list()
      .filter((one) => one.enabled && !this.backingOff(one, now))
      .flatMap((artist) => artist.albums.filter((album) => !album.doneAt).map((album) => ({ artist, album })))
      .sort((a, b) => a.album.plannedAt - b.album.plannedAt);
    for (const { artist, album } of making) {
      if (album.songs.every((one) => one.file)) {
        album.doneAt = now;
        this.save();
        continue;
      }
      const song = album.songs.find((one) => !one.file && !this.claims.has(`${album.key}:${one.n}`));
      if (!song) continue;
      if (song.seconds + claimedSeconds > this.budgetLeft()) return "idle";
      const claim = `${album.key}:${song.n}`;
      this.claims.set(claim, { label: `${artist.name}: ${album.title}: ${song.title}`, seconds: song.seconds });
      try {
        await this.compose(artist, album, song, composer);
      } finally {
        this.claims.delete(claim);
      }
      return "composed";
    }
    // Room for another album: the artist most overdue (in the owner's genre order) gets its next one.
    const inProgress = this.list().filter((one) => one.albums.some((album) => !album.doneAt)).length + this.planning.size;
    if (inProgress >= Math.max(1, this.settings.parallel)) return "idle";
    if (!this.canAsk() || this.settings.songSeconds + claimedSeconds > this.budgetLeft()) return "idle";
    const due = this.list()
      .filter((one) => !this.backingOff(one, now) && !this.planning.has(one.key) && !one.albums.some((album) => !album.doneAt))
      .map((one) => ({ one, at: this.dueAt(one) }))
      .filter(({ at }) => at !== -1 && at <= now)
      .sort((a, b) => a.one.albums.length - b.one.albums.length || this.rank(a.one.genre) - this.rank(b.one.genre) || a.at - b.at)[0];
    if (!due) return this.daily(now);
    this.planning.add(due.one.key);
    try {
      await this.plan(due.one.key);
      due.one.failures = 0;
      due.one.lastError = "";
      this.save();
      return "planned";
    } catch (error) {
      this.failed(due.one, error);
      throw error;
    } finally {
      this.planning.delete(due.one.key);
    }
  }

  /**
   * After the first sweep: the day's album. When the last one was planned a
   * day ago (or 1/albumsPerDay of one), a random artist gets it, or now and
   * then an artist invented for one of the owner's genres. Nothing until every
   * enabled artist has its first albums.
   */
  private async daily(now: number): Promise<Step> {
    const perDay = this.settings.albumsPerDay;
    if (perDay <= 0) return "idle";
    const enabled = this.list().filter((one) => one.enabled);
    if (enabled.some((one) => one.albums.length < this.settings.seedAlbums)) return "idle";
    const last = Math.max(0, ...this.list().flatMap((one) => one.albums.map((album) => album.plannedAt)));
    if (now < last + Math.floor(DAY / perDay) || now < this.dailyTriedAt + 30 * 60_000) return "idle";
    this.dailyTriedAt = now;
    const random = this.deps.random ?? Math.random;
    const genres = this.settings.genreOrder.length ? this.settings.genreOrder : [...new Set(enabled.map((one) => one.genre))];
    let artist: LabelArtist | undefined;
    if ((enabled.length === 0 || random() < this.settings.newArtistChance) && genres.length > 0) {
      const genre = genres[Math.floor(random() * genres.length)]!;
      try {
        const invented = await inventArtist(genre, this.list().map((one) => one.name), this.deps.ask ?? askJson);
        artist = this.sign({ ...invented });
        this.log(`signed a new artist: ${artist.name} (${genre})`);
      } catch (error) {
        this.log(`could not invent a ${genre} artist (${(error as Error).message}); an artist already signed gets the album`);
      }
    }
    if (!artist) {
      const free = enabled.filter((one) => !this.backingOff(one, now) && !this.planning.has(one.key) && !one.albums.some((album) => !album.doneAt));
      artist = free[Math.floor(random() * free.length)];
    }
    if (!artist) return "idle";
    this.planning.add(artist.key);
    try {
      await this.plan(artist.key);
      return "planned";
    } catch (error) {
      this.failed(artist, error);
      throw error;
    } finally {
      this.planning.delete(artist.key);
    }
  }

  private failed(artist: LabelArtist, error: unknown): void {
    artist.lastAttemptAt = this.now();
    artist.failures += 1;
    artist.lastError = (error as Error).message;
    if (error instanceof OutOfCredit) this.settings.pausedReason = `${artist.lastError}; resume with \`nixamp station label resume\` once there is credit`;
    this.save();
    this.log(`${artist.name}: ${artist.lastError}`);
  }

  private async compose(artist: LabelArtist, album: LabelAlbum, song: LabelSong, composer: Composer): Promise<void> {
    artist.lastAttemptAt = this.now();
    mkdirSync(album.folder, { recursive: true });
    const raw = join(album.folder, `.${randomBytes(4).toString("hex")}.raw.mp3`);
    try {
      let writer = song.made || album.writer;
      if (!song.lyrics) {
        const written = await writeLyrics(artist, album, song, this.deps.ask ?? askJson);
        song.lyrics = written.lyrics;
        writer = written.model;
        song.made = writer;
        this.save();
      }
      await this.ensureCover(artist, album);
      this.log(`composing "${song.title}" (${artist.name}, ${album.title}, ${song.seconds} s, ${composer.name})`);
      const prompt = `${artist.sound}. ${song.style}. Lead vocal: ${artist.voice}. Sung in English.`.slice(0, 1500);
      await composer.compose({ prompt, seconds: song.seconds, vocals: true, out: raw, lyrics: song.lyrics });
      const month = monthOf(this.now());
      this.usage[month] = (this.usage[month] ?? 0) + song.seconds;
      const base = songBase(song);
      const file = join(album.folder, `${base}.mp3`);
      const lyricsFile = join(album.folder, `${base}.lyrics.txt`);
      writeFileSync(lyricsFile, `${song.lyrics}\n`);
      const holder = this.settings.holder;
      const tags: Record<string, string> = {
        title: song.title,
        artist: artist.name,
        album_artist: artist.name,
        album: album.title,
        genre: artist.genre,
        track: `${song.n}/${album.songs.length}`,
        date: String(album.year),
        publisher: holder,
        copyright: `℗ ${album.year} ${holder}`,
        comment: `Made with AI for ${holder}: music by ${composer.name}, words by ${writer}`,
        "lyrics-eng": song.lyrics,
      };
      await (this.deps.tag ?? ((from, to, values, cover) => tagFile(this.deps.ffmpeg, from, to, values, cover)))(raw, file, tags, album.cover);
      song.file = file;
      song.lyricsFile = lyricsFile;
      song.made = `${writer} + ${composer.name}`;
      song.composedAt = this.now();
      artist.failures = 0;
      artist.lastError = "";
      if (album.songs.every((one) => one.file)) {
        album.doneAt = this.now();
        this.log(`${artist.name} released "${album.title}"`);
      }
      this.save();
      this.writeAlbumJson(artist, album);
      await this.place(artist.genre);
      // Its video is made beside it, without holding up the next song.
      void this.videos();
    } catch (error) {
      this.failed(artist, error);
      throw error;
    } finally {
      rmSync(raw, { force: true });
    }
  }

  /** The album's cover, drawn once; songs made at the same time wait for the same drawing. */
  private ensureCover(artist: LabelArtist, album: LabelAlbum): Promise<void> {
    if (album.cover || album.coverTried) return this.covering.get(album.key) ?? Promise.resolve();
    album.coverTried = true;
    const drawing = this.drawCover(artist, album).finally(() => this.covering.delete(album.key));
    this.covering.set(album.key, drawing);
    return drawing;
  }

  private async drawCover(artist: LabelArtist, album: LabelAlbum): Promise<void> {
    const prompt = `Album cover art for "${album.title}", a ${artist.genre} album by ${artist.name}. ${album.concept} Style: ${artist.sound}. Striking, original, square composition. No text, no letters, no logos, no watermark.`;
    try {
      const picture = await (this.deps.cover ?? ((text) => workersAiCover(text)))(prompt);
      if (picture) {
        const file = join(album.folder, "cover.jpg");
        writeFileSync(file, picture);
        album.cover = file;
      }
    } catch (error) {
      this.log(`no cover for "${album.title}": ${(error as Error).message}`);
    }
    this.save();
  }

  /** album.json beside the songs: what the album is, for anybody who copies the folder. */
  private writeAlbumJson(artist: LabelArtist, album: LabelAlbum): void {
    try {
      mkdirSync(album.folder, { recursive: true });
      writeFileSync(join(album.folder, "album.json"), `${JSON.stringify({
        artist: artist.name, genre: artist.genre, album: album.title, year: album.year, concept: album.concept,
        label: this.settings.holder, copyright: `℗ ${album.year} ${this.settings.holder}`, madeWithAi: true,
        songs: album.songs.map((one) => ({ n: one.n, title: one.title, seconds: one.seconds, file: one.file ? `${songBase(one)}.mp3` : null, lyrics: one.file ? `${songBase(one)}.lyrics.txt` : null })),
      }, null, 2)}\n`);
    } catch {
      // The folder may be read-only; the state file still has it all.
    }
  }

  private genres(): string[] {
    return [...new Set(this.list().map((one) => one.genre))].sort();
  }

  private stationFor(genre: string): ReturnType<StationStore["get"]> {
    return this.deps.store.byAuto(`ai:label:${genreSlug(genre)}`);
  }

  /** The genre's station gets every song of that genre: made with the first, then kept in step. */
  private place(genre: string): Promise<void> {
    const next = this.placing.then(() => this.placeNow(genre));
    this.placing = next.catch(() => undefined);
    return next;
  }

  private async placeNow(genre: string): Promise<void> {
    await this.deps.index.scan(this.source(), this.deps.probe).done;
    const artists = this.list().filter((one) => genreSlug(one.genre) === genreSlug(genre));
    const files = artists
      .flatMap((one) => one.albums.flatMap((album) => album.songs.map((song) => song.file)))
      .filter((file) => file && this.deps.index.itemAt(file)?.state === "ready");
    const existing = this.stationFor(genre);
    if (existing) {
      if (files.length > 0) this.deps.store.update(existing.id, {}, files);
      return;
    }
    if (files.length === 0) return;
    const holder = this.settings.holder;
    const label = holder.replace(/,?\s+(inc|llc|ltd|gmbh|co)\.?$/i, "");
    const made = this.deps.store.create({
      name: `${label} AI · ${genre}`,
      description: `Original ${genre} by ${label}'s AI artists: ${artists.map((one) => one.name).join(", ")}.`,
      shuffle: true,
      repeat: true,
      bitrate: 192,
    }, files, this.deps.owner);
    this.deps.store.markAuto(made.id, `ai:label:${genreSlug(genre)}`);
    if (this.settings.publish) {
      this.deps.store.setAccess(made.id, {
        visibility: "public",
        listed: true,
        rights: { basis: "owned", note: `Original music by ${holder}'s AI artists, composed for ${holder} by AI (${this.composer()?.name ?? "a music model"}) from words written by AI; no third-party recordings. ℗ ${holder}.` },
      }, this.deps.owner || "ai-label");
    } else {
      this.deps.store.setAccess(made.id, { visibility: "unlisted" }, this.deps.owner || "ai-label");
    }
    if (this.deps.mayStart()) await this.deps.runner.start(made.id).catch(() => undefined);
  }

  /** The catalogue anybody may see: artists, their released songs, the words, and where each genre plays. */
  publicView(): { holder: string; genres: Array<{ genre: string; station: string; artists: PublicArtist[] }> } {
    const genres = this.genres().map((genre) => ({
      genre,
      station: this.stationFor(genre)?.id ?? "",
      artists: this.list()
        .filter((one) => one.genre === genre)
        .map((one) => ({
          key: one.key, name: one.name, genre: one.genre, bio: one.bio,
          albums: one.albums
            .filter((album) => album.songs.some((song) => song.file))
            .map((album) => ({
              key: album.key, title: album.title, year: album.year, concept: album.concept, cover: Boolean(album.cover), complete: album.doneAt > 0,
              songs: album.songs.filter((song) => song.file).map((song) => ({ n: song.n, title: song.title, seconds: song.seconds, lyrics: song.lyrics })),
            }))
            .reverse(),
        }))
        .filter((one) => one.albums.length > 0),
    })).filter((one) => one.artists.length > 0);
    return { holder: this.settings.holder, genres };
  }

  /** A released file anybody may fetch: a song, its words, or its album's cover. */
  publicFile(artistKey: string, albumKey: string, what: string): { path: string; type: string } | null {
    const album = this.artists.get(artistKey)?.albums.find((one) => one.key === albumKey);
    if (!album) return null;
    if (what === "cover.jpg") return album.cover ? { path: album.cover, type: "image/jpeg" } : null;
    const match = /^(\d{1,3})\.(mp3|txt)$/.exec(what);
    const song = match ? album.songs.find((one) => one.n === Number(match[1]) && one.file) : undefined;
    if (!song) return null;
    return match![2] === "mp3" ? { path: song.file, type: "audio/mpeg" } : { path: song.lyricsFile, type: "text/plain; charset=utf-8" };
  }

  /** The label song at this path, for the now-playing card's Download buttons. */
  songAt(file: string): { artist: string; album: string; n: number; title: string; artistName: string; albumTitle: string } | null {
    for (const artist of this.artists.values()) {
      for (const album of artist.albums) {
        const song = album.songs.find((one) => one.file === file);
        if (song) return { artist: artist.key, album: album.key, n: song.n, title: song.title, artistName: artist.name, albumTitle: album.title };
      }
    }
    return null;
  }

  /** A released song's MP3, when this grant's scope covers it. */
  songFile(artistKey: string, albumKey: string, n: number): string {
    return this.artists.get(artistKey)?.albums.find((one) => one.key === albumKey)?.songs.find((one) => one.n === n && one.file)?.file ?? "";
  }

  /**
   * What a purchase's zip holds: every released song in scope with its words,
   * and each album's cover and album.json, under <artist>/<year>-<album>/.
   * Null when there is nothing (or no such artist).
   */
  zipFor(scope: { kind: "song" | "album" | "artist"; artist: string; album: string; n: number }): { name: string; entries: Array<{ name: string; path?: string; bytes?: Uint8Array }> } | null {
    const artist = this.artists.get(scope.artist);
    if (!artist) return null;
    const albums = artist.albums.filter((one) => scope.kind === "artist" || one.key === scope.album);
    const entries: Array<{ name: string; path?: string; bytes?: Uint8Array }> = [];
    const top = fileName(artist.name);
    for (const album of albums) {
      const songs = album.songs.filter((one) => one.file && (scope.kind !== "song" || one.n === scope.n));
      if (songs.length === 0) continue;
      const folder = `${top}/${album.year}-${fileName(album.title)}`;
      for (const song of songs) {
        entries.push({ name: `${folder}/${songBase(song)}.mp3`, path: song.file });
        entries.push({ name: `${folder}/${songBase(song)}.lyrics.txt`, bytes: Buffer.from(`${song.lyrics}\n`) });
        if (song.video) entries.push({ name: `${folder}/${songBase(song)}.mp4`, path: song.video });
      }
      if (album.cover) entries.push({ name: `${folder}/cover.jpg`, path: album.cover });
      entries.push({ name: `${folder}/album.json`, bytes: Buffer.from(`${JSON.stringify({
        artist: artist.name, genre: artist.genre, album: album.title, year: album.year, concept: album.concept,
        label: this.settings.holder, copyright: `℗ ${album.year} ${this.settings.holder}`, madeWithAi: true,
        songs: songs.map((one) => ({ n: one.n, title: one.title, seconds: one.seconds, file: `${songBase(one)}.mp3`, lyrics: `${songBase(one)}.lyrics.txt` })),
      }, null, 2)}\n`) });
    }
    if (entries.length === 0) return null;
    const what = scope.kind === "artist" ? "Discography" : scope.kind === "album" ? albums[0]!.title : this.songFile(scope.artist, scope.album, scope.n) ? albums[0]!.songs.find((one) => one.n === scope.n)!.title : "Song";
    return { name: `${fileName(artist.name)} - ${fileName(what)}.zip`, entries };
  }

  private require(key: string): LabelArtist {
    const artist = this.artists.get(key);
    if (!artist) throw new StationError("not_found", "no such artist on the label", 404);
    return artist;
  }
}

export interface PublicArtist {
  key: string;
  name: string;
  genre: string;
  bio: string;
  albums: Array<{ key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: Array<{ n: number; title: string; seconds: number; lyrics: string }> }>;
}
