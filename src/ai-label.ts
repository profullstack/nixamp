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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { aiKey } from "./ai-keys.ts";
import { composerFromEnv, OutOfCredit, type Composer } from "./ai-radio.ts";
import { askJson, hasModel } from "./ai-text.ts";
import { formatLrc, parseLrc, type SyncedLine } from "./lyrics.ts";
import { bandMarkdown, castLine, inventMembers, readMembers, writeMembers, type Member } from "./label-profiles.ts";
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
  /** Its words timed to the recording (001. <title>.lrc, enhanced LRC), for karaoke on the station page; absent until aligned. */
  lrc?: string;
  /** Its music video (001. <title>.mp4), "" until made; absent on songs from before videos. */
  video?: string;
  /** Whether the video carries its song's tags (videos from 0.52.1 and before do not, until retagged). */
  videoTagged?: boolean;
  /** 2 for a storyboard video (scenes that move); absent or 1 for the cover-and-waveform kind, which is made again. */
  videoVersion?: number;
  /**
   * The singer in its filmed video: "synced" (close-ups lip-synced), "unsynced" (filmed, but no
   * sync could be made, so the band plays there). Absent on a filmed video means the singer was
   * never filmed, and with lip sync on it is filmed again.
   */
  singer?: "synced" | "unsynced";
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
  /** Its people, by slug: each has members/<slug>.md and .jpg in the artist's folder (label-profiles.ts). */
  members?: string[];
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
  /** Music videos, and a TV station of them. Only ever filmed ones (Veo footage end to end); no song gets a slideshow. */
  videos: boolean;
  /** Each album's single (song 1) is filmed with Veo, while the month's Veo budget lasts. */
  veo: boolean;
  /** How many 4 s Veo shots of the band playing (never the singer) a single is cut from. */
  veoShots: number;
  /** How many 4 s Veo story scenes (a short film from the song's words, nobody singing) a single gets. */
  storyShots: number;
  /** How many close-ups of the singer a single gets, lip-synced to the song (0: none, the band only). */
  lipsyncShots: number;
  /**
   * Film enough for the whole song, nothing shown twice: the counts come from the song's
   * length (shotPlan) and the three above are not used. Setting any of them turns this off.
   */
  coverSong: boolean;
  /** With coverSong: what one music video may cost in dollars, the shots planned to fit (shotPlan). */
  videoUsd: number;
  /** Public, listed and owned, so the genre stations are on the guide. */
  publish: boolean;
  /** Songs made at the same time (ElevenLabs takes several requests at once on a paid plan). */
  parallel: number;
  /** Genres whose artists get their albums first, in this order. */
  genreOrder: string[];
  /** The day of the month the budget renews (the provider's billing day), 1-28. */
  resetDay: number;
  /** The budget month a pause for lack of credit began in: a new month lifts it. */
  pausedPeriod?: string;
  /** Set by a provider that is out of credit; cleared by `resume`, or by the next budget month. */
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
  "lowrider-gospel": {
    name: "Lowrider Gospel", genre: "Gangsta Rap",
    sound: "West Coast G-funk, whining portamento synth lead, rubbery Moog bassline, talkbox hook, laid-back swung drums with fat claps, sun-bleached Rhodes, 90-96 BPM",
    voice: "unhurried male baritone with a slow West Coast drawl, rapping a hair behind the beat, cool even when the story turns violent",
    bio: "Raps like he is giving you directions to a block you should not visit after dark.",
    themes: "cruising on Sundays, set loyalty, cousins doing time, the cop car in the mirror, money that came too fast, mothers who pray",
  },
  "cutlass-deacon": {
    name: "Cutlass Deacon", genre: "Gangsta Rap",
    sound: "dark Southern street rap, Memphis horror-movie piano loop, cowbell, rattling TR-808 hats in triplets, distorted sub bass, chanted hooks, 68-75 BPM half-time",
    voice: "menacing low male voice, hushed and close to the mic, rapid triplet flow that snaps into chanted call-and-response hooks",
    bio: "Grew up between a church pew and a trap house and still quotes both.",
    themes: "paranoia, debts collected, a city that eats its young, faith and guilt, the price of loyalty, never sleeping",
  },
  "duchess-ransom": {
    name: "Duchess Ransom", genre: "Gangsta Rap",
    sound: "East Coast mafioso rap, cinematic orchestral sample with strings and brass stabs, hard dusty boom-bap drums, crackling vinyl, sparse menacing piano, 86-90 BPM",
    voice: "cold, precise female MC in a low register, dense multisyllabic rhymes delivered conversationally, never raises her voice",
    bio: "Runs her verses like a ledger: every name, every debt, every date.",
    themes: "the come-up as a business, informants, crooked lawyers, fur and funerals, trust as currency, the cost of the crown",
  },
  "ondine-halloway": {
    name: "Ondine Halloway", genre: "Classical",
    sound: "solo concert grand piano and piano concertos with full orchestra, Romantic and Impressionist, singing melodies over rippling arpeggios, virtuosic cadenzas, rubato, 50-140 BPM",
    voice: "instrumental: a Steinway concert grand in a warm hall",
    bio: "A pianist who plays like the room is empty and the night is long.",
    themes: "nocturnes, études, ballades, preludes and piano concertos; rain on windows, insomnia, letters never sent, the sea",
  },
  "aldermoor-symphony": {
    name: "Aldermoor Symphony Orchestra", genre: "Classical",
    sound: "full late-Romantic symphony orchestra, sweeping strings, French horns, brass chorales, woodwind solos, harp, timpani rolls, symphonies and tone poems, 40-160 BPM",
    voice: "instrumental: eighty players in a large concert hall",
    bio: "An orchestra from a northern town that does not exist, playing symphonies nobody wrote until now.",
    themes: "symphonies in four movements, tone poems and overtures; storms, mountains, harvests, wars remembered, homecomings",
  },
  "ashgrove-ensemble": {
    name: "The Ashgrove Ensemble", genre: "Classical",
    sound: "chamber music for strings and woodwinds: string quartet, oboe, clarinet, flute and bassoon in quartets, quintets and serenades, Classical-era clarity to modern lyricism, 60-150 BPM",
    voice: "instrumental: strings and woodwinds in an intimate wooden hall",
    bio: "Seven players who trade melodies like old friends finishing each other's sentences.",
    themes: "string quartets, clarinet quintets, wind serenades, divertimenti; gardens, conversations, country walks, dances",
  },
  "ras-tamarind": {
    name: "Ras Tamarind", genre: "Reggae",
    sound: "1970s Jamaican roots reggae, one-drop drums, deep round bass, organ bubble, chopped guitar skank, nyabinghi hand drums, horn section lines, tape echo, recorded live to two-inch tape, 68-76 BPM",
    voice: "weathered male tenor with a gentle rasp, preacherly and patient, long held notes, a harmony trio answering every chorus",
    bio: "Sings like a man reading the news to his whole village from a hillside radio.",
    themes: "rent day in the city, farms in the hills, a sister who went abroad, police at the bus stop, rain on zinc roofs, dreams of going home to Africa",
  },
  "iron-kettle-hi-fi": {
    name: "Iron Kettle Hi-Fi", genre: "Reggae",
    sound: "UK steppers dub, militant four-to-the-floor kick, rumbling sub bass, melodica lines, siren and space-echo dubs, spring reverb snare cracks, sparse vocals toasted then dubbed out, sound-system weight, 140-150 BPM halftime feel",
    voice: "deep female alto, cool and grounded, short chant-like phrases thrown into echo, occasional warm toasting",
    bio: "A sound system that started in a church hall basement and never once turned the bass down.",
    themes: "Saturday sessions in a community hall, a speaker stack built by hand, council estates, migrant grandparents, standing tall, the long walk home",
  },
  "cassia-bell": {
    name: "Cassia Bell", genre: "Reggae",
    sound: "lovers rock, soft rockers rhythm, round melodic bass, sweet electric piano, falsetto backing harmonies, light string pads, glossy late-1970s London production, 72-80 BPM",
    voice: "sweet airy female soprano, intimate and breathy, gentle vibrato, close-miked like she is singing to one person",
    bio: "Writes slow-dance songs for people who met at a house party and never told their parents.",
    themes: "first slow dance at a house party, calls from a red phone box, a boy with a borrowed car, mum waiting up, Sunday dresses, saying sorry",
  },
  "lucia-montevar": {
    name: "Lucía Montevar", genre: "Latin",
    sound: "glossy Latin pop with a reggaeton pulse, nylon-string guitar hook, soft dembow, warm 808 bass, finger snaps, pop piano, airy synth pads, polished radio-ready mix, 90-98 BPM",
    voice: "bright female mezzo, smooth and confident, breathy Spanish tag phrases, stacked harmonies on the hook",
    bio: "Turns every heartbreak into a song you can dance to before you cry about it.",
    themes: "the ex at the same rooftop party, summers in her grandmother's town, a borrowed dress, last call in Miami, texts left on read",
  },
  "santo-cobalto": {
    name: "Santo Cobalto", genre: "Latin",
    sound: "hard dembow reggaeton, booming kick and snare dembow pattern, distorted sub bass, perreo synth stabs, air-horn hits, chopped vocal chants, dark club mix, 92-100 BPM",
    voice: "low male baritone, half-sung melodic delivery with a nasal edge, swaggering Spanish ad-libs, heavy on the hook",
    bio: "The man the whole club turns to when the DJ pulls the bass out.",
    themes: "lowered cars on a beach road, the corner where he grew up, bouncers who know his name, a rival crew, a chain he paid off himself",
  },
  "neon-malecon": {
    name: "Neon Malecón", genre: "Latin",
    sound: "bachata-pop meets electro-cumbia, requinto guitar runs, güira scrapes, bongos, cumbia accordion over synth bass, tropical house shimmer, seaside night mood, 110-124 BPM",
    voice: "male-female duet: a tender male tenor and a smoky female alto trading lines, close harmony on the chorus",
    bio: "A duo who met busking on a seawall and still write every song facing the ocean.",
    themes: "night swims, a fruit cart on the seawall, a first apartment with no furniture, ferry rides, homesick cousins, dancing in the kitchen",
  },
  "warehouse-psalms": {
    name: "Warehouse Psalms", genre: "House",
    sound: "classic Chicago gospel house, drum-machine four-on-the-floor, rolling piano chords, organ stabs, hand claps, deep warm bassline, choir backing vocals, long DJ intro and breakdown, 120-124 BPM",
    voice: "powerful female gospel contralto, soaring and raw, testifying ad-libs, call-and-response with a choir",
    bio: "Takes the Sunday choir into the Saturday night warehouse and refuses to choose between them.",
    themes: "dancing until sunrise, a mother's church, the lights coming on at closing, chosen family, freedom on the floor, a broken heart mended",
  },
  "opal-marquee": {
    name: "Opal Marquee", genre: "House",
    sound: "French-touch filter house and nu-disco, looped disco guitar riffs, phaser sweeps, compressed pumping kick, slap bass, vocoder hooks, glittering strings, 118-124 BPM",
    voice: "cool female alto, detached and stylish, half-spoken verses and a vocoder-doubled chorus",
    bio: "Dresses every song in sequins and a little bit of sadness.",
    themes: "a nightclub coat check, the last metro, mirrored ceilings, an old disco record, a rooftop sunrise, the stranger who never gave a name",
  },
  "neon-cloakroom": {
    name: "Cloakroom Sermon", genre: "House",
    sound: "festival piano house and big-room EDM, euphoric supersaw leads, bright house piano, white-noise risers, huge drops, sidechained pads, stadium claps, 124-128 BPM",
    voice: "clear male tenor, anthemic and youthful, a high belted chorus made for a crowd to scream back",
    bio: "Writes for the exact second ten thousand hands go up at once.",
    themes: "festival wristbands, losing your friends in the crowd, a road trip to the coast, the first summer after school, confetti cannons, the drive home",
  },
  "saffron-tidewater": {
    name: "Saffron Tidewater", genre: "Drum & Bass",
    sound: "liquid drum and bass, rolling two-step breaks, warm round sub bass, lush Rhodes chords, jazzy strings, rain and city ambience, soulful and melodic, 172-174 BPM",
    voice: "soulful female mezzo, silky and reverb-washed, long legato lines floating over the breaks",
    bio: "Makes the kind of drum and bass you put on at 4 a.m. when you want to feel everything.",
    themes: "the night bus home, steamed-up windows, a long-distance love, harbour lights, the first train at dawn, the city breathing in the rain",
  },
  "tarmac-prophet": {
    name: "Tarmac Prophet", genre: "Drum & Bass",
    sound: "1990s ragga jungle, frantic chopped breakbeats, booming sub bass drops, reggae sirens, dub echo, rewind effects, pirate-radio grit, 165-170 BPM",
    voice: "gravelly male MC with a reggae toasting delivery, fast rhythmic chants and a sung hook",
    bio: "Learned to MC on a tower block pirate station with the transmitter bolted to the roof.",
    themes: "pirate radio on the roof, rave flyers, council estates, rewinds, the sound clash, mothers phoning the station to complain",
  },
  "ruin-frequency": {
    name: "Ruin Frequency", genre: "Drum & Bass",
    sound: "dark neurofunk, surgical snares, twisted mechanical Reese basslines, metallic foley hits, cinematic sci-fi pads, tight technical drops, 174 BPM",
    voice: "low male baritone, cold and processed, whispered verses and a distorted chant before each drop",
    bio: "Sounds like a factory that learned to dance after the workers went home.",
    themes: "abandoned server farms, night shifts, surveillance cameras, a city power cut, machines that dream, running before the lights come back",
  },
  "pearl-mercer": {
    name: "Pearl Whitlock", genre: "Funk & Soul",
    sound: "1960s Southern soul, tight live rhythm section, Hammond organ, horn section swells, clean electric guitar fills, tambourine, slow-burning 6/8 ballads and stompers, warm vintage mix, 64-110 BPM",
    voice: "powerful female contralto with gospel grit, pleading and raw, cracking on purpose at the peak",
    bio: "Sings like she is standing on the front steps of a house she just walked out of.",
    themes: "a man who drinks his paycheck, the church choir she left, mill shifts, a bus ticket north, the porch light, starting over",
  },
  "the-brass-alibi": {
    name: "The Brass Alibi", genre: "Funk & Soul",
    sound: "1970s hard funk band, syncopated drums hitting on the one, popping slap bass, chicken-scratch guitar, punchy five-piece horn section, clavinet, congas, extended breakdowns, 100-112 BPM",
    voice: "gritty male tenor bandleader, shouted commands and grunts, gang vocals from the band on the hooks",
    bio: "A nine-piece funk band that plays every show like the rent is due at midnight.",
    themes: "the block party, a cheap car with a loud stereo, the landlord, Friday payday, the dance contest, the band van breaking down",
  },
  "wendell-grace": {
    name: "Wendell Grace", genre: "Funk & Soul",
    sound: "1970s Philadelphia-style lush soul, sweeping string orchestra, vibraphone, harp glissandos, smooth disco-tinged hi-hats, warm bass, female backing trio, polished mix, 92-118 BPM",
    voice: "silky male falsetto that drops into a warm tenor, tender and romantic, spoken-word intros",
    bio: "A crooner who makes asking for a second chance sound like a marriage proposal.",
    themes: "the record shop where they met, a forgotten anniversary, a slow dance in a cramped apartment, long-distance calls, a ring he cannot afford",
  },
  "pilot-light-riot": {
    name: "Pilot Light Riot", genre: "Rock",
    sound: "early-2000s garage rock revival, loud fuzzy dual guitars, driving floor-tom drums, simple distorted riffs, handclaps, raw room-mic recording, short punchy songs, 130-150 BPM",
    voice: "snarling male tenor, half-shouted and sneering, sloppy charm, gang vocals on the chorus",
    bio: "Four friends who learned their instruments in a laundromat basement and never fixed the amps.",
    themes: "the laundromat basement, a stolen guitar, the bar that banned them, a girl from the next town, the last bus out, quitting the day job",
  },
  "kilo-verse": {
    name: "Kilo Verse", genre: "Hip-Hop",
    sound: "1990s East Coast boom bap, dusty jazz samples, hard swung drum breaks, upright bass loops, vinyl crackle, turntable scratches on the hook, 86-94 BPM",
    voice: "clear male baritone, dense multisyllabic rhymes, conversational but precise, ends lines with a smirk",
    bio: "A storyteller who writes every verse like a short story with a twist ending.",
    themes: "the corner bodega, a library card, a cousin's record collection, the subway at midnight, beats made in a closet, an eviction notice",
  },
  "neon-tollbooth": {
    name: "Tollbooth Mirage", genre: "Synthwave",
    sound: "outrun synthwave, gated reverb drums, pulsing arpeggiated bass, bright analog brass leads, glossy pads, electric guitar solo, retro car-chase energy, 110-120 BPM",
    voice: "warm male tenor with a soft rasp, nostalgic and reverb-drenched, doubled chorus vocal",
    bio: "Scores the midnight drive you took after the worst day of your life.",
    themes: "empty highways at 3 a.m., a tollbooth attendant's last shift, arcade high scores, a red convertible, motel neon, leaving a small town",
  },
  "clementine-rowe": {
    name: "Clementine Rowe", genre: "Country",
    sound: "1970s outlaw-era country with honky-tonk roots, pedal steel, twangy Telecaster, walking upright bass, shuffle drums, fiddle, barroom piano, 88-120 BPM",
    voice: "husky female alto with a Texas twang, wry and unflinching, a little whiskey in the low notes",
    bio: "Sings drinking songs from behind the bar she has tended for twenty years.",
    themes: "closing time at a roadside bar, a trucker husband, a jukebox that eats quarters, county fair rodeos, a sister who left, paying in cash",
  },
  "grave-lattice": {
    name: "Grave Lattice", genre: "Metal",
    sound: "melodic death metal, twin harmonized lead guitars, tremolo riffs, blast beats and thrash gallops, down-tuned rhythm guitars, keyboard atmosphere, crushing breakdowns, 150-200 BPM",
    voice: "male harsh vocals: deep death growls traded with high raspy screams, a clean sung chorus on a few songs",
    bio: "Writes battle hymns for forests that burned and kingdoms nobody remembers.",
    themes: "frozen battlefields, burned forests, iron crowns, plague ships, a lighthouse keeper's madness, the last king's funeral",
  },
  "odessa-pruitt": {
    name: "Odessa Pruitt", genre: "Gospel",
    sound: "traditional Southern gospel, roaring Hammond B3 with Leslie, rolling church piano, walking bass, shuffle drums that break into shout-tempo double time, call-and-response with a small choir, 70-140 BPM",
    voice: "powerful female contralto, gritty and preacherly, holding long notes and growling on the vamp",
    bio: "Sings every Sunday like the building might be sold on Monday.",
    themes: "a mother's prayer at the kitchen table, crossing the Jordan, the mill closing, hospital waiting rooms, homegoing services",
  },
  "ninefold-choir": {
    name: "Ninefold Choir", genre: "Gospel",
    sound: "modern mass-choir gospel, eighty voices in tight three-part stacks, gospel piano and organ, punchy live drums with fills, bass guitar runs, brass stabs, key changes into a long vamp, 80-128 BPM",
    voice: "soaring male tenor lead over a massed choir that answers every line, a female soprano ad-libbing on top",
    bio: "A city choir that fills a stadium the way most choirs fill a pew.",
    themes: "breakthroughs, Sunday morning victory, debts forgiven, a city getting back up, the saints marching in, the morning after the storm",
  },
  "kerrigan-bishop": {
    name: "Kerrigan Bishop", genre: "Gospel",
    sound: "contemporary worship-soul gospel, warm Rhodes and grand piano, gentle neo-soul drums, sub bass, soft pad swells, acoustic guitar, intimate verses building to a full choir finish, 66-96 BPM",
    voice: "smooth male baritone, conversational and tender, gliding into falsetto runs at the bridge",
    bio: "Writes hymns for people who stopped going to church but still talk to God in the car.",
    themes: "night-shift prayers, quiet doubt, a father's forgiveness, the long drive home, grace in small rooms, starting over at forty",
  },
  "ifeoma-sky": {
    name: "Ifeoma Sky", genre: "Afrobeats",
    sound: "sunny Lagos Afro-pop, bouncy syncopated percussion, shakers and rim clicks, warm sub bass, glossy palm-wine guitar licks, airy synth chords, layered harmonies on the hook, 100-112 BPM",
    voice: "bright female soprano, sweet and playful, quick melismatic runs, stacked harmonies on every hook",
    bio: "Turns a Lagos traffic jam into a dance party with one chorus.",
    themes: "Friday nights on the island, the tailor's new fit, a crush at the wedding, mum's warnings, rooftop parties, shining after a hard week",
  },
  "yaw-brightwater": {
    name: "Yaw Brightwater", genre: "Afrobeats",
    sound: "highlife-rooted Ghanaian Afrofusion, interlocking clean electric guitars, live horn section, talking drum and congas, round melodic bass, organic live-band feel, 95-105 BPM",
    voice: "warm male baritone, relaxed and smiling, lilting phrasing with call-and-response backing singers",
    bio: "Plays his grandfather's guitar parts in a band that sounds like tomorrow.",
    themes: "Accra evenings, the minibus ride home, family gatherings, sending money home, old dance-hall photos, harmattan mornings",
  },
  "sefo-lantern": {
    name: "Sefo Lantern", genre: "Afrobeats",
    sound: "amapiano-leaning South African groove, deep log drum bass, shuffling shakers, jazzy piano chords, wide pads, sparse percussion, long hypnotic builds, 110-114 BPM",
    voice: "low smoky male voice, half-sung and murmured close to the mic, cool and unhurried",
    bio: "Makes music for the hour the party stops being loud and starts being honest.",
    themes: "3 a.m. street parties, slow dances in kitchens, township rooftops, borrowed cars, quiet confidence, the last taxi home",
  },
  "starling-unit": {
    name: "Starling Unit", genre: "K-Pop",
    sound: "high-energy boy-group K-pop, hard EDM-trap hybrid beat, brass synth stabs, sudden tempo and genre switches, chant breakdowns, wobble bass drop, glossy layered production, 120-140 BPM",
    voice: "seven-member male group trading lines: bright tenor leads, a gravelly rap verse, stadium gang chants",
    bio: "Seven boys who perform every chorus like it is the final level of a video game.",
    themes: "secret missions, rebels on the rooftop, hijacking the broadcast signal, loyalty pacts, neon city chases, the last song before sunrise",
  },
  "moonjar": {
    name: "Moonjar", genre: "K-Pop",
    sound: "retro girl-group K-pop, 80s city-pop synths, slap bass, gated snare, sparkling bells, sweet five-part harmonies, playful spoken interludes, bright four-on-the-floor chorus, 110-124 BPM",
    voice: "five-member female group, bright clear voices, cute spoken lines leading into belted choruses",
    bio: "Five girls who found their mothers' cassette tapes and decided the future sounded like that.",
    themes: "summer convenience-store runs, holding hands on the subway, cassette mixtapes, beach trips, first confessions, polaroid memories",
  },
  "seori-vale": {
    name: "Seori Vale", genre: "K-Pop",
    sound: "K-pop solo ballad with R&B touches, lush piano and string arrangement, soft trap snaps, warm sub bass, cinematic orchestral swell into a key-change final chorus, 68-90 BPM",
    voice: "breathy female soprano, delicate in the verses, powerful belted high notes at the climax",
    bio: "Sings drama-ending ballads like she wrote the script herself.",
    themes: "first snow in the city, an unread message, a goodbye at the airport, rain on the bus window, long-distance calls, keeping a promise",
  },
  "wren-abernathy": {
    name: "Wren Abernathy", genre: "Folk",
    sound: "Appalachian old-time folk, clawhammer banjo, fiddle, upright bass, sparse flatpicked acoustic guitar, porch-recorded with natural reverb, close mountain harmonies, 70-120 BPM",
    voice: "high lonesome female voice, plain and unvarnished, slight mountain twang with close harmony",
    bio: "Learned her songs from her grandmother and writes new ones that sound older.",
    themes: "coal camps, floods in the hollow, quilts and Sunday dinners, sisters who left, revenue men, graveyards on the ridge",
  },
  "salt-ferry-band": {
    name: "The Salt Ferry Band", genre: "Folk",
    sound: "British Isles maritime folk, bodhran, concertina, tin whistle, fiddle, acoustic bouzouki, shanty-style group choruses, pub-room energy, jigs between slow airs, 60-140 BPM",
    voice: "rough-hewn male baritone lead with a whole room of rowdy harmonies on the chorus",
    bio: "A harbor-town crew who sing about the sea because half of them still work on it.",
    themes: "trawler disasters, lighthouse keepers, emigrant ships, dockyard strikes, drowned villages, the pub after the funeral",
  },
  "calder-pike": {
    name: "Calder Pike", genre: "Folk",
    sound: "1960s coffeehouse protest folk, intricate Travis-picked acoustic guitar, harmonica in a neck rack, solo performance, close-miked dry room, occasional upright bass, 80-120 BPM",
    voice: "dry male tenor, nasal and wry, half-spoken storytelling that sharpens on the punchlines",
    bio: "A one-man newspaper with six strings and a harmonica.",
    themes: "factory layoffs, highway towns, draft boards, company towns, union halls, prices at the general store, the river they dammed",
  },
  "mirrorball-republic": {
    name: "Mirrorball Republic", genre: "Disco",
    sound: "European space disco, arpeggiated analog synth bass, vocoder hooks, laser sound effects, four-on-the-floor with open hats, string-machine pads, extended instrumental breaks, 118-124 BPM",
    voice: "cool female alto with a poised, slightly robotic delivery, doubled by vocoder on the hooks",
    bio: "A disco band that sounds like it beamed down from an orbiting nightclub.",
    themes: "starships, dance floors on the moon, chrome cities, satellite love affairs, midnight transmissions, glitter that never comes off",
  },
  "lorette-sable": {
    name: "Lorette Sable", genre: "Disco",
    sound: "late-70s New York diva disco, lush strings, horn stabs, octave-jumping bass, chicken-scratch guitar, congas, four-on-the-floor, long breakdown with gospel-tinged background vocals, 116-128 BPM",
    voice: "towering female mezzo-soprano, church-trained belt, glamorous and commanding, ad-libbing over the break",
    bio: "Walks into the club and the DJ changes the record to hers.",
    themes: "leaving a man at the coat check, freedom on Saturday night, rent paid in cash, the velvet rope, sequins and survival",
  },
  "sunday-hustle-orchestra": {
    name: "Sunday Hustle Orchestra", genre: "Disco",
    sound: "orchestral Philadelphia-style soul-disco, full string and horn sections, harp glissandos, tight live rhythm section, timpani accents, galloping bass, instrumental hooks with group chants, 110-120 BPM",
    voice: "smooth male lead on the verses, a mixed group chorus singing short chants and harmonized hooks",
    bio: "A thirty-piece orchestra that only plays when people are dancing.",
    themes: "Sunday roller rinks, block parties, couples' dance contests, city summers, first dances, the ballroom reopening",
  },
  "gunmetal-prairie": {
    name: "Gunmetal Prairie", genre: "Classic Rock",
    sound: "70s heartland Southern rock, twin harmony lead guitars, slide guitar, Hammond organ, honky-tonk piano, big live drums, long guitar solo outros, 90-130 BPM",
    voice: "raspy male baritone, weathered and soulful, belting the chorus with a whiskey edge",
    bio: "A bar band that kept playing until the bar became a stadium.",
    themes: "grain elevators, tornado season, small-town Friday nights, fathers and sons, pickup trucks, leaving the county line",
  },
  "bus-fare-riot": {
    name: "Bus Fare Riot", genre: "Punk",
    sound: "UK street punk with ska breaks, buzzsaw guitars, rapid two-step drums, driving bass, offbeat skank guitar bridges, shouted gang choruses, 160-200 BPM",
    voice: "snotty female voice with a working-class accent, shouting and sneering over a gang chorus",
    bio: "A four-piece who formed the week the fare went up again.",
    themes: "night buses, landlords, zero-hour contracts, council estates, cancelled shifts, chip shop closing time, ticket inspectors",
  },
  "hollis-greaves": {
    name: "Hollis Greaves", genre: "Blues",
    sound: "North Mississippi hill country blues, droning one-chord electric guitar riffs, hypnotic trance grooves, fife-and-drum style percussion, stomping kick, raw overdriven amp, 90-120 BPM",
    voice: "deep gravelly male voice, moaning and chanting, repetitive and spellbinding",
    bio: "Plays one chord for ten minutes and makes you forget there are others.",
    themes: "juke joints, hill-country picnics, unfaithful lovers, gambling debts, the sheriff's car, homemade whiskey, the creek in flood",
  },
  "imogen-tarrant": {
    name: "Imogen Tarrant", genre: "Jazz",
    sound: "modal post-bop vocal jazz quintet, tenor saxophone, muted trumpet, piano with quartal voicings, upright bass, brushes and ride-cymbal swing, spacious arrangements, 80-200 BPM",
    voice: "husky female contralto, behind-the-beat phrasing, wordless vocalese lines doubling the tenor sax",
    bio: "Sings like the sax player's sister who won every argument.",
    themes: "late trains, rainy rooftops, empty galleries after closing, coastal fog, conversations after midnight, a borrowed coat",
  },
  "noelle-ardent": {
    name: "Noelle Ardent", genre: "R&B",
    sound: "early-90s new jack swing R&B, swing-beat drums with hard snares, synth bass stabs, glossy keys, vocal harmony stacks, talkbox ad-libs, dance breakdowns, 100-112 BPM",
    voice: "bright female soprano, agile runs and playful sass, stacked harmonies on every chorus",
    bio: "Brings back the era when R&B hit as hard as it harmonized.",
    themes: "pager messages, roller rink crushes, girls' night out, a cheating boyfriend caught, mall dates, freedom on the weekend",
  },
  "wet-cinder": {
    name: "Wet Cinder", genre: "Grunge",
    sound: "early-90s Pacific Northwest sludge grunge, drop-D detuned fuzz guitars, lumbering bass, heavy loose drums, quiet clean-tone verses exploding into fuzz walls, 4-track grit, 70-95 BPM",
    voice: "male baritone, raspy and slurred in the verse, tearing into a strained throat-shredding howl on the chorus",
    bio: "Recorded their first album in a flooded rehearsal unit and kept the hum of the dehumidifier in the mix.",
    themes: "rain on a tin roof, pawned guitars, a landlord's notes under the door, ferry towns, friends who drank too much, winter cannery shifts",
  },
  "mossback-choir": {
    name: "Mossback Choir", genre: "Grunge",
    sound: "melodic mid-90s alt-grunge, chorused arpeggiated clean guitars, soaring fuzz choruses, melodic bass, crisp big-room drums, minor-key hooks with unexpected chord turns, 100-125 BPM",
    voice: "male tenor with a nasal, bruised edge, singing wide melodies that crack into a sustained yell at the top",
    bio: "Five sad teenagers from a logging town who wrote stadium choruses about never leaving it.",
    themes: "clear-cut hillsides, a father's pickup truck, late shifts at the mill, the girl who left for the city, a church basement party",
  },
  "thistle-burn": {
    name: "Thistle Burn", genre: "Grunge",
    sound: "female-fronted grunge with a punk snarl, feedback-drenched offset guitars, gnarled bass riffs, fast-slow tempo shifts, primal floor-tom drums, abrasive noise breaks, 90-140 BPM",
    voice: "female alto, sweet and mocking in the verse, switching to a blown-out scream that sounds like it hurts",
    bio: "Three women from a strip-mall town who play loud enough to rattle the dollar store next door.",
    themes: "bad boyfriends, babysitting money, thrift-store wedding dresses, small-town gossip, burning the yearbook, sisters who stay",
  },
  "parking-lot-prom": {
    name: "Parking Lot Prom", genre: "Pop Punk",
    sound: "early-2000s mall pop punk, bright buzzing power chords, fast skate-punk drums, bouncy melodic bass, gang 'whoa-oh' backing vocals, big sing-along choruses, 160-190 BPM",
    voice: "male tenor, nasal and boyish, singing quick and wry with an over-earnest crack on the high notes",
    bio: "Got kicked out of their own prom and played a set off a pickup tailgate in the parking lot instead.",
    themes: "curfews, rented tuxes, getting dumped by text, summer jobs at the water park, the night the car broke down, best friends forever (maybe)",
  },
  "the-late-slips": {
    name: "The Late Slips", genre: "Pop Punk",
    sound: "late-2000s emo-leaning pop punk, twinkly lead guitar over crunchy rhythm guitar, half-time breakdowns, octave chords, rapid drum fills, minor-key verses into major choruses, 140-175 BPM",
    voice: "male tenor with a breathy, confessional delivery that tips into shouted harmonies on the bridge",
    bio: "Named after the tardy notes they collected, they write every song like it is the last day of school.",
    themes: "hometown basements, the last bus home, a friend's funeral, college rejection letters, a hoodie that still smells like her, getting older",
  },
  "bria-castellane": {
    name: "Bria Castellane", genre: "Pop Punk",
    sound: "2020s pop-punk revival, punchy tight drums, glossy distorted power chords, sub-heavy bass, handclap breakdowns, bratty pre-choruses, bright modern sheen over real punk guitars, 150-170 BPM",
    voice: "female soprano, bratty and sarcastic in the verse, belting a clean powerful chorus with a sneer at line ends",
    bio: "Wrote her breakout single in a dentist's waiting room and has refused to get her braces off ever since.",
    themes: "group chats, a friend who stole her crush, phone screens at 3am, failed driving tests, glitter nail polish, swearing she's over it",
  },
  "window-seat-tapes": {
    name: "Window Seat Tapes", genre: "Lo-Fi",
    sound: "jazzy lo-fi hip-hop, warm Rhodes seventh chords, upright bass loops, swung boom-bap drums with soft brushed snare, vinyl crackle, rain field recordings, 70-85 BPM",
    voice: "instrumental: Rhodes piano and upright bass in a small carpeted bedroom studio",
    bio: "Every beat started on a cassette recorder pressed to a train window somewhere between two stops.",
    themes: "commuter train rides, rainy afternoons, late study nights, corner cafes, bookshop aisles, city lights through a wet window",
  },
  "kettle-and-dust": {
    name: "Kettle & Dust", genre: "Lo-Fi",
    sound: "dusty tape-saturated lo-fi, detuned nylon guitar and toy piano loops, crunchy sampler drums, heavy wow and flutter, bitcrushed hats, warbly music-box melodies, 65-80 BPM",
    voice: "instrumental: nylon-string guitar and toy piano through a worn cassette deck in a farmhouse kitchen",
    bio: "Makes beats in a farmhouse kitchen, which is why there is a whistling kettle on almost every record.",
    themes: "grandmother's kitchen, autumn porches, laundry on the line, old photographs, Sunday morning tea, dust in sunbeams",
  },
  "moth-lamp-radio": {
    name: "Moth Lamp Radio", genre: "Lo-Fi",
    sound: "nocturnal synth lo-fi, mellow analog pads, soft FM bells, gently sidechained kick, lazy shuffled hats, chopped harp samples, low-pass filtered night ambience, 75-90 BPM",
    voice: "instrumental: warm analog synths and filtered harp in a dim bedroom studio at night",
    bio: "Broadcasts from a single desk lamp at 3am to whoever else is still awake.",
    themes: "insomnia, neon signs, empty highways, moths around streetlights, late-night convenience stores, the hum of a fridge",
  },
  "fenline-transmissions": {
    name: "Fenline Transmissions", genre: "Ambient",
    sound: "field-recording drone ambient, layered marsh and tide recordings, bowed metal, shortwave radio static, slow sustained harmonium tones, deep sub drones, beatless and free-time",
    voice: "instrumental: drones, harmonium and field recordings captured on an open coastal marsh",
    bio: "Records only on the flat salt coast at dawn, leaving the microphones out until the tide reaches them.",
    themes: "tidal estuaries, curlew calls, abandoned listening stations, sea fog, reed beds in wind, the slow return of the tide",
  },
  "low-orbit-gardens": {
    name: "Low Orbit Gardens", genre: "Ambient",
    sound: "cosmic synth ambient, shimmering polyphonic analog pads, slow arpeggiated sequences, glassy bell tones, long granular swells, faint radio telemetry, beatless or barely pulsing, 60-80 BPM",
    voice: "instrumental: vintage analog synthesizers in a vast reverberant space",
    bio: "Composes as if every piece were the only thing playing in a greenhouse orbiting a quiet planet.",
    themes: "orbiting stations, aurora, satellites passing overhead, hydroponic gardens, the curve of the earth, deep-space silence",
  },
  "quiet-weir": {
    name: "Quiet Weir", genre: "Ambient",
    sound: "modern-classical piano ambient, felted upright piano, looped tape echoes, soft cello drones, distant running-water recordings, gentle granular textures, 55-70 BPM",
    voice: "instrumental: felt-muted upright piano and cello in a wooden mill room by a river",
    bio: "Plays in an old water mill where the river under the floor sets the tempo.",
    themes: "slow rivers, millstones, early frost, fog on fields, letters never sent, the light before snow",
  },
  "halden-voss": {
    name: "Halden Voss", genre: "Film Score",
    sound: "modern hybrid action-epic score, thundering taiko and low brass ostinatos, pulsing string spiccato, distorted synth bass, massive brass braams, rising tension builds, 90-140 BPM",
    voice: "instrumental: full orchestra with massive percussion and synths on a large scoring stage",
    bio: "Scores films that do not exist with the conviction that a trailer is already cutting to them.",
    themes: "chases across rooftops, siege lines, ticking countdowns, a last stand, storms over the sea, vast machines waking",
  },
  "oriel-fenwick": {
    name: "Oriel Fenwick", genre: "Film Score",
    sound: "lush golden-age romantic film score, soaring string melodies, French horn themes, harp glissandi, celesta, woodwind solos, waltz and adventure-march cues, sweeping swells, 60-130 BPM",
    voice: "instrumental: large romantic studio orchestra with harp and celesta in a warm hall",
    bio: "Writes the kind of main theme that keeps an audience seated through the end credits.",
    themes: "grand voyages, lost kingdoms, romance aboard ocean liners, secret gardens, swashbuckling duels, reunions at train stations",
  },
  "marrow-reel": {
    name: "Marrow Reel", genre: "Film Score",
    sound: "minimalist psychological-thriller score, pulsing analog synth arpeggios, prepared piano, scraping string clusters, sparse heartbeat percussion, detuned music-box motifs, cold reverb, 70-110 BPM",
    voice: "instrumental: prepared piano, modular synths and a small string quartet in a dark studio",
    bio: "Scores the scene right before the door opens and never tells you what was behind it.",
    themes: "surveillance, unanswered phone calls, empty motels, a stranger in the rearview mirror, memory loss, the night drive home",
  },
  "saffi-lark": {
    name: "Saffi Lark", genre: "Pop",
    sound: "glossy 80s-revival synth-pop, gated reverb drums, sparkling FM electric piano, slap bass, shimmering arpeggios, saxophone hook in the bridge, big stacked choruses, 110-125 BPM",
    voice: "female mezzo-soprano, bright and breathy, cheeky in the verse, soaring in the chorus with clean stacked harmonies",
    bio: "A roller-rink DJ's daughter who writes every song like it is the final skate of the night.",
    themes: "roller rinks, neon motels, falling for the wrong boy at the arcade, summer road trips, dancing alone in a bedroom, mixtapes",
  },
  "larkin-bay-sound": {
    name: "Larkin Bay Sound", genre: "Yacht Rock",
    sound: "late-1970s West Coast soft rock, Fender Rhodes, clean chorused Stratocaster, tight session drums, slap-free melodic bass, horn section swells, stacked falsetto harmonies, 92-104 BPM",
    voice: "smooth, husky male tenor that floats into falsetto on the choruses",
    bio: "A studio band that only ever wanted to make records for the drive back from the marina.",
    themes: "charter boats, second marriages, sunset cocktails, long-distance calls, ex-lovers at the yacht club",
  },
  "dorian-shoal": {
    name: "Dorian Shoal", genre: "Yacht Rock",
    sound: "silky late-70s West Coast yacht rock, Fender Rhodes, jazzy major-seventh chords, smooth slide guitar, horn section stabs, laid-back groove drums, warm analog sheen, 90-110 BPM",
    voice: "male tenor, velvety and relaxed, rising to a smooth falsetto in the chorus over stacked harmony backing",
    bio: "Docks his sailboat at a different marina every summer and leaves a song behind at each one.",
    themes: "sunset harbors, linen suits, unrequited love at sea, beach clubs, nautical charts, champagne goodbyes on the dock",
  },
  "pinewood-syndicate": {
    name: "Pinewood Syndicate", genre: "Gangsta Rap",
    sound: "late-90s dirty-south gangsta rap, booming 808 kicks, rattling hi-hats, dark minor synth stabs, chopped soul samples, eerie church organ, slow menacing grooves, 68-80 BPM",
    voice: "male crew trading verses: a deep drawling lead, a raspy hype man and a quick double-time third MC",
    bio: "A crew from a backwoods county where everyone knows your business before you finish it.",
    themes: "trap houses in the pines, dirt-road deals, county jail visits, candy-painted cars, family loyalty, swamp heat and Sunday cookouts",
  },
  "ravensmere-consort": {
    name: "The Ravensmere Consort", genre: "Classical",
    sound: "Baroque period-instrument ensemble, double-manual harpsichord, baroque violins, viola da gamba, theorbo, baroque oboe, ornamented counterpoint, suites, concerti grossi and fugues, 60-140 BPM",
    voice: "instrumental: period-instrument baroque ensemble led by harpsichord in a stone chapel",
    bio: "A consort that tunes to candlelight pitch and plays as if the patron is still listening from the gallery.",
    themes: "dance suites, concerti grossi, fugues and chaconnes; harvest festivals, royal processions, candlelit courts, rain on old cathedrals",
  },
  "bluebeat-tailors": {
    name: "Bluebeat Tailors", genre: "Ska",
    sound: "early-1960s Kingston first-wave ska, walking upright bass, scratchy offbeat guitar, upright piano shuffle, a four-horn front line of trumpet, trombone, tenor and alto sax, tape-room warmth, 110-125 BPM",
    voice: "smooth male tenor with a gentle Jamaican lilt, close harmony backing vocals answering every line",
    bio: "They cut their records in the back of a dressmaker's shop and paid the trombonist in suits.",
    themes: "Saturday sound systems, sharp new suits, courting on the seawall, rent day, the boat to England, a dance that ends at dawn",
  },
  "checkerboard-union": {
    name: "Checkerboard Union", genre: "Ska",
    sound: "1979 British two-tone ska, racing skank guitar, cheap combo organ, tight snare rimshots, choppy trumpet and trombone hooks, post-punk edge, 150-175 BPM",
    voice: "sardonic male lead in a flat Midlands accent, half-sung half-shouted, with a female co-vocal trading lines",
    bio: "A factory town band who turned the dole queue into a dance floor.",
    themes: "closed factories, bus shelters, dole office small talk, a pub fight over nothing, unity on the dance floor, tower blocks",
  },
  "pocket-fireworks": {
    name: "Pocket Fireworks", genre: "Ska",
    sound: "mid-1990s California third-wave ska-punk, fast upstroke guitar that flips into distorted power-chord choruses, punchy bass, crashing drums, bright trumpet-trombone-bari sax horn lines, 160-200 BPM",
    voice: "nasal, energetic female lead with a cheeky snarl, gang-shout backing vocals on every chorus",
    bio: "Seven friends, three horns, one van with no second gear.",
    themes: "suburban boredom, skate-park injuries, minimum-wage shifts, a basement show broken up by cops, best friends, leaving town",
  },
  "driftglass-four": {
    name: "The Driftglass Four", genre: "Surf Rock",
    sound: "1962 Southern California instrumental surf, single-coil guitar through dripping spring reverb, staccato tremolo picking, galloping tom-heavy drums, picked bass, rhythm guitar chops, bright and sunny, 150-175 BPM",
    voice: "instrumental: two reverb-soaked guitars, bass and drums in a small studio",
    bio: "Four lifeguards who learned to play between shifts and never wrote a single word.",
    themes: "point breaks, pier pilings, woodie wagons, the first swell of summer, wipeouts, bonfires on the sand, sunrise sessions",
  },
  "sandbar-seance": {
    name: "Sandbar Séance", genre: "Surf Rock",
    sound: "dark surf noir with spaghetti-western drama, minor-key baritone guitar twang, cavernous spring reverb, tremolo swells, mariachi-style trumpet, haunted organ, floor-tom gallop, 95-140 BPM",
    voice: "instrumental: baritone guitar, trumpet and organ in a cavernous room",
    bio: "Plays surf music for the beach after the tourists leave and the fog comes in.",
    themes: "night tides, shipwrecks, desert highways to the coast, lost swimmers, border towns, ghost piers, fog horns",
  },
  "gull-rock-rangers": {
    name: "Gull Rock Rangers", genre: "Surf Rock",
    sound: "modern Australian garage surf, overdriven reverb guitar with fuzz on the leads, combo organ, punk-fast drums, distorted bass, raw live-to-tape recording, 170-200 BPM",
    voice: "instrumental: fuzzed reverb guitars, combo organ, bass and drums played loud",
    bio: "Recorded their first record in a boat shed and their second in a storm.",
    themes: "cold southern swell, sharks, cliff jumps, van breakdowns, cheap motels, bushfire skies, chasing a cyclone swell",
  },
  "earl-tolliver": {
    name: "Earl Tolliver", genre: "Rockabilly",
    sound: "1955 Memphis-style rockabilly, slapback echo on everything, slapped upright bass, hollow-body electric guitar with thumb-picked licks, snare-and-brush drums, bare acoustic rhythm, 160-190 BPM",
    voice: "wiry Southern male tenor with hiccups, yelps and a sly grin in every line",
    bio: "A tractor mechanic who drove four hours to a studio and came home famous in two counties.",
    themes: "two-tone Fords, county fairs, a sheriff's daughter, Friday paychecks, jukebox nickels, Sunday shoes on dirt roads",
  },
  "dottie-calhoun": {
    name: "Dottie Calhoun", genre: "Rockabilly",
    sound: "1957 Texas rockabilly with a honky-tonk edge, pounding upright piano, twangy hollow-body lead guitar, slapped bass, steady snare, handclaps, raw and rowdy, 150-180 BPM",
    voice: "brassy, growling female alto that snaps into a wild shout, playful and fearless",
    bio: "The girl the radio stations called too loud, so she got louder.",
    themes: "fast cars and slow boys, drive-in movies, roadhouse fights, Saturday night curfews, leaving a cheating man in the dust",
  },
  "cotter-pins": {
    name: "The Cotter Pins", genre: "Rockabilly",
    sound: "modern psychobilly and neo-rockabilly, ferociously slapped upright bass, crunchy hollow-body guitar through a hot amp, stand-up snare and tom, horror-movie twang, 180-220 BPM",
    voice: "gravelly male shouter with a manic howl, gang-yell backing vocals",
    bio: "A trio of hot-rod welders who play like the garage is on fire.",
    themes: "B-movie monsters, junkyard hot rods, graveyard dates, bowling alley brawls, tattoo parlours, cars that will not start",
  },
  "harlan-crowe-orchestra": {
    name: "Harlan Crowe Orchestra", genre: "Swing",
    sound: "1939 ballroom big band swing, five saxes, four trumpets, four trombones, clarinet lead, walking bass, four-to-the-bar guitar, hi-hat swing, lush and polished, 140-180 BPM",
    voice: "velvet male baritone crooner, relaxed phrasing a fraction behind the beat, warm and debonair",
    bio: "Played every hotel ballroom on the line from Chicago to the coast and never once missed a downbeat.",
    themes: "ballroom dates, train-station goodbyes, borrowed tuxedos, moonlight on the river, payday nights, dancing cheek to cheek",
  },
  "vivian-marchetti": {
    name: "Vivian Marchetti", genre: "Swing",
    sound: "1946 jump swing and jump blues, small big band of three saxes and two trumpets, honking tenor solos, boogie piano, slapping upright bass, driving shuffle drums, 150-200 BPM",
    voice: "powerful, sassy female belter with a husky low end and a wink in every phrase",
    bio: "A shipyard welder during the war who never went back to quiet.",
    themes: "after-hours clubs, sailors on leave, shipyard shifts, a two-timing trumpet player, nylons, rent parties, staying out till sunrise",
  },
  "zoot-parade": {
    name: "Zoot Parade", genre: "Swing",
    sound: "1990s neo-swing revival, punchy horn section with bari sax, crunchy hollow-body guitar, upright bass, tight swing drums with rock power, bright modern mix, 160-210 BPM",
    voice: "brash, cocky male lead with a growl and a grin, punchy band shouts on the hooks",
    bio: "A former punk band who bought suits and a horn section and never looked back.",
    themes: "thrift-store zoot suits, lindy hop nights, hot rods, bad decisions in good shoes, last call, dance-floor rivalries",
  },
  "isadora-lune": {
    name: "Isadora Lune", genre: "Bossa Nova",
    sound: "classic early-1960s bossa nova, solo nylon-string guitar and brushed snare, soft upright bass, sparse piano chords, alto flute, intimate and minimal, 120-140 BPM",
    voice: "hushed, breathy female alto, almost speaking, straight tone with no vibrato",
    bio: "Sings like she is telling you a secret on a balcony while the city sleeps.",
    themes: "late afternoons by the sea, a lover's empty chair, rain on terracotta, coffee gone cold, letters in a drawer, slow walks home",
  },
  "caio-seraphin": {
    name: "Caio Seraphin", genre: "Bossa Nova",
    sound: "late-1960s orchestral bossa and jazz-samba, nylon guitar with lush string arrangements, muted trumpet, soft flute, upright bass, brushed drums, cinematic and warm, 110-140 BPM",
    voice: "soft, whispered male baritone, gentle and conversational, never above a murmur",
    bio: "A former harbour pilot who writes love songs in the shape of tide tables.",
    themes: "harbour lights, ferries leaving at dawn, a seaside hotel, unanswered telegrams, the last tram, the scent of jasmine at night",
  },
  "lagoon-siesta": {
    name: "Lagoon Siesta", genre: "Bossa Nova",
    sound: "modern lounge bossa duo, nylon guitar and Rhodes over a soft programmed bossa beat, upright bass, light shaker, vinyl warmth and subtle electronic textures, 100-125 BPM",
    voice: "soft, airy female voice doubled by a low male murmur on choruses, intimate and cool",
    bio: "A pair who met in a hotel bar and have been playing its last set ever since.",
    themes: "rooftop pools at dusk, airport lounges, hotel keys, summer heat, half-finished cocktails, postcards never sent",
  },
  "ysabel-corrales": {
    name: "Ysabel Corrales", genre: "Salsa",
    sound: "salsa romántica, lush string pads under bright trumpets and trombones, rolling piano montuno, tumbao bass, congas and timbales, smooth 2-3 son clave, a mid-tempo sway, 88-100 BPM",
    voice: "warm, velvety female mezzo with a catch in the high notes, tender verses that open into fierce pregones",
    bio: "Sings about leaving men like she is reading the bill aloud at the table.",
    themes: "a married lover at the Saturday dance, a ring left on the dresser, nursing school night shifts, her mother's hands, slow dancing alone",
  },
  "fourth-floor-montuno": {
    name: "Fourth Floor Montuno", genre: "Salsa",
    sound: "salsa dura big band, four-trombone front line with two trumpets, hard driving piano montuno, timbales breaks, cowbell on every beat of the mambo, jazzy horn solos, long montuno vamps, 180-210 BPM",
    voice: "gritty male sonero with a barking tenor, quick improvised pregones, a shouting coro of four bandmates behind him",
    bio: "A twelve-piece band that rehearses in a walk-up and plays like the elevator is broken on purpose.",
    themes: "tenement summers, the corner bodega, the boiler that never works, union jobs, block parties, uncles arguing about the old country",
  },
  "dario-encinas": {
    name: "Dario Encinas", genre: "Salsa",
    sound: "fast Cali-style salsa brava for dancers, bright trumpet-led horns, crisp bongó bell, rapid piano tumbaos, punchy bass, sharp unison breaks and stops for footwork, 200-230 BPM",
    voice: "bright, nasal male tenor that rides the clave tight and fast, playful on the coro calls",
    bio: "Writes every song for the dancer who hits the floor first and leaves last.",
    themes: "Sunday dance contests, a borrowed suit, the bus driver who dances, a rival with faster feet, rent due Monday, the girl's father at the door",
  },
  "bashy-coral": {
    name: "Bashy Coral", genre: "Dancehall",
    sound: "modern party dancehall, bouncing digital riddim with snappy snare, rubbery synth bass, steelpan and marimba hook stabs, air horns, crowd chants, 95-104 BPM",
    voice: "confident female deejay with a bright, cutting tone, rapid toasting that breaks into a sing-song hook",
    bio: "Runs the dance like a landlady collecting rent: everybody pays, nobody argues.",
    themes: "the Friday street dance, a new hairdo, outdancing a rival crew, men who promise and never call, Saturday market, her own money",
  },
  "yard-commodore": {
    name: "Yard Commodore", genre: "Dancehall",
    sound: "1990s-style digital ragga, stripped drum-machine riddim, booming sub bass, a sparse keyboard stab, rewind effects and sound-system echo, rough and raw, 88-96 BPM",
    voice: "deep, gravelly male deejay with a rolling cadence and staccato bursts, sound-clash bravado and comic timing",
    bio: "Talks to a crowd like a ship's captain who has outlived every storm and most of his rivals.",
    themes: "sound-clash battles, the selector's dubplates, a car with no reverse gear, a fisherman father, rainy nights on the lawn, old-school respect",
  },
  "rowdy-pimento": {
    name: "Rowdy Pimento", genre: "Dancehall",
    sound: "afro-dancehall fusion, syncopated log-drum bass and shakers, warm guitar licks, bright synth leads, call-and-response crowd vocals, carnival energy, 104-112 BPM",
    voice: "raspy, upbeat male deejay who switches between rapid chatting and a cheeky singalong hook",
    bio: "The only man ever banned from a wedding for making the bride's grandmother dance too hard.",
    themes: "beach parties, jerk smoke, a cousin's wedding, wining contests, flirting at the bar, getting home before sunrise",
  },
  "quarry-saint": {
    name: "Quarry Saint", genre: "Trap",
    sound: "dark Southern street trap, haunting choir pad and minor-key bell loop, booming tuned 808s with long slides, rapid triplet hi-hat rolls, hard claps, cinematic tension, 135-145 BPM",
    voice: "low, raspy male voice with a cold, clipped triplet flow, menacing ad-libs and a half-sung hook",
    bio: "Prays in the hook and counts money in the verses, and never confuses the two.",
    themes: "a dead-end county road, a brother doing a bid, trap phones under the floorboard, a mother's church, loyalty tested, sleeping light",
  },
  "halo-overdraft": {
    name: "Halo Overdraft", genre: "Trap",
    sound: "melodic emo trap, sad clean electric guitar loop, airy pads, sliding 808s, sparse snappy hats, heavy autotune doubles and stacked harmonies, 140-160 BPM",
    voice: "wounded male tenor in heavy autotune, half-rapped half-sung, cracking on purpose in the hook",
    bio: "Spent his first advance on a car and his second on the tickets it collected.",
    themes: "a negative bank balance, a breakup over FaceTime, anxiety in the studio, fake friends at the after-party, late-night drives, missing home",
  },
  "mimi-overtime": {
    name: "Mimi Overtime", genre: "Trap",
    sound: "bouncy plugg and rage trap, saw-wave synth leads, bubbly bell melodies, distorted punchy 808s, skippy hats, rapid-fire energy, 150-165 BPM",
    voice: "sharp, playful female rapper with a high, bratty tone, rapid-fire flow and catchy repeated chants",
    bio: "Clocked out of a warehouse shift for the last time and rapped the exit interview.",
    themes: "quitting a dead-end job, paying her mother's bills, haters in the comments, shopping sprees, her best friend's car, doubling everything",
  },
  "drift-coroner": {
    name: "Drift Coroner", genre: "Phonk",
    sound: "drift phonk, melodic distorted cowbell riff, clipped and saturated 808 bass, hard trap hats, pumping sidechain, chopped vocal shouts, built for car edits, 130-160 BPM",
    voice: "chopped, pitched-down male chants, low and menacing, repeated in short bursts with call-and-response echoes",
    bio: "Tunes every track to the second a back tyre lets go.",
    themes: "midnight mountain-pass runs, burnt rubber, tinted windows, empty industrial lots, a rival's tail lights, the cops a mile behind",
  },
  "cassette-undertaker": {
    name: "Cassette Undertaker", genre: "Phonk",
    sound: "old-school Memphis tape phonk, eerie horror-movie piano and synth loop, rattling cowbell, dusty TR-808 drums, thick tape hiss and warble, slowed vocal samples, 65-75 BPM",
    voice: "hushed, raspy male whisper-rap with a slow triplet flow, haunting doubled chants behind him",
    bio: "Records every song onto a bootleg tape and buries the master in his yard.",
    themes: "riverside motels, funeral homes after dark, fog on the bridge, voices on the police scanner, enemies who disappeared, paranoia",
  },
  "brakelight-hex": {
    name: "Brakelight Hex", genre: "Phonk",
    sound: "aggressive gym phonk, blown-out distorted bass stabs, fast cowbell melodies, screeching synth leads, pounding kicks, sudden drops, relentless energy, 160-175 BPM",
    voice: "growling, distorted female chant, pitched low and chopped, cutting shouted hooks",
    bio: "Turns every brake light in the city red just by driving past.",
    themes: "the 5 a.m. weight room, revenge on an ex, running red lights, a car that refuses to die, fighting back, no sleep for days",
  },
  "pixel-sorbet": {
    name: "Pixel Sorbet", genre: "Hyperpop",
    sound: "bubblegum hyperpop, sugary pitched-up synths, bouncy chiptune melodies, glossy supersaws, crunchy 808s, sudden glitch stutters, cartoon sound effects, 150-170 BPM",
    voice: "chirpy, pitched-up female vocal heavy on autotune, cute and breathless, with sudden screaming harmonies",
    bio: "Sounds like a candy store run by a heartbroken teenager.",
    themes: "a crush who leaves her on read, glitter stickers on a laptop, gas station slushies, prom alone, a cat named after a cartoon, crying in a bathroom",
  },
  "bitcrush-bridesmaid": {
    name: "Bitcrush Bridesmaid", genre: "Hyperpop",
    sound: "digicore hyperpop, rapid tempo switches, glitchy trance synths, bitcrushed drums, distorted guitars in the bridge, abrupt drops into silence, chaotic stereo panning, 140-180 BPM",
    voice: "emo male tenor with extreme autotune and pitched doubles, raw crying high notes, quick spoken asides",
    bio: "Wrote his first album in the bridesmaid dress he kept from his sister's wedding and has never explained why.",
    themes: "a wedding he was not invited to, an ex's new partner, online friends never met in person, three days awake, hair dye gone wrong",
  },
  "velcro-angel": {
    name: "Velcro Angel", genre: "Hyperpop",
    sound: "dreamy hyperpop ballad, shimmering arpeggiated synths, heavy reverb, a slow-building trance drop, sparse glitchy beats, cascading vocal chops, 120-140 BPM",
    voice: "airy, wistful androgynous vocal in soft autotune, floating harmonies that splinter into glitchy fragments",
    bio: "Sounds like a lullaby that got stuck to a broken speaker.",
    themes: "a childhood bedroom repainted, a parent's old voicemail, a long-distance love in another time zone, a dead phone at a festival, starting over",
  },
  "bleached-halo": {
    name: "Bleached Halo", genre: "Shoegaze",
    sound: "classic heavy shoegaze: three fuzz guitars through reverse reverb and tremolo bends, droning bass, motorik drums, waves of feedback between choruses, 100-130 BPM",
    voice: "a hushed boy-girl duet, both voices breathy and half-drowned in guitar",
    bio: "Four friends who turned the amps up until the room forgot what words were.",
    themes: "summers ending, chlorine and sunburn, a car stereo left on in the dark, being seventeen and certain of nothing",
  },
  "sunken-carousel": {
    name: "Sunken Carousel", genre: "Shoegaze",
    sound: "dream-pop shoegaze: chorused clean guitars over pillowy fuzz, Juno pads, a drum machine with soft live toms, glassy chimes, slow sway, 70-95 BPM",
    voice: "a lone soprano, airy and sighing, stacked in soft harmonies like distant radio",
    bio: "Songs that sound like a fairground heard from the bottom of a lake.",
    themes: "seaside towns out of season, a shut-down pier, swimming at night, old photos with the colour bleeding out",
  },
  "ivy-tremolo": {
    name: "Ivy Tremolo", genre: "Shoegaze",
    sound: "noise-pop shoegaze: buzzsaw guitars, overdriven bass, fast pounding drums, bursts of white-noise feedback, short punchy songs under 3 minutes, 140-170 BPM",
    voice: "a bright, girlish alto, sweet melody sung flat and cool over the din",
    bio: "A bedroom songwriter who plays sugar-pop tunes through a jet engine.",
    themes: "crushes on the night bus, borrowed jumpers, fluorescent supermarkets at midnight, running away for one afternoon",
  },
  "smokeglass-arcade": {
    name: "Smokeglass Arcade", genre: "Trip-Hop",
    sound: "cinematic trip-hop: slow heavy breakbeats, dub bass, sampled string swells and spy-film harpsichord, scratched vinyl, theremin-like synth, 70-85 BPM",
    voice: "a smoky female contralto, close and conspiratorial, rising to a cool falsetto",
    bio: "A duo who score films nobody has shot, one rain-soaked alley at a time.",
    themes: "night ferries, hotel bars, people running from something unnamed, surveillance, borrowed names, cities after rain",
  },
  "marisol-quay": {
    name: "Marisol Quay", genre: "Trip-Hop",
    sound: "jazzy downtempo trip-hop: brushed breakbeat loops, upright bass, muted trumpet, warm Rhodes, vinyl hiss, light bossa guitar figures, 80-95 BPM",
    voice: "a soft, husky mezzo, sung almost spoken, warm and late-night tender",
    bio: "A harbour-city singer who sounds like the last set in a bar about to close.",
    themes: "dock lights, cigarette breaks on a fire escape, lovers who keep missing each other, letters in a second language",
  },
  "parlour-undertow": {
    name: "Parlour Undertow", genre: "Trip-Hop",
    sound: "dark industrial trip-hop: crushed lo-fi drums, distorted sub bass, detuned piano, clanking metal percussion, eerie music-box loops, 65-80 BPM",
    voice: "a low male baritone, murmured and weary, doubled by a whisper an octave up",
    bio: "A haunted front room of a band, where the wallpaper is always peeling.",
    themes: "insomnia, damp flats, a TV left on all night, families not speaking, a seaside town in winter, guilt that will not leave",
  },
  "aisling-dunleavy": {
    name: "Aisling Dunleavy", genre: "Celtic",
    sound: "slow Celtic ballads: fingerpicked guitar and harp, low whistle, a fiddle answering each line, soft bodhrán on the last verse, 60-90 BPM",
    voice: "a clear, pure soprano with gentle ornamentation, unhurried and plain",
    bio: "A singer from a coast road who keeps the sad songs alive by singing them slowly.",
    themes: "emigrant ships, drowned fishermen, hiring fairs, lovers parted by the sea, a lighthouse keeper's daughter, famine roads",
  },
  "kilbrack-ramblers": {
    name: "The Kilbrack Ramblers", genre: "Celtic",
    sound: "driving trad band: sets of jigs and reels on fiddle, uilleann pipes, flute, button accordion, bouzouki and bodhrán, long tune sets with only a short sung verse, 110-140 BPM",
    voice: "mostly tunes; a gruff male lead and group shouts for a verse and chorus between reels",
    bio: "Five musicians who learned their tunes in a pub back room and never left.",
    themes: "session nights, crossroads dances, mart days, a hare in the bog field, wedding feasts, the last bus out of the village",
  },
  "corran-shay": {
    name: "Corran Shay", genre: "Celtic",
    sound: "rowdy Celtic folk-rock: strummed acoustic guitar, banjo, fiddle, tin whistle, upright bass and stomping bodhrán, gang choruses, 120-150 BPM",
    voice: "a big, raw male tenor, grinning and hoarse, built for singing over a crowded room",
    bio: "A docker's son who writes drinking songs with a knife hidden in every chorus.",
    themes: "dock strikes, sea shanties, emigrants in Boston, card games, jailbreaks, landlords, wakes that turn into parties",
  },
  "coldframe-assembly": {
    name: "Coldframe Assembly", genre: "Techno",
    sound: "hypnotic warehouse dub techno: rumbling kick, dubbed-out chord stabs, long delay tails, metallic percussion, slow filter sweeps over 8-minute arcs, 128-134 BPM",
    voice: "instrumental: a modular rig and a drum machine in a concrete room",
    bio: "A producer who builds tracks like clockwork and lets them run until dawn.",
    themes: "power stations, night shifts, freight yards, concrete stairwells, the hour the club lights come up",
  },
  "kiln-operator": {
    name: "Kiln Operator", genre: "Techno",
    sound: "industrial hard techno: distorted rolling kick, crushed noise layers, clanging steel samples, relentless 16th hats, harsh acid squelch, 140-150 BPM",
    voice: "instrumental: overdriven drum machines and furnace-hot synths",
    bio: "Techno forged at furnace temperature and hammered flat.",
    themes: "foundries, rail welds, sodium lamps, hydraulic presses, molten metal, the third hour of a warehouse rave",
  },
  "substation-nine": {
    name: "Substation Nine", genre: "Techno",
    sound: "melodic futurist techno: crisp 909 groove, warm analog pads, arpeggiated synth melodies, string-machine chords, soulful and bright, 122-128 BPM",
    voice: "instrumental: analog synthesizers and a 909 under city lights",
    bio: "A transmitter on the edge of town broadcasting hope to the night buses.",
    themes: "elevated trains, satellite dishes, sunrise over car plants, signals from orbit, empty highways at 5am",
  },
  "glacier-census": {
    name: "Glacier Census", genre: "Post-Rock",
    sound: "crescendo post-rock: chiming tremolo-picked guitars, swelling bass, drums from brushes to pounding toms, glockenspiel, explosive distorted climaxes, 70-120 BPM",
    voice: "instrumental: three guitars, bass and drums in a big wooden hall",
    bio: "Four musicians who measure a song in how long it takes the ice to break.",
    themes: "melting glaciers, research stations, radio static at the pole, slow catastrophes, the last expedition home",
  },
  "atlas-of-small-weather": {
    name: "Atlas of Small Weather", genre: "Post-Rock",
    sound: "chamber post-rock: piano, cello, violin, clean reverb guitar, trumpet, soft programmed beats and field recordings, delicate builds to warm swells, 60-100 BPM",
    voice: "instrumental: piano, strings and guitar recorded in a church",
    bio: "A small orchestra that writes symphonies about puddles and kitchen windows.",
    themes: "fog on allotments, a kettle at dawn, snow on a bus shelter, frost patterns, a child's weather diary",
  },
  "orrery-fields": {
    name: "Orrery Fields", genre: "Post-Rock",
    sound: "heavy math-tinged post-rock: interlocking tapped guitars, odd-time grooves in 7/8 and 5/4, synth drones, bowed guitar, crushing doom-like finales, 90-150 BPM",
    voice: "instrumental: a guitar army with synths and a thunderous drummer",
    bio: "A band that plays like planets colliding in slow motion.",
    themes: "orbits, eclipses, observatories, abandoned space programs, deep time, the moment before impact",
  },
  "mesa-furnace": {
    name: "Mesa Furnace", genre: "Rock",
    sound: "stoner desert rock, fuzz-drenched down-tuned guitars through cranked tube amps, hypnotic repeating riffs, round overdriven bass, loose heavy drums with big open hats, long jammed outros, dry live-room production, 70-100 BPM",
    voice: "smoky male baritone, half-crooned and half-howled, unhurried and cool over the fuzz, doubled on the choruses",
    bio: "Three friends who learned to play by running a generator out past the last streetlight and seeing how loud the canyon would let them get.",
    themes: "heat shimmer on empty highways, generator parties, coyotes, broken-down vans, long nights under too many stars",
  },
  "corner-shop-royals": {
    name: "Corner Shop Royals", genre: "Rock",
    sound: "Britpop-style guitar pop, jangly and crunchy twin guitars, swaggering bass, Hammond organ swells, tambourine, terrace-chant singalong choruses, string section on the ballads, bright mid-90s production, 100-130 BPM",
    voice: "cocky male tenor with a nasal working-class sneer, swaggering verses and soaring chant-along choruses",
    bio: "They write songs about the high street like it is the center of the universe, and on a Friday night it is.",
    themes: "Friday paydays, bus shelters, the chip shop after closing, mates who never left town, cheap lager and big dreams",
  },
  "skyline-engine": {
    name: "Skyline Engine", genre: "Rock",
    sound: "arena stadium rock, huge open-chord guitars, chiming delay leads, thundering reverb-heavy drums, synth pads under the chorus, piano intros, gang vocal stacks, key-change final choruses, polished widescreen production, 110-140 BPM",
    voice: "soaring male tenor with a big clean belt, reaches for the high note on every chorus and lands it",
    bio: "Every song is built to be sung back by fifty thousand people holding up their phones.",
    themes: "hometown heroes, last chances, holding on through hard years, open highways, standing together under stadium lights",
  },
  "concrete-valentines": {
    name: "Concrete Valentines", genre: "Rock",
    sound: "post-punk revival, angular staccato guitars, choppy disco-punk hi-hats, melodic driving bass high in the mix, cold synth stabs, tight dry drums, dancefloor-ready rhythm with dark minor chords, 125-145 BPM",
    voice: "detached cool male baritone, clipped deadpan delivery that cracks into a yelp on the chorus",
    bio: "Sounds like a city at 2 a.m. dancing just to stay warm.",
    themes: "tower blocks, last trains, cold romance, fluorescent office hours, nightclub queues, saying the wrong thing on purpose",
  },
  "hollerbone": {
    name: "Hollerbone", genre: "Rock",
    sound: "blues-rock power trio, overdriven Les Paul through a vintage amp, slide guitar, pentatonic solos, thick rocking bass, swinging heavy drums, shuffle and stomp grooves, live-off-the-floor analog production, 85-125 BPM",
    voice: "gravelly male voice with a gospel-trained shout, bends notes like the guitar does",
    bio: "A three-piece that plays every gig like the bar might burn down before last call.",
    themes: "river towns, crooked card games, working the night shift, owing the wrong people, a woman who left with the truck",
  },
  "damp-cardigan": {
    name: "Damp Cardigan", genre: "Rock",
    sound: "early-90s grunge, quiet-verse loud-chorus dynamics, sludgy drop-D distorted guitars, chorus-pedal clean verses, grinding bass, pounding floor toms and crashing cymbals, raw garage production, 90-130 BPM",
    voice: "hoarse male voice that mumbles the verses and tears itself open screaming the choruses",
    bio: "Four flannel-wearing outcasts who turned a rainy town's boredom into feedback.",
    themes: "rain that never stops, apathy, thrift-store jackets, parents who do not get it, dead-end jobs, wanting to feel anything",
  },
  "gilded-ramparts": {
    name: "Gilded Ramparts", genre: "Metal",
    sound: "European-style power metal, galloping double-kick drums, harmonized twin guitar leads, neoclassical shred solos, bombastic keyboard orchestration, choir-backed major-key anthems, triumphant key changes, 150-190 BPM",
    voice: "operatic male tenor with soaring clean high notes and long vibrato, no harsh vocals",
    bio: "A band that treats every chorus like the final charge of a war that has already been won.",
    themes: "castle sieges, dragon-slaying oaths, banners at dawn, brotherhood of the sword, ancient prophecies, riding into the storm",
  },
  "bog-engine": {
    name: "Bog Engine", genre: "Metal",
    sound: "Southern sludge metal, crushingly slow detuned riffs, thick fuzz-and-feedback guitars, grinding bass, swampy groove drums that lurch into mid-tempo stomps, harsh noise swells, murky heavy production, 55-90 BPM",
    voice: "bellowing male roar, throat-shredded and bluesy, sludgy shouts more than growls",
    bio: "Plays riffs so heavy and slow they feel like wading through swamp mud in steel-toe boots.",
    themes: "swamp heat, rusted machinery, hurricanes, flooded towns, bad whiskey, generational grudges",
  },
  "tippy-levee": {
    name: "Tippy Levee", genre: "Hip-Hop",
    sound: "Southern New Orleans bounce, chopped call-and-response chants, triggerman-style drum loop, booming 808 kicks, fast hi-hats, brass band horn stabs, shouted crowd hooks, party-ready mix, 98-105 BPM double-time feel",
    voice: "loud, bubbly female MC with a thick Gulf Coast accent, rapid call-and-response flow made to make a crowd shout back",
    bio: "Turns every block party into a parade and every parade into a block party.",
    themes: "second-line Sundays, crawfish boils, hurricane season, dancing on porches, neighborhood pride, getting the whole room to move",
  },
  "sixgear-odell": {
    name: "Sixgear Odell", genre: "Hip-Hop",
    sound: "Midwest chopper rap, rapid-fire double-time verses, dark minor-key piano and string loops, tight snappy snares, rumbling 808s, eerie synth leads, polished punchy mix, 140-150 BPM with half-time grooves",
    voice: "nimble male rapper with machine-gun precision, switches between blistering speed and a slow, menacing drawl",
    bio: "Can fit a whole paragraph into one bar and still make you hear every word.",
    themes: "cold winters on factory blocks, overtime, proving doubters wrong, outrunning bad luck, family kitchen tables",
  },
  "tess-dormer": {
    name: "Tess Dormer", genre: "Pop",
    sound: "bedroom pop, hazy lo-fi production, chorus-washed electric guitar, soft drum machine, warm wobbly synths, finger snaps, cassette tape saturation, intimate close-miked mix, 75-100 BPM",
    voice: "soft, breathy female voice, close to the mic and half-whispered, gentle double-tracked harmonies",
    bio: "Recorded her first songs under a duvet so her roommates would not hear, and that is exactly how they sound.",
    themes: "crushes she never told, late-night texts, fairy lights, laundry piles, sunsets from the bus window, growing up a little at a time",
  },
  "saturday-detention": {
    name: "Saturday Detention", genre: "Pop",
    sound: "2000s teen pop-rock, crunchy power-chord guitars, bright clean verses, punchy pop-punk drums, singalong whoa-oh hooks, handclaps, polished radio-ready production, 140-170 BPM",
    voice: "bright energetic female lead with a sassy spoken-word bridge and a big clear chorus belt",
    bio: "Sounds like the soundtrack to a teen movie montage where somebody finally gets their revenge.",
    themes: "high school hallways, prom night, ex-boyfriends, best friends forever, sneaking out, summer before senior year",
  },
  "wade-purcell": {
    name: "Wade Purcell", genre: "Country",
    sound: "1990s neotraditional country, twangy Telecaster, crying pedal steel, fiddle fills, shuffling two-step drums, walking bass, honky-tonk piano, clean bright Nashville production, 95-130 BPM",
    voice: "warm, smooth male baritone with a gentle Texas twang, sincere and unhurried",
    bio: "Wears a pressed hat to every show because his grandmother said a man should look like he means it.",
    themes: "dancehall Saturdays, small-town romance, cattle auctions, keeping promises, Sunday supper, a jukebox that knows his heartbreak",
  },
  "cottonwood-steel-swingers": {
    name: "Cottonwood Steel Swingers", genre: "Country",
    sound: "Western swing dance band, twin fiddles, lap steel guitar, big-band horn section, jazzy upright bass, swinging brushed snare, boogie-woogie piano, hollering bandleader asides, warm vintage room sound, 120-180 BPM",
    voice: "easygoing male crooner with a smile in his voice, plus playful band shouts between solos",
    bio: "A ten-piece dance hall band that never met a two-step it could not turn into a jitterbug.",
    themes: "Saturday dance halls, cowboy romance, cotton harvests, swinging partners, prairie sunsets, Texas towns with one stoplight",
  },
  "spare-key-funeral": {
    name: "Spare Key Funeral", genre: "Emo",
    sound: "Midwest emo, twinkly interlocking clean guitars in odd tunings, math-rock time changes, melodic busy bass, trumpet swells on the climaxes, quiet verses bursting into loud gang-shouted endings, 120-160 BPM",
    voice: "cracking male tenor, half-spoken verses that strain into hoarse yells, a friend shouting harmony on the last chorus",
    bio: "Four friends who still have keys to each other's parents' houses and write songs about why they never give them back.",
    themes: "basement shows, friends moving away, porch lights, leaving the hometown, apologising late, borrowed hoodies, small-town winter",
  },
  "backseat-almanac": {
    name: "Backseat Almanac", genre: "Emo",
    sound: "2000s emo pop-punk crossover, crunchy palm-muted power chords, driving eighth-note bass, punchy double-time drums, big stacked choruses, a breakdown before the last hook, 150-185 BPM",
    voice: "nasal yearning male lead with high harmonies, a second singer screaming answer lines on the bridge",
    bio: "They keep a notebook in the glovebox of every car they have owned and every page became a song.",
    themes: "late-night drives, prom regrets, mall parking lots, mixtapes, the girl who moved to the coast, insomnia, cell signal dead zones",
  },
  "carport-elegy": {
    name: "Carport Elegy", genre: "Emo",
    sound: "slow-burning acoustic-to-electric emo, fingerpicked nylon guitar and soft brushes that swell into walls of reverb guitar, cello, slowcore pacing, sudden quiet after the crescendo, 70-100 BPM",
    voice: "soft confessional female alto, close and breathy, breaking into a ragged shout at the peak",
    bio: "She recorded the first songs in her father's carport at night so the neighbours would think it was the radio.",
    themes: "grief for a parent, the house being sold, voicemails saved for years, suburban summers, guilt, learning to drive alone",
  },
  "tangerine-postcode": {
    name: "Tangerine Postcode", genre: "Indie Pop",
    sound: "jangle-pop indie, chiming twelve-string guitars, melodic bass, upbeat tambourine and snare, handclaps, combo organ stabs, boy-girl harmonies, 120-140 BPM",
    voice: "boy-girl duet, a bright female lead with a dry deadpan male voice trading lines",
    bio: "A band from a seaside town that only exists in winter, writing summer songs to keep warm.",
    themes: "seaside towns off-season, bike rides, library cards, crushes on the bus, holiday jobs, rain on the pier, postcard messages",
  },
  "holly-marchbank": {
    name: "Holly Marchbank", genre: "Indie Pop",
    sound: "bedroom indie pop, soft drum machine and finger snaps, warm detuned synths, clean chorus-pedal guitar, toy piano, intimate lo-fi warmth with a crisp low end, 85-110 BPM",
    voice: "hushed close-miked female voice, double-tracked, playful and a little sleepy",
    bio: "She writes every song between the hour her flatmates go to bed and the first bus starts running.",
    themes: "flatshare life, text messages left on read, houseplants, slow Sunday mornings, overthinking, being twenty-four and fine-ish",
  },
  "lido-committee": {
    name: "The Lido Committee", genre: "Indie Pop",
    sound: "orchestral chamber indie pop, string quartet, brass section, glockenspiel, piano, sunny group choruses, baroque-pop arrangements with swelling builds, 100-128 BPM",
    voice: "warm baritone lead with a ragged choir of bandmates singing every chorus together",
    bio: "Eleven friends who formed a committee to save the town's outdoor pool and accidentally became a band.",
    themes: "civic pride, public swimming pools, town fetes, community halls, saving lost causes, long summers, local heroes",
  },
  "ticket-gate-starlight": {
    name: "Ticket Gate Starlight", genre: "J-Pop",
    sound: "idol J-pop, sparkling synths, bright four-on-the-floor and driving rock drums, funky slap bass, glossy brass hits, unison group choruses, call-and-response chants, key change finale, 140-170 BPM",
    voice: "five-member female group, bright energetic unison choruses, solo lines traded quickly, crowd chant ad-libs",
    bio: "Five commuters who met at the same station gate every morning and decided to turn the ride into a stage.",
    themes: "morning trains, school festivals, friendship promises, summer fireworks, first stage nerves, chasing a dream with your best friends",
  },
  "sayo-hanabira": {
    name: "Sayo Hanabira", genre: "J-Pop",
    sound: "anime-opening J-rock pop, fast crunchy guitars, pounding drums, piano runs, string stabs, soaring melody with dramatic stops and a huge key-changed final chorus, 165-190 BPM",
    voice: "powerful clear female soprano, rapid-fire verses, a soaring belted chorus with long held notes",
    bio: "Every song she sings sounds like the first episode of a story where the underdog wins.",
    themes: "rising after defeat, rival friends, rooftop promises, sky and wind, believing in yourself, final battles, holding on to hope",
  },
  "vending-machine-moon": {
    name: "Vending Machine Moon", genre: "J-Pop",
    sound: "city pop revival, lush Rhodes, slap bass, glittering synth brass, jazzy chords, breezy bossa and disco grooves, smooth sax solos, sunset-drive gloss, 100-120 BPM",
    voice: "male-female duo, airy smooth female lead with a soft crooning male harmony",
    bio: "A duo who write love songs about the glow of a vending machine at 2 a.m. on an empty street.",
    themes: "night drives along the bay, late convenience-store dates, city lights from the overpass, summer romance, missed last trains",
  },
  "hickory-switchback": {
    name: "The Hickory Switchback", genre: "Bluegrass",
    sound: "traditional hard-driving bluegrass, rolling three-finger banjo, fiddle breaks, mandolin chop, flatpicked guitar runs, upright bass, one-mic three-part harmonies, 110-160 BPM",
    voice: "high lonesome male tenor lead with baritone and high tenor harmony on every chorus",
    bio: "Five pickers from a hollow so deep the radio only got one station, and they learned every song it played.",
    themes: "mine disasters, river floods, county fairs, mama's gospel, trains leaving town, moonshine stills, the old home place",
  },
  "opaline-teague": {
    name: "Opaline Teague", genre: "Bluegrass",
    sound: "progressive newgrass, clawhammer and three-finger banjo, dobro slides, crosspicked guitar, fiddle and cello, adventurous chord changes and jam-like instrumental breaks, 90-140 BPM",
    voice: "clear crystalline female alto with a mountain lilt, close harmony from her fiddler",
    bio: "A fiddler's daughter who left the holler for the city and brought every ghost story with her.",
    themes: "leaving and coming home, Appalachian ghost stories, quilts and heirlooms, women who ran the farm, rivers, seasonal change",
  },
  "coal-tipple-brothers": {
    name: "Coal Tipple Brothers", genre: "Bluegrass",
    sound: "brother-duet bluegrass gospel, slow waltzes and murder ballads, mandolin tremolo, gentle guitar, sparse banjo, fiddle, tight sibling harmonies, 60-110 BPM",
    voice: "two brothers in close blood harmony, a weathered baritone lead and a piercing tenor above it",
    bio: "Two brothers who learned to harmonise over the roar of the coal tipple where their father worked.",
    themes: "murder ballads, deathbed hymns, mining towns, brotherhood, Sunday meetings, lost sweethearts, judgement and mercy",
  },
  "desmond-lorne": {
    name: "Desmond Lorne", genre: "Smooth Jazz",
    sound: "quiet storm smooth jazz, breathy tenor saxophone lead, lush Rhodes chords, fretless bass, soft brushed and programmed drums, warm string pads, slow ballads and slinky mid-tempo grooves, 65-95 BPM",
    voice: "instrumental: tenor saxophone, warm and breathy, long sustained melodies",
    bio: "A tenor player whose ballads are built for the hour after the last guest has left.",
    themes: "late nights, slow dances, candlelit dinners, rain on the window, anniversaries, the city after midnight",
  },
  "penthouse-weather": {
    name: "Penthouse Weather", genre: "Smooth Jazz",
    sound: "guitar-led smooth jazz fusion, clean octave-melody electric guitar, slap bass, crisp funky drums, glossy synth pads and piano comping, upbeat radio-ready grooves, 95-120 BPM",
    voice: "instrumental: clean electric jazz guitar playing octave melodies and fluid solos",
    bio: "A studio band that sounds like a sunny afternoon seen from the top floor of a glass tower.",
    themes: "rooftop afternoons, coastal drives, summer weekends, city skylines, open-top cars, golden-hour sunsets",
  },
  "marlo-steadman": {
    name: "Marlo Steadman", genre: "Smooth Jazz",
    sound: "light bossa and Latin-tinged smooth jazz, bright soprano saxophone lead, nylon-string guitar, grand piano, congas and shakers, airy flute doubles, breezy swaying grooves, 85-110 BPM",
    voice: "instrumental: bright singing soprano saxophone with nylon guitar answers",
    bio: "She plays soprano sax like she is describing a holiday you have not taken yet.",
    themes: "tropical holidays, beach cafes, sailing boats, morning coffee on a balcony, gentle romance, island breezes",
  },
  "faultline-bloom": {
    name: "Faultline Bloom", genre: "Dubstep",
    sound: "melodic dubstep, bright supersaw chords, emotional vocal chops, clean sub and singing reese bass drops, piano intros, cinematic risers, 140-150 BPM",
    voice: "soaring female soprano, clear and vulnerable, breathy in the breakdowns and belting into each drop",
    bio: "She writes heartbreak ballads, then lets the bass finish the sentence.",
    themes: "love after the argument, hospital waiting rooms, rebuilding a city after the quake, holding on while the ground moves",
  },
  "tessa-grail": {
    name: "Tessa Grail", genre: "Dubstep",
    sound: "deep chillstep and dark dubstep, sparse half-time drums, rumbling sub bass, rain and vinyl crackle textures, minor-key pads, slow dubby delays, 140 BPM half-time",
    voice: "low, smoky female alto, close-miked and hushed, almost whispered over the sub",
    bio: "A night-shift singer whose songs sound like a city heard through a bedroom wall.",
    themes: "insomnia, tower block windows, unsent texts, the 3 a.m. bus, loneliness in a crowded city",
  },
  "scrapyard-lullaby": {
    name: "Scrapyard Lullaby", genre: "Dubstep",
    sound: "heavy riddim and brostep, metallic growl basses, robotic screeches, crushing snare, aggressive sound-design drops with a sung pop hook in the build, 150 BPM",
    voice: "gritty male tenor with a rock edge, raw on the hook, layered and pitched up before the drop",
    bio: "A duo who build bass drops out of car crushers and then sing a lullaby on top.",
    themes: "junkyard machines, rage turned into dancing, broken things that still run, losing control on purpose",
  },
  "halcyon-relay": {
    name: "Halcyon Relay", genre: "Trance",
    sound: "uplifting vocal trance, soaring supersaw leads, rolling offbeat bass, gated pads, long piano breakdowns and euphoric snare-roll builds, 136-140 BPM",
    voice: "bright, crystalline female soprano, sincere and sustained, glowing reverb on long notes",
    bio: "Sunrise sets for people who cried at the festival and are not ashamed of it.",
    themes: "dawn over the festival field, long-distance love, flying home, the moment the whole crowd lifts its hands",
  },
  "aurelie-strand": {
    name: "Aurelie Strand", genre: "Trance",
    sound: "deep progressive trance, hypnotic plucked arpeggios, warm analog bass, slow-evolving pads, restrained drums, subtle builds instead of big drops, 128-132 BPM",
    voice: "soft, intimate female mezzo, breathy and close, half-spoken verses blooming into a sung hook",
    bio: "Her songs unfold like a coastline seen from a night train, slowly and all at once.",
    themes: "coastlines, night trains, memory and distance, quiet devotion, the edge of sleep",
  },
  "parallel-ascent": {
    name: "Parallel Ascent", genre: "Trance",
    sound: "psytrance-tinged tech trance, galloping rolling basslines, acid 303 squelches, driving hypnotic loops, sharp stabs and a big vocal breakdown, 138-145 BPM",
    voice: "commanding male baritone, chant-like and resonant, with a shimmering female harmony on the hook",
    bio: "Two producers who treat a dance floor like a launch sequence.",
    themes: "climbing toward the light, rockets and orbit, shared trance states, leaving the body, running out of night",
  },
  "torque-ward": {
    name: "Torque Ward", genre: "Industrial",
    sound: "industrial rock, distorted down-tuned guitars, pounding machine drums, sampled metal clangs, grinding synth bass, shouted gang choruses, 120-135 BPM",
    voice: "harsh male baritone, distorted through a bullhorn, snarling verses and a clear shouted hook",
    bio: "Factory-floor anthems for anyone who has been told to clock in and smile.",
    themes: "the time clock, overtime, the body as a machine part, strikes and sabotage, being watched at work",
  },
  "pressure-hymnal": {
    name: "Pressure Liturgy", genre: "Industrial",
    sound: "EBM and electro-industrial, sequenced pulsing synth bass, stomping drum machines, cold metallic percussion, hissing samples, marching rhythms, 115-125 BPM",
    voice: "deep, clipped male voice, half-sung and robotic, every line delivered like an order",
    bio: "A body-music project that turns a dance floor into a drill yard.",
    themes: "discipline and control, surveillance, crowds moving as one, propaganda broadcasts, breaking formation",
  },
  "odile-mercer": {
    name: "Odile Mercer", genre: "Industrial",
    sound: "slow cinematic industrial, crushing half-time beats, layered noise and power-tool textures, eerie music-box melodies, distorted strings, 85-100 BPM",
    voice: "fragile female soprano that cracks into a distorted scream, intimate verses and a haunting hook",
    bio: "She sings nursery melodies inside a steel mill and lets the machines answer.",
    themes: "childhood in a company town, rust and inheritance, grief as machinery, a voice surviving the noise",
  },
  "hearse-waltz": {
    name: "Hearse Waltz", genre: "Darkwave",
    sound: "cold minimal darkwave, steady drum machine, pulsing analog bass sequence, icy synth pads, sparse bell lead, cavernous reverb, 105-118 BPM",
    voice: "deep, mournful male baritone, steady and unhurried, lingering on the ends of lines",
    bio: "Slow-dance music for the last two people left in the club at closing time.",
    themes: "cemetery gates at dusk, dancing with the dead, faded photographs, winter streets, quiet devotion",
  },
  "sister-vesper": {
    name: "Sister Vesper", genre: "Darkwave",
    sound: "ethereal darkwave, chorus-drenched shimmering guitars, melodic lead bass, layered choir-like synths, gentle tribal drum machine, dreamy reverb, 95-110 BPM",
    voice: "airy, otherworldly female soprano, layered harmonies, sung like a prayer in an empty chapel",
    bio: "A candlelit voice that sounds like it is singing from the other side of the glass.",
    themes: "candlelight vigils, ghosts in the house, sleepwalking, vanished sisters, the hour between dusk and night",
  },
  "candlewax-theory": {
    name: "Candlewax Theory", genre: "Darkwave",
    sound: "danceable gothic synth-pop, punchy drum machine, driving octave synth bass, sharp minor-key synth hooks, handclaps, cold dancefloor energy, 120-128 BPM",
    voice: "cool, detached mixed-gender duet, flat deadpan male verses against a soaring female chorus",
    bio: "A duo who make heartbreak sound like the best night out of the year.",
    themes: "dancing alone in black, dead phone batteries, lovers who never call back, cold apartments, pretty sadness",
  },
  "telephone-pastel": {
    name: "Telephone Pastel", genre: "New Wave",
    sound: "jittery new wave pop, choppy clean guitars, bright analog synth riffs, busy melodic bass, tight snappy drums, group backing shouts, 135-150 BPM",
    voice: "yelping, nervous male tenor, wry and theatrical, with sharp shouted backing vocals",
    bio: "A quartet who write love songs to answering machines and office photocopiers.",
    themes: "office parties, answering machines, shopping malls, awkward crushes, modern life that is slightly too fast",
  },
  "gemma-polaroid": {
    name: "Gemma Polaroid", genre: "New Wave",
    sound: "bright synth-led new wave pop, sparkling polysynth chords, catchy synth lead lines, punchy electronic drums, chiming guitars, glossy chorus, 118-128 BPM",
    voice: "clear, cool female alto, cheeky and confident, hiccups and spoken asides between lines",
    bio: "A suburban pop star who sings about the future like it is already a little dated.",
    themes: "instant photos, roller rinks, suburban boredom, television dreams, first dates in the shopping arcade",
  },
  "strict-geometry": {
    name: "Strict Geometry", genre: "New Wave",
    sound: "angular art-wave and post-punk pop, rigid robotic drums, wiry staccato guitars, buzzing mono synths, funky clipped bass, odd stops and starts, 125-140 BPM",
    voice: "flat, deadpan male voice, half-spoken and robotic, cracking into a shouted chorus",
    bio: "A band that dances like a diagram and sings like an instruction manual.",
    themes: "grids and floor plans, conformity, consumer manuals, robots at the dinner table, rules that make no sense",
  },
};

/**
 * How a genre is written and performed: the album plan, the words and the
 * music model's brief all read it, so a rapper raps and a punk band does not
 * write a ballad. A genre without one gets the general rules only.
 */
export interface GenreCraft {
  /** Rapped verses (hooks may be chanted or sung), sung throughout, or no voice at all (no words are written). */
  delivery: "rapped" | "sung" | "instrumental";
  /** How the words are built: form, rhyme, point of view, what makes it the genre. */
  lyrics: string;
  /** What the record sounds like beyond the artist's own sound. */
  production: string;
  /** What the music model is told to leave out. */
  avoid: string;
}

const RAP_FORM = [
  "Rap structure: [Intro] of 1-2 ad-lib lines, [Verse 1] of 12-16 bars (one bar per line), [Hook] of 4 lines, [Verse 2] of 12-16 bars, [Hook] again, optional [Verse 3] or [Outro].",
  "No pre-chorus, no bridge. Every verse line is a full bar of 9-15 syllables with internal and multisyllabic rhymes (slant rhymes welcome) chained across lines, not just end rhymes on simple words.",
  "Verses tell a story in first person with specific detail: a street, a car model year, a sum of money, a time of night, what someone said. Punchlines and wordplay land at the end of every 4 bars.",
  "The hook is short, chantable and rhythmic, repeated phrases, not a sung pop melody.",
].join(" ");

const CRAFT: Record<string, GenreCraft> = {
  "gangsta-rap": {
    delivery: "rapped",
    lyrics: `${RAP_FORM} Gangsta rap is street reportage: hard, cinematic first-person crime stories with consequences (arrests, funerals, betrayal, paranoia), bravado earned by detail, slang that fits the region, dark humour. Mild profanity is fine; no slurs, no real names of people, gangs or places' crews. Never preachy, never a happy ending tied in a bow.`,
    production: "Hard-hitting mix, loud punchy drums and heavy bass up front, the rap vocal dry and on top of the beat, ad-libs and hype doubles at line ends.",
    avoid: "singing in the verses, autotune pop melodies, acoustic guitar, EDM drops, uplifting choirs, cheerful major-key pop",
  },
  "hip-hop": {
    delivery: "rapped",
    lyrics: `${RAP_FORM} Hip-hop with real bars: confident, witty, specific, a clear point of view, no motivational-poster lines.`,
    production: "Punchy drums and bass up front, the rap vocal dry and clear on top, ad-libs at line ends.",
    avoid: "singing in the verses, cheesy pop melodies, acoustic strumming, EDM drops",
  },
  punk: {
    delivery: "sung",
    lyrics: "Punk: short, fast, angry and funny. Two-line or four-line verses that spit a specific grievance (a landlord, a boss, a bus that never comes), a shout-along chorus of 2-4 words repeated, no bridge or a 2-line breakdown. Blunt plain words, no poetry-class metaphors.",
    production: "Raw live-room energy, loud distorted guitars, shouted gang vocals on the chorus.",
    avoid: "polished pop vocals, synths, slow ballad sections, autotune",
  },
  blues: {
    delivery: "sung",
    lyrics: "Blues: AAB verses (a line, the same line again with a small twist, then a line that answers it), 3-5 verses, call-and-response with the guitar, earthy concrete detail (rent, rain, the 5:15 train, a woman or man who left), wry humour inside the hurt.",
    production: "Live band in a small room, expressive guitar fills between the vocal lines.",
    avoid: "pop chorus hooks, synths, autotune, polished modern production",
  },
  country: {
    delivery: "sung",
    lyrics: "Country: a story song with a twist in the last chorus, names, places and objects (a pawned guitar, a county road number, a diner waitress), a turn of phrase in the hook that means two things. Plain-spoken, conversational lines.",
    production: "Warm organic band, upfront vocal with natural twang.",
    avoid: "EDM drums, trap hi-hats, autotune, generic stadium pop",
  },
  jazz: {
    delivery: "sung",
    lyrics: "Jazz standard form: AABA, 32 bars, sophisticated adult wit, internal rhymes, a clever title phrase turned three ways, late-night city detail.",
    production: "Acoustic small group, natural room sound, solos between choruses.",
    avoid: "pop drums, synths, autotune, rap",
  },
  metal: {
    delivery: "sung",
    lyrics: "Metal: dark, mythic or apocalyptic imagery made concrete, short punchy lines that fit riffs, a chanted chorus, a breakdown section of 2-4 lines. No self-help language.",
    production: "Crushing tight guitars, powerful drums, huge low end.",
    avoid: "pop vocals, acoustic softness, synth-pop, rap",
  },
  "classic-rock": {
    delivery: "sung",
    lyrics: "Classic rock: swaggering, sensual or road-worn stories, a riff-shaped chorus with a memorable title phrase, characters and places, a little danger.",
    production: "Analog 1970s band sound, warm tube amps, live drums.",
    avoid: "modern pop gloss, trap drums, autotune, synths",
  },
  rock: {
    delivery: "sung",
    lyrics: "Rock: concrete images and a story, a chorus built on a strong title phrase, verses that move the story on.",
    production: "Big live band, guitars and drums up front.",
    avoid: "autotune, trap drums, EDM drops",
  },
  pop: {
    delivery: "sung",
    lyrics: "Pop: a single sharp title idea, conversational verses with specific moments (a text message, a dress, a parking lot at 2 a.m.), a chorus that is instantly singable and repeats the title.",
    production: "Polished modern mix, vocals bright and forward.",
    avoid: "muddy lo-fi, out-of-tune vocals, rap verses",
  },
  rnb: {
    delivery: "sung",
    lyrics: "R&B: intimate, sensual, adult, specific (a hotel key, a voicemail, a late shift), melismatic hook phrases, a pre-chorus that builds tension.",
    production: "Smooth warm low end, lush stacked harmonies, ad-libs.",
    avoid: "rock guitars, EDM drops, stiff robotic vocals",
  },
  synthwave: {
    delivery: "sung",
    lyrics: "Synthwave: cinematic, nocturnal, a movie told in images, short evocative lines.",
    production: "Retro analog synths, gated reverb drums, wide stereo.",
    avoid: "acoustic instruments, trap hi-hats, modern pop vocal effects",
  },
  classical: {
    delivery: "instrumental",
    lyrics: "Classical, no words: each track is a complete concert piece or movement with a real form (sonata-allegro, rondo, theme and variations, nocturne, etude, scherzo, adagio, fugue, tone poem). Titles read like a concert programme: the form, a key, and an evocative subtitle, e.g. 'Nocturne in C-sharp minor, \"Harbor Fog\"' or 'Symphony No. 1: II. Adagio'. An album is a recital or a full multi-movement work. Each style names the form, key, tempo marking (Allegro, Andante, Largo...), the instruments that lead and the emotional arc (a quiet opening, the climax, how it resolves).",
    production: "Recorded live in a concert hall, natural acoustic reverb, wide dynamic range from pianissimo to fortissimo, real acoustic instruments only.",
    avoid: "vocals, singing, choir words, drums, drum kit, beats, bass guitar, synthesizers, electronic sounds, pop song structure, modern cinematic trailer hits",
  },
  "reggae": {
    delivery: "sung",
    lyrics: "Reggae: verse-chorus songs with short, plain lines of 6-9 syllables that sit on the offbeat and leave room for the riddim, a chorus repeated two or three times like a chant the crowd can answer. Point of view is first person testifying or second person addressing the listener, a brother, a sister, the system. Ground it in concrete yard life (the zinc fence, the minibus, the market, the rent, rain on the river) and let the message come from the scene instead of slogans; an occasional patois touch is fine, never caricature. Leave a bar or two of space where the singer just hums or repeats a phrase.",
    production: "Bass and kick drum forward and warm, guitar and organ skank tight on the offbeat, spring reverb and tape echo throws on snare and vocal tails.",
    avoid: "rapping, trap hi-hats, EDM drops, four-on-the-floor kick, distorted rock guitars, autotune, pop-punk energy, orchestral strings",
  },
  "latin": {
    delivery: "sung",
    lyrics: "Latin: sung mostly in English with a few short Spanish phrases placed where they hit hardest (the hook tag, a call-out, a pet name), never a whole translated verse. Form is intro tag, verse, a pre-chorus that climbs, a chorus built on one repeatable line, a short bridge and a last double chorus; lines are short and percussive, 5-8 syllables, with rhymes that land on the dembow accents. Be physical and specific: the dance floor, the heat, the car at the curb, the ex at the same party, the grandmother's kitchen, the city at 3 a.m. Flirt, boast and ache in the same song; never stack cliches like fuego, corazon and bailar back to back.",
    production: "Punchy dembow or tropical groove up front, sub bass glued to the kick, crisp claps and shakers, vocals bright and close with short delays on the Spanish tags.",
    avoid: "rock drum kit, heavy metal guitars, country twang, operatic vocals, jazz swing, mariachi brass, slow ballad tempo, Spanish-only lyrics",
  },
  "house": {
    delivery: "sung",
    lyrics: "House: lyrics are sparse and built for repetition: one strong hook line of 4-8 words that returns again and again, a short verse of 4 lines that sets a scene, and a breakdown where a single phrase is sung bare before the drop. Write in first or second person, present tense, aimed at the room (the lights, the floor, the stranger beside you, the sunrise outside), with gospel lift or late-night longing rather than abstract positivity. Fewer words is better; leave long instrumental stretches for the groove and write the hook so it still works chopped into fragments.",
    production: "Four-on-the-floor kick with a long DJ-friendly intro and outro, open hi-hats on the offbeat, side-chained pads, a clear breakdown and build back into the full groove.",
    avoid: "rapped verses, live rock drum kit, distorted guitars, half-time trap beats, country instruments, acoustic singer-songwriter arrangement, dubstep wobble bass",
  },
  "drum-n-bass": {
    delivery: "sung",
    lyrics: "Drum & Bass: the vocal floats over a 170-176 BPM break, so write long held lines of 6-10 syllables with a half-time feel, not a rush of words. Form is intro, a verse, a hook that lands right before the drop, the drop itself carrying only a chopped vocal fragment or a short MC call, a second verse and a final drop. Imagery is motion and night (the night bus, motorway lights, a tower block window, the rave in the rain, the comedown at dawn), first person, intimate, a little haunted. An MC section may chant short rhythmic calls on the beat, but keep it brief.",
    production: "Crisp chopped breakbeats or rolling two-step drums at 170-176 BPM, a huge clean sub bass, a clear drop after a filtered build, vocals reverb-washed in the intro and dry in the drop.",
    avoid: "slow tempo, four-on-the-floor house kick, trap 808 rolls, country twang, acoustic folk arrangement, orchestral pomp, autotuned pop rap",
  },
  "funk-n-soul": {
    delivery: "sung",
    lyrics: "Funk & Soul: soul songs are stories with a turn: verse, verse, chorus, a bridge that confesses or pleads, and a vamped ending where the singer ad-libs and the band answers. Lines run 7-11 syllables with full rhymes, call-and-response with backing singers on the chorus, and one plain-spoken title line that carries the whole song. Funk tracks flip it: short chanted lines, commands to the band and the dancers, the groove itself named in the lyric. Be concrete (the Friday paycheck, the bus fare, the church fan, the porch light left on, new shoes for the dance) and earn the emotion instead of shouting it.",
    production: "Live band in a room: tight drums, upfront bass, scratchy rhythm guitar, horn section stabs, Hammond or Rhodes, warm analog tape and real backing singers.",
    avoid: "drum machines, trap hi-hats, EDM drops, autotune, distorted metal guitars, rapped verses, country twang, synthwave arpeggios",
  },
  "gospel": {
    delivery: "sung",
    lyrics: "Gospel: testimony in the first person, a real trouble named plainly (the eviction notice, the hospital hallway, the son who stopped calling) answered by faith, never a sermon about faith in the abstract. Verse, pre-chorus, chorus, then a vamp: a 3-6 word phrase repeated and built ('He made a way', 'I'm still here') with ad-lib lines for the lead and call-and-response for the choir. Short singable lines, scripture images used as pictures (Jordan, the upper room, morning) rather than quoted verbatim, and a key-change lift into the last chorus.",
    production: "Live church-room feel: Hammond organ with Leslie, gospel piano chords, a choir panned wide behind the lead, hand claps and a drummer who plays the shouts.",
    avoid: "trap hi-hats, autotune, distorted guitars, EDM drops, rapping, whispery indie vocals, synth pads in place of organ",
  },
  "afrobeats": {
    delivery: "sung",
    lyrics: "Afrobeats: groove first, so lines are short, bouncy and syllable-light, sitting on the off-beat; verse, pre-hook, hook, verse, hook, with the hook a chantable 2-6 word phrase repeated four times. First person and present tense, flirting, celebrating or flexing with concrete scenes (a Friday night in the city, the tailor fitting a new outfit, the dance-floor stare, the generator kicking on). English with a light pidgin-style lilt in the phrasing and playful call-backs; joy and swagger, not heartbreak poetry.",
    production: "Crisp syncopated percussion (shakers, talking drum, log drum or rim clicks), warm sub bass, clean melodic guitar or keys, vocals stacked and doubled with airy harmonies on the hook.",
    avoid: "rock drum kit backbeat, distorted guitars, heavy metal, country twang, operatic vocals, four-on-the-floor EDM build-ups, trap rap verses",
  },
  "k-pop": {
    delivery: "sung",
    lyrics: "K-Pop: a high-concept song built on one bold image or mission (a heist, a signal, a summer that will not end), structured verse, pre-chorus, a big chantable chorus, a short rap or spoken break, then a bridge that drops before the final chorus explodes. Write a 1-3 word signature hook that repeats and can be shouted by a crowd, punchy short lines with internal rhyme, and lines traded between members with 'we' and 'you' as the point of view. Keep every word English; carry the K-pop flavour through rhythm, chants and onomatopoeia, not foreign words.",
    production: "Maximal and glossy with genre switches: tight synth bass, layered group vocals, sudden beat changes between sections, and a hard-hitting drop in the chorus.",
    avoid: "lo-fi tape hiss, acoustic folk strumming, long guitar solos, country instrumentation, mumbled vocals, slow blues tempos",
  },
  "folk": {
    delivery: "sung",
    lyrics: "Folk: story first. Strophic 4-line verses rhymed ABCB or AABB, a plain refrain line that returns after each verse, and 4-7 verses that move a real narrative forward in time (a mine closing, a ferry crossing, a brother gone west). Concrete nouns, place names, weather and work; one voice telling it straight, often third person or an 'I' who witnessed it. No modern slang and no pop chorus; the plainer the words, the harder they land.",
    production: "Close-miked acoustic instruments in a small room, little or no drums, natural reverb and audible fingers on strings.",
    avoid: "electric distortion, synthesizers, drum machines, autotune, EDM, rapping, slick pop vocal runs",
  },
  "disco": {
    delivery: "sung",
    lyrics: "Disco: the dance floor is the subject and the escape. Verse, pre-chorus, a soaring chorus, then an extended instrumental break and a breakdown where the lead chants a short command ('don't stop', 'move it to the light'). Short rhythmic euphoric lines in the second person, to a lover or the whole room, with nightlife detail (the coat check, glitter on the cab seat, 4 a.m. on the avenue). Glamour and release over heartbreak; even the sad lyrics dance.",
    production: "Four-on-the-floor kick with open hi-hat on the off-beat, octave-jumping bassline, chicken-scratch rhythm guitar, string swells and horn stabs, big background vocal answers.",
    avoid: "trap hi-hats, distorted rock guitars, grunge, mumbled vocals, acoustic folk strumming, half-time drums, lo-fi",
  },
  "grunge": {
    delivery: "sung",
    lyrics: "Grunge: quiet-loud-quiet form, a murmured verse of 4 short lines, a chorus that is one ugly hook phrase screamed three times, a bridge that drops to a single guitar before the last chorus crashes in. Write in first person from inside a small, damp, unglamorous life (a rented room, a dead-end job, a friend who stopped calling), with sarcasm and self-disgust rather than self-pity. Slant rhymes and off-kilter images beat neat couplets; one strange concrete detail per verse (the mould on the ceiling, a borrowed coat that still smells of someone) keeps it from being generic angst.",
    production: "Thick detuned guitars through cranked fuzz, loud live drums with room mics, bass up front, vocals dry and slightly buried in the verse then raw and doubled in the chorus.",
    avoid: "polished pop vocals, autotune, synthesizers, bright clean production, happy major-key choruses, shredding guitar solos, EDM drops",
  },
  "pop-punk": {
    delivery: "sung",
    lyrics: "Pop punk: verse, pre-chorus, big chorus, verse, chorus, half-time breakdown with a gang-shout, double chorus out. Lines are short and conversational with exact rhymes, addressed to a specific 'you' (an ex, a hometown, a best friend who moved away), stuffed with suburban specifics: a gas station at 2am, a borrowed car, a curfew, a yearbook signature. Self-deprecating jokes sit right next to real heartbreak; the chorus must be singable by a crowd on first listen and the last chorus should land a small twist on its first line.",
    production: "Tight palm-muted power-chord guitars, fast punchy snare, bright compressed mix, stacked harmony vocals on the chorus and shouted backing vocals on the breakdown.",
    avoid: "screamed metal vocals, growls, slow ballad tempos throughout, autotune, synth leads, trap hi-hats, jazz chords",
  },
  "lo-fi": {
    delivery: "instrumental",
    lyrics: "Lo-fi beats, no words: each track is a 2-3 minute loop-based piece built on one warm chord progression, with the beat entering after a short intro, a small variation or filter sweep halfway, and a fade or tape-stop ending. Development comes from texture, not drama: a new countermelody, a drum drop-out, a vinyl crackle swell. Titles are small, specific, slightly wistful scenes, e.g. 'Laundromat at 11pm', 'Window Seat, Bus 14', 'Steam Off the Ramen', never 'Chill Vibes' or 'Study Beats'.",
    production: "Dusty sampled-sounding keys, lazy swung drums with gentle sidechain, tape saturation, wow and flutter, vinyl crackle, rolled-off highs and a soft low end.",
    avoid: "vocals, singing, rapping, spoken word, vocal chops with words, loud EDM drops, distorted guitars, crisp modern trap mixing",
  },
  "ambient": {
    delivery: "instrumental",
    lyrics: "Ambient, no words: each track is one slowly evolving piece of 4-8 minutes with no beat, built from a single tonal centre that blooms, thickens and thins again, with one or two events (a melody fragment, a field recording surfacing, a chord change) placed far apart. It should feel like a place or a weather rather than a song. Titles name a precise place, time or physical process, e.g. 'Tidewater at the Third Groyne', 'Frost Forming on Glass', 'Hour Before the Ferry', never 'Relaxing Ambience' or 'Deep Calm'.",
    production: "Long reverb tails, slow-attack pads, soft dynamics, wide stereo field, gentle tape hiss, field recordings mixed low.",
    avoid: "vocals, singing, spoken word, drums, beats, percussion loops, bass drops, pop song structure, sudden loud transitions",
  },
  "film-score": {
    delivery: "instrumental",
    lyrics: "Film score, no words: each track is a cue from an imaginary film, 2-4 minutes, with a clear dramatic shape (establishing, rising tension, a turn, a resolution or a cliffhanger) and a recurring main theme that returns across the album in different colours. Each style names the scene's action and emotion, the leading instruments and the tempo. Titles read like cue sheets for a film that does not exist, e.g. 'The Lighthouse Keeper's Letter', 'Crossing the Salt Flats', 'Reel 4: They Find the Map', never 'Epic Music' or 'Cinematic Theme'.",
    production: "Large scoring-stage sound, real orchestral sections with clear depth, deep low brass and percussion, modern hybrid sound design only where the artist calls for it.",
    avoid: "vocals, singing, lyrics, choir words, pop song structure, drum kit backbeats, rap, autotune",
  },
  "ska": {
    delivery: "sung",
    lyrics: "Ska: verse, chorus, verse, chorus, a horn-solo break, last chorus doubled, with short punchy lines that sit on the offbeat and a chorus built on one repeated phrase the crowd can shout back. Write in first person or as a street-corner narrator reporting on the neighbourhood: a dance hall, a bus depot, a shop steward, a rent man, a Saturday night that went sideways. Keep it danceable and wry even when the subject is unemployment or a fight; the joke and the grievance live in the same line, and call-and-response between lead and backing vocals is expected.",
    production: "Choppy offbeat guitar skank and organ bubble over a walking bass, crisp snare on the backbeat, a tight trumpet-trombone-sax horn section punching the hooks, live-room energy.",
    avoid: "rapping, autotune, trap hi-hats, EDM drops, synth pads, slow ballad tempos, metal growls, acoustic folk strumming",
  },
  "surf-rock": {
    delivery: "instrumental",
    lyrics: "Surf rock instrumentals, no words: each track is a 2-3 minute piece with a drum or bass pickup, a 12- or 16-bar lead melody played twice on reverb-drenched guitar, a contrasting middle section (a key change, a tremolo-picked run, or a drum break), then the theme again and a sharp ending or a fading glissando. The melody must be hummable and the energy should feel like motion: a wave, a car, a chase. Titles are terse and physical, naming a break, a stretch of coast, a board move, a car or a weather event, e.g. 'Riptide at Pier Nine', 'Offshore Wind', 'Black Flag Morning', never 'Surf Vibes' or 'Summer Fun'.",
    production: "Single-coil electric guitar through a spring reverb tank with wet drip, heavy tremolo-arm bends, driving tom-heavy drums, round picked bass, occasional organ or baritone sax, recorded live and a little hot.",
    avoid: "vocals, singing, humming, spoken word, rapping, synths, distorted metal guitars, trap drums, EDM drops, acoustic ballads",
  },
  "rockabilly": {
    delivery: "sung",
    lyrics: "Rockabilly: 12-bar or 16-bar verse-chorus songs about 2-3 minutes long, verse, chorus, verse, guitar break, chorus, with short rhyming couplets and a title phrase that repeats at the end of every chorus. First person, cocky or lovesick, full of concrete late-1950s small-town detail: a two-tone Ford, a jukebox nickel, a county fair, a sheriff, a factory shift, a girl or boy across the tracks. Use hiccups, stutters and yelps as rhythm, keep the slang playful, and land a punchline or a sly double meaning in each verse.",
    production: "Slapback echo on the vocal, slapped upright bass clicking on every beat, twangy hollow-body electric guitar with fast hybrid-picked licks, brushed or snare-heavy minimal drums, recorded mono-ish and live.",
    avoid: "synths, autotune, rapping, modern pop drums, heavy distortion, orchestral strings, ballad tempos throughout, EDM drops",
  },
  "swing": {
    delivery: "sung",
    lyrics: "Swing: classic 32-bar AABA songs, a band intro, the vocal chorus, an instrumental chorus with horn solos and a shout chorus, then the vocal back for the last eight bars and a big ending. Lines are conversational and witty with neat internal rhymes, written to a specific 'you' or about a night on the town: a ballroom, a streetcar, a borrowed tuxedo, a payday, a last dance, a phone that will not ring. Charm over confession; clever wordplay, a small twist in the bridge, and a tag line the band can punch.",
    production: "Full big band with saxophone, trumpet and trombone sections trading riffs, walking upright bass, four-to-the-bar rhythm guitar, swinging ride cymbal and hi-hat, warm room reverb, the singer up front.",
    avoid: "rapping, autotune, rock guitar distortion, synths, drum machines, EDM drops, trap hi-hats, screamed vocals, modern pop production",
  },
  "bossa-nova": {
    delivery: "sung",
    lyrics: "Bossa nova sung in English: through-composed or AABA songs, unhurried, with short lines that leave space between phrases and soft internal rhymes rather than hard end-rhymes. First person, intimate and understated, as if confiding: a balcony at dusk, an afternoon rain, a tram ride, a lover who left by the morning ferry, the smell of coffee, the colour of a dress. Saudade without melodrama; one precise image per line, a gentle wordless 'da-da-da' passage is fine, and the ending trails off rather than resolving.",
    production: "Nylon-string guitar with a syncopated bossa thumb-and-finger pattern, brushed snare and rim clicks, soft upright bass, light piano or flute, a close hushed vocal with little vibrato in a warm, dry room.",
    avoid: "belting, vocal runs, rapping, autotune, distorted guitars, loud drums, EDM drops, trap hi-hats, big pop choruses",
  },
  "salsa": {
    delivery: "sung",
    lyrics: "Salsa: sung mostly in English with short Spanish phrases only where they snap (a coro tag, a pregón call-out, a pet name), never a whole translated verse. Form is a short horn intro, two verses of 4-6 lines (8-11 syllables, a story told in first person), a [Coro] of one repeatable line the band answers, then a [Montuno] where the lead improvises short pregones between repeats of the coro, a [Mambo] horn break and a final coro. Ground it in a real night (the bus to the club on Friday, the cousin's quinceañera, the landlord at the door, the partner who leads too hard) and let the coro carry the title; never stack fuego, corazón and bailar clichés.",
    production: "Live big-band salsa sound: clave-locked piano montuno, tumbao bass, congas, timbales with cáscara and bell, bongó bell on the montuno, a full horn section of trumpets and trombones punching mambo lines, coro vocals answering the lead.",
    avoid: "reggaeton dembow beat, trap hi-hats, EDM drops, rock drum kit, distorted guitars, autotune, rapping, mariachi violins, Spanish-only lyrics, slow ballad tempo",
  },
  "dancehall": {
    delivery: "sung",
    lyrics: "Dancehall: a deejay toasting over the riddim in English with light patois flavour (yuh, mi, bredda, wah gwan) that never blocks understanding. Form is an [Intro] of shouted hype lines, a [Chorus] of 4 short chantable lines with the title, [Verse 1] of 8-12 rhythmic lines of 7-11 syllables riding the riddim with tight end and internal rhymes, chorus, [Verse 2], chorus, and an outro of call-outs to the crowd. Write first person, boastful, funny and physical (the sound system at the street dance, the fresh trim, the taxi fare, the rival selector, the mother calling at 4 a.m.) with wordplay and a punchline every 4 lines; no slurs, no gun glorification.",
    production: "Digital riddim with hard kick and rimshot snare, deep sub bass, sparse synth stabs, air-horn and rewind sound-system effects, the deejay vocal loud, dry and upfront with echo throws on line ends.",
    avoid: "roots reggae one-drop ballad feel, rock guitars, four-on-the-floor house kick, orchestral strings, operatic vocals, country twang, slow acoustic arrangement, unintelligible patois",
  },
  "trap": {
    delivery: "rapped",
    lyrics: "Trap: [Intro] of producer tag and ad-libs, a [Hook] of 4-8 lines up front (melodic autotuned hooks welcome, repetition is the point), [Verse 1] of 16 bars, hook, [Verse 2] of 12-16 bars, hook. Verses switch between triplet flows and half-time pockets, every line a full bar of 8-14 syllables with multisyllabic and internal rhymes chained across bars, ad-libs at line ends. First person, present tense, specific and visual (the count machine, the plug's area code, a jeweller's backroom, the rental with paper tags, the group chat at 3 a.m.): flex earned by detail, paranoia under the shine, dark humour; mild profanity fine, no slurs, no real names.",
    production: "Booming tuned 808 bass with slides, rapid hi-hat rolls in triplets and 32nds, hard snares and claps on the 3, a dark minimal loop of bells, plucks or choir pad, the vocal dry and loud with stacked ad-libs.",
    avoid: "boom-bap swing drums, live band, acoustic guitar, four-on-the-floor kick, EDM drops, uplifting choirs, cheerful major-key pop, sung verses",
  },
  "phonk": {
    delivery: "rapped",
    lyrics: "Phonk: Memphis-style chopped, chanted vocals: short punchy lines of 4-8 syllables repeated two or four times like a chant, triplet flow, call-and-response between the lead and a pitched-down echo. Form is a hook chant of 2-4 lines that opens the track, short verses of 8 bars, the hook again, then a long cowbell section where only one phrase repeats. Dark, nocturnal and concrete (the parking lot at 2 a.m., the handbrake turn, tail lights in the fog, tinted windows, a rival on the overpass): menace through mood rather than gore, no slurs, and fewer words is better so the cowbell melody can breathe.",
    production: "Distorted, clipped 808 bass, a melodic cowbell riff carrying the tune, lo-fi Memphis tape hiss and vinyl crackle on chopped and pitched-down vocal samples, hard trap hats, heavy saturation.",
    avoid: "clean pop vocals, singing, acoustic guitar, live drum kit, orchestral strings, uplifting choirs, reggaeton beat, bright major-key synths, long verses",
  },
  "hyperpop": {
    delivery: "sung",
    lyrics: "Hyperpop: verse-chorus pop form pushed to extremes: a 4-line verse, a pre-chorus that pitches up, a chorus of one hooky line repeated with variations, a bridge that collapses into a glitch breakdown, and a final chorus faster or an octave up. Lines are short (4-8 syllables), diary-blunt and internet-specific (a read receipt, a cracked phone screen, a bedroom ring light, a gas station slushie, a deleted account), sincere heartbreak hidden inside sugar-rush fun, cute and devastating in the same couplet. No generic 'feel alive tonight' lines.",
    production: "Maximal glossy chaos: pitched-up autotuned vocals, bitcrushed and distorted 808s, trance supersaw leads, glitchy stutter edits, sudden tempo or genre switches, pristine highs over a clipping low end.",
    avoid: "acoustic folk arrangement, live jazz band, country twang, slow blues, orchestral classical, gritty rock guitars as the main element, rapped verses, muddy lo-fi mixing",
  },
  "shoegaze": {
    delivery: "sung",
    lyrics: "Shoegaze: verse, chorus, verse, chorus, then a long instrumental wash where the vocal returns as one wordless line; keep each section to 4 short lines with lots of open vowels (oh, away, slow, light) that can melt into the guitars. Write half-remembered images rather than stories: a sunburnt car seat, a swimming pool after closing, hair drying on a radiator, the hum of a fridge at 4am. The chorus is a single phrase of 3-6 words repeated like a breath, and meaning should be felt, never explained.",
    production: "Walls of layered fuzz and reverse-reverb guitars with heavy tremolo-arm bends, a steady driving kit low in the mix, and soft breathy vocals buried inside the guitars rather than on top.",
    avoid: "crisp up-front vocals, autotune, rap verses, EDM drops, clean pop polish, shredding guitar solos, trap hi-hats, brass sections",
  },
  "trip-hop": {
    delivery: "sung",
    lyrics: "Trip-hop: slow verse-chorus songs with long gaps between lines so the beat breathes, verses of 4 lines spoken-sung low and close, a chorus that rises only slightly and repeats one bruised phrase. Write first person, night-time and interior: a hotel corridor carpet, the last train's empty carriage, rain on a taxi window, a phone that keeps lighting up face down. Seductive and guarded at once; leave something unsaid in every verse and end on an image, not a resolution.",
    production: "Slow dusty breakbeats at 70-95 BPM, deep dub bass, vinyl crackle, scratched string and horn samples, smoky Rhodes and a close, intimate vocal with tape delay throws.",
    avoid: "fast tempos, four-on-the-floor kicks, EDM drops, autotune, bright pop choruses, rock guitar solos, trap hi-hat rolls, rapping",
  },
  "celtic": {
    delivery: "sung",
    lyrics: "Celtic: ballads in plain ABAB quatrains with a refrain line that returns at the end of each verse, or rowdy reel songs where every verse ends in a shout-along chorus and the band takes a full instrumental tune between verses. Tell a story with names and places: a herring boat, a hiring fair, a priest's housekeeper, a lad gone to the Boston docks, a wake that turns into a dance. Use old-fashioned but clear English (bonny, aye, the morning dew) sparingly and never as a stage accent; the last verse should turn the story with one hard fact.",
    production: "Acoustic and live in a wooden room: fiddle, uilleann pipes, tin whistle, bodhrán, bouzouki and guitar, the singer dry and natural, tunes switching from jig to reel with a lift in tempo.",
    avoid: "synthesizers, EDM drops, trap beats, autotune, electric guitar distortion, drum machines, pop production gloss, fake stage-Irish accent",
  },
  "techno": {
    delivery: "instrumental",
    lyrics: "Techno, no words: each track is a 6-9 minute DJ-ready piece built on one kick pattern and one core motif, with a 32-bar beat-only intro, elements added every 16 or 32 bars, a breakdown where the kick drops and a filtered pad or acid line rises, then a long peak section and a 32-bar mix-out. Tension comes from filter movement, hi-hat density and small motif mutations, not new chords. Titles are terse and physical, like a machine part, a shift or a location, e.g. 'Compressor Hall B', 'Night Shift Torque', 'Platform 0 Sodium', never 'Techno Banger' or 'Rave Anthem'.",
    production: "Heavy punchy kick with rumbling sub, crisp 909-style hats and claps, hypnotic analog synth loops, dub chord stabs drenched in delay, mono low end and a club-loud master.",
    avoid: "vocals, singing, rapping, spoken word, vocal chops with words, pop chord progressions, guitars, acoustic instruments, trap beats, big EDM festival drops",
  },
  "post-rock": {
    delivery: "instrumental",
    lyrics: "Post-rock, no words: each track is a 6-12 minute crescendo piece that opens with a single clean guitar or piano figure, adds bass and brushed drums, layers tremolo-picked guitars and strings, then breaks into a huge distorted climax before collapsing into a quiet coda of the opening figure. Movement comes from dynamics and repetition, not verse and chorus. Titles are long, specific and a little uncanny, e.g. 'The Ferry Ran One Last Time With No One On It', 'Snow Falling on the Radar Station', never 'Epic Journey' or 'Crescendo'.",
    production: "Wide live-room band recording with chiming reverb-soaked guitars, glockenspiel and strings, drums that start soft and end thunderous, and a dynamic range from near silence to a wall of sound.",
    avoid: "vocals, singing, spoken word, choir words, pop song structure, EDM drops, trap beats, autotune, short radio-length edits",
  },
  "emo": {
    delivery: "sung",
    lyrics: "Emo: confessional first person addressed to one specific 'you', with verses of 4-6 uneven lines that read like a diary entry or an unsent text, a chorus that breaks open into a shouted or strained hook, and a bridge that repeats one raw line over and over until it cracks. Song titles are long and sentence-like or a wry joke. Make it hurt through detail (the porch light in a friend's parents' house, a borrowed hoodie, a cassette left in a car you sold, the exact exit number) rather than words like pain, broken or darkness; self-aware humour and slant rhymes beat neat couplets.",
    production: "Live-room band with bright clean twinkly guitars that erupt into overdriven chords on the chorus, busy melodic bass, dynamic drums, and a vocal that is close, unpolished and allowed to strain.",
    avoid: "autotune, trap hi-hats, EDM drops, polished pop gloss, synth pads, rapping, country twang, gothic organ, operatic vocals",
  },
  "indie-pop": {
    delivery: "sung",
    lyrics: "Indie Pop: a small, specific scene turned into a bright hook: verse, chorus, verse, chorus, a short bridge with a key detail that reframes the song, and a last chorus with a changed line. Lines are conversational, 6-10 syllables, with clever internal rhymes and one oddball image per verse (a library fine, a seaside town in February, a borrowed bike with a bent basket). Wry and tender at once; the title phrase should be a little strange and very singable, never a stock pop sentiment.",
    production: "Jangly clean electric guitars, melodic bass, crisp unfussy drums, glockenspiel or vintage keys, and a warm upfront vocal with light double-tracking.",
    avoid: "trap hi-hats, EDM drops, heavy distortion, autotune, rapping, stadium rock bombast, operatic vocals, maximal pop gloss",
  },
  "j-pop": {
    delivery: "sung",
    lyrics: "J-Pop: every word in English, with the bright Japanese pop shape carrying the flavour: intro hook, A-melody verse, B-melody pre-chorus that lifts, a big chorus, a second round, a quiet C-melody bridge, then a key change into the final chorus. Lines are short, rhythmic and packed with syllables on fast songs, with a 2-4 word English catchphrase hook that repeats and can be shouted at a live show. Paint everyday city and seasonal moments (the last train, a station platform at dusk, festival fireworks, cherry petals on a school bag, a convenience store at midnight) with earnest hope and sweet longing; no Japanese words, and never exoticise.",
    production: "Bright, dense and polished: driving drums, busy slap or picked bass, sparkling synths and piano, crunchy guitars on the chorus, stacked harmonies, and a crisp key change.",
    avoid: "Japanese-language lyrics, lo-fi tape hiss, trap 808s, mumbled vocals, rapping verses, country twang, slow blues tempo, muddy mix",
  },
  "bluegrass": {
    delivery: "sung",
    lyrics: "Bluegrass: strophic verses of 4 lines rhymed ABCB that tell a story in plain mountain speech (a flood, a mine whistle, a train out of the county, a sweetheart buried on the hill), a chorus sung in close three-part harmony that repeats the title line, and room after each chorus for instrumental breaks. Lines are 6-9 syllables and land squarely on the beat; one voice tells it, often an 'I' who lived it or a narrator who knew the family. Use real work, weather and place names, keep sentiment earned and spare, and let gospel or murder-ballad darkness sit next to fast joy.",
    production: "Acoustic string band around one microphone: banjo rolls, flatpicked guitar, mandolin chop on the backbeat, fiddle, upright bass, no drums, high lonesome harmonies.",
    avoid: "drums, drum kit, electric guitars, synthesizers, autotune, EDM, rapping, pop vocal runs, slick modern country production",
  },
  "smooth-jazz": {
    delivery: "instrumental",
    lyrics: "Smooth Jazz, no words: each track is a lead-instrument song form with a real melody: intro groove, head melody stated by the sax or guitar, a bridge, a short solo over the changes, then the head returning with a lift and a long fade or tag ending. Titles are evocative short phrases that suggest a time and a place, e.g. 'Seventh Floor Sunset', 'Late Checkout' or 'Rain on the Overpass'. An album is a mood sequence from afternoon drive to after-midnight ballads. Each style names the lead instrument, tempo, the groove (quiet storm, light funk, bossa) and where the melody peaks.",
    production: "Clean, polished studio sound: smooth Rhodes and piano, warm fretless or slap bass, tight soft drums, light pads, a lead instrument mixed upfront with plush reverb.",
    avoid: "vocals, singing, lyrics, rap, distorted guitars, heavy metal, aggressive drums, trap hi-hats, EDM drops, lo-fi hiss, free jazz chaos",
  },
  "dubstep": {
    delivery: "sung",
    lyrics: "Dubstep: a featured singer carries a short verse of 4 lines and a pre-drop hook of 4-7 words that hangs over a rising build, then the drop belongs to the bass with at most one chopped, pitched vocal fragment from the hook. Write in first or second person, present tense, about one charged moment (the fight in the car park, the last voicemail, the floor shaking under a tower block), with held vowels on the hook so it survives being stretched and stuttered. Two drops, a stripped second verse and a final hook repeat; never fill the drop with words.",
    production: "Half-time drums at 140-150 BPM with a huge snare on the three, sub bass and growling or wobbling mid bass on the drop, filtered risers and a silent beat before each drop, the singer drenched in reverb in the breakdown.",
    avoid: "four-on-the-floor house kick, rapped verses, country twang, acoustic folk arrangement, gospel choir, jazz swing, words over the drop, orchestral pomp",
  },
  "trance": {
    delivery: "sung",
    lyrics: "Trance: the vocal is a long-held, euphoric line over a 132-140 BPM pulse, so write few words with open vowels: a verse of 4 lines of 6-9 syllables, a hook of one sentence that becomes the anthem, and a breakdown where the hook is sung bare over pads before the build. Point of view is first person reaching for someone or something far away (a coastline at dawn, a voice on a bad line, the sky over the festival field), sincere and wide-eyed rather than ironic. Repeat the hook at least three times and let long instrumental passages carry the climax.",
    production: "Driving four-on-the-floor kick with rolling offbeat bass, supersaw lead and arpeggiated plucks, a long breakdown with lush pads and the bare vocal, a snare-roll build and a euphoric full-power return.",
    avoid: "rapped verses, half-time trap beats, dubstep wobble bass, distorted rock guitars, country twang, acoustic folk arrangement, short radio edit with no breakdown",
  },
  "industrial": {
    delivery: "sung",
    lyrics: "Industrial: lyrics are clipped, physical and confrontational: lines of 3-7 words, often commands or slogans, stacked in a verse of 4-8 lines and a chorus that is a single repeated phrase a crowd could shout. Write in first or second person about bodies, machines, work and control (the time clock, the conveyor, the surveillance camera, the overtime shift, the body as a tool), with blunt half-rhymes and repetition rather than ornate imagery. The vocal can be half-sung and distorted, but every chorus must be a clear hook, not just noise.",
    production: "Pounding mechanical drum machines and metallic sampled percussion at 110-135 BPM, distorted synth bass, abrasive guitars or noise layers, a distorted or bullhorn-filtered lead vocal and cold, cavernous reverb.",
    avoid: "acoustic guitars, country twang, gospel choir, jazz swing, smooth R&B vocals, tropical house, cheerful pop chords, trap 808 rolls",
  },
  "darkwave": {
    delivery: "sung",
    lyrics: "Darkwave: melancholy sung low and steady, verse-chorus with a bridge, lines of 6-9 syllables and simple full rhymes, the chorus a single mournful phrase repeated twice. First person, intimate, gothic but concrete (the wax on the windowsill, the dead phone in the coat pocket, the cemetery gate at closing time, the dance floor with only two people on it), longing and cold rather than theatrical horror. Let the synths and bass carry the hook and keep the words few and deliberate.",
    production: "Cold analog synths and a steady drum machine at 100-125 BPM, a prominent melodic bass line, chorus-drenched guitar or bell-like synth leads, deep baritone or ethereal vocals with long reverb.",
    avoid: "bright pop chords, rapped verses, country twang, acoustic folk arrangement, trap 808 rolls, EDM festival drops, gospel choir, heavy metal riffs",
  },
  "new-wave": {
    delivery: "sung",
    lyrics: "New Wave: smart, nervous, hook-first pop: verse, chorus, verse, chorus, a short odd bridge, chorus; lines of 5-9 syllables with crisp rhymes and one surprising word per chorus. Point of view is a wry first person observing modern life (the office party, the answering machine, the shopping mall escalator, the TV left on all night), funny and a little alienated rather than sentimental. Use short punchy phrases, a chorus that names the title, and room for a call-and-response or a spoken aside.",
    production: "Jerky upbeat drums at 120-150 BPM, choppy clean guitars, bright analog synth riffs, a busy melodic bass line and dry, upfront vocals with group backing shouts.",
    avoid: "trap beats, autotune, dubstep wobble bass, country twang, gospel choir, orchestral pomp, long guitar solos, heavy metal riffs",
  },
  "yacht-rock": {
    delivery: "sung",
    lyrics: "Yacht rock: smooth, wry adult romance, marinas and late lunches, sophisticated chords mean sophisticated words, a falsetto-ready chorus.",
    production: "Glossy late-1970s West Coast studio sound, Rhodes, clean guitar, tight session drums.",
    avoid: "distortion, rap, EDM, trap drums",
  },
};

/** The genre's craft notes, or none for a genre the label has no notes on. */
export function craftFor(genre: string): GenreCraft | undefined {
  return CRAFT[genreSlug(genre)];
}

/**
 * How the label's songwriter is asked: NIXAMP_LABEL_MODEL when set (a reasoning
 * model like gpt-oss-120b writes far better words than the quick default, but
 * thinks first, so it gets room and time).
 */
function writer(): { model?: string; maxTokens: number; timeoutMs: number } {
  const model = aiKey("NIXAMP_LABEL_MODEL");
  return { ...(model ? { model } : {}), maxTokens: 9000, timeoutMs: 240_000 };
}

/** What every lyric avoids: the stock lines models reach for first. */
const CLICHES = "neon, fire inside, rise above, shine so bright, heart of gold, chains, echoes, shadows, the night is young, we'll never back down, stand tall, break free, feel alive, against all odds, journey, destiny, soul on fire, light the way, never give up";

/**
 * The music model's brief for one song: the sound, the song's own style, the
 * voice, how it is delivered and what to leave out.
 */
export function composePrompt(artist: Pick<LabelArtist, "genre" | "sound" | "voice">, song: Pick<LabelSong, "style">): string {
  const craft = craftFor(artist.genre);
  const delivery = craft?.delivery === "rapped"
    ? "Lead vocal raps the verses in English: rhythmic, percussive flow locked to the beat, not sung; the hook is chanted or half-sung."
    : craft?.delivery === "instrumental" ? "Purely instrumental, no voice of any kind." : "Sung in English.";
  return [
    `${artist.sound}.`,
    `${song.style}.`,
    craft?.delivery === "instrumental" ? "" : `Lead vocal: ${artist.voice}.`,
    delivery,
    craft?.production ?? "",
    craft?.avoid ? `Avoid: ${craft.avoid}.` : "",
  ].filter(Boolean).join(" ").slice(0, 1500);
}

export const DEFAULTS: Omit<LabelSettings, "pausedReason"> = {
  holder: "Profullstack, Inc.",
  enabled: true,
  monthlySeconds: 3600,
  resetDay: 1,
  everyDays: 30,
  albumsPerDay: 1,
  newArtistChance: 0.25,
  seedAlbums: 1,
  songsPerAlbum: 8,
  songSeconds: 150,
  publish: true,
  videos: true,
  veo: false,
  veoShots: 2,
  storyShots: 4,
  lipsyncShots: 2,
  coverSong: true,
  videoUsd: 8, // VIDEO_USD
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
  "Titles are specific and surprising (an object, a place, a phrase someone says), never motivational slogans or abstract words like Rise, Empowered, Shine, Journey.",
  "Each song's style names its own story in a few words (who, where, what happens) so no two songs are about the same thing.",
].join(" ");

const LYRICS_SYSTEM = [
  "You are a professional songwriter writing original English lyrics for an AI performer. Never quote or imitate an existing song and never name a real artist.",
  "Write like a working pro, not a greeting card: concrete nouns, sensory detail, a point of view, a story that moves, lines a real artist would be proud of. Show, never tell how anyone feels.",
  `Never use these stock words or phrases: ${CLICHES}. No rhyming a word with itself, no filler like "oh yeah" to finish a line.`,
  "Put each section tag on its own line, e.g. [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Hook], [Verse 2], [Bridge], [Outro]. Never just one line under a section.",
  "Follow the genre's craft notes when given; without them: two verses of four to eight lines, a pre-chorus of two lines, a four-line chorus sung two or three times, a bridge of two to four lines.",
  "Only the words that are performed, no stage directions or notes. Answer as JSON: {\"lyrics\": \"the lyrics, lines separated by \\n\"}.",
].join(" ");

export async function planAlbum(
  artist: Pick<LabelArtist, "name" | "genre" | "sound" | "voice" | "bio" | "themes" | "albums"> & { cast?: string },
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
      artist.cast ? `The band, as they are (write for these people): ${artist.cast}` : "",
      craftFor(artist.genre) ? `Genre craft: ${craftFor(artist.genre)!.lyrics}` : "",
      before.length ? `Albums already out (do not reuse their titles or song titles; take the story somewhere new): ${before.join(" | ")}` : "This is the artist's debut album.",
      `The album has exactly ${songs} songs.`,
    ].filter(Boolean).join("\n"),
    ...writer(),
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
    ...writer(),
  });
  const name = clean(answer.value["name"], 60).replace(/"/g, "");
  const sound = clean(answer.value["sound"], 400);
  if (!name || sound.length < 10) throw new Error("the model invented no artist");
  if (taken.some((one) => one.toLowerCase() === name.toLowerCase())) throw new Error(`the model reused the name ${name}`);
  return { name, genre, sound, voice: clean(answer.value["voice"], 200) || "expressive lead vocal", bio: clean(answer.value["bio"], 300), themes: clean(answer.value["themes"], 200) };
}

export async function writeLyrics(
  artist: Pick<LabelArtist, "name" | "genre" | "voice" | "themes"> & { cast?: string },
  album: Pick<LabelAlbum, "title" | "concept">,
  song: Pick<LabelSong, "title" | "style" | "seconds">,
  ask: typeof askJson = askJson,
): Promise<{ lyrics: string; model: string }> {
  const craft = craftFor(artist.genre);
  const answer = await ask({
    system: LYRICS_SYSTEM,
    prompt: [
      `Artist: ${artist.name} (${artist.genre}); voice: ${artist.voice}`,
      // Given as a word list, the themes came back as the song's words ("ledger", "crown" in every line).
      artist.themes ? `What they sing about, as background only (do not reuse these words; find this song's own images): ${artist.themes}` : "",
      artist.cast ? `Who sings and plays it (their voice and personality shape the words): ${artist.cast}` : "",
      `Album: "${album.title}"${album.concept ? `: ${album.concept}` : ""}`,
      `Song: "${song.title}": ${song.style}`,
      craft ? `Genre craft (follow it): ${craft.lyrics}` : "",
      `The song lasts about ${song.seconds} seconds: keep the words under ${Math.max(600, Math.round(song.seconds * (craft?.delivery === "rapped" ? 16 : 10)))} characters.`,
    ].filter(Boolean).join("\n"),
    ...writer(),
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

/** A timed word from an aligner: seconds from the start of the song. */
export interface TimedWord { text: string; start: number; end: number }

/** ElevenLabs forced alignment: the song and its words in, each word's time out. */
export function elevenLabsAligner(key: string, fetcher: typeof fetch = fetch): (audio: string, text: string) => Promise<TimedWord[]> {
  return async (audio, text) => {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(audio)], { type: "audio/mpeg" }), "song.mp3");
    form.append("text", text);
    const response = await fetcher("https://api.elevenlabs.io/v1/forced-alignment", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (response.status === 401 || response.status === 402) throw new OutOfCredit(`elevenlabs answered HTTP ${response.status} to the alignment`);
    if (!response.ok) throw new Error(`the alignment answered HTTP ${response.status}`);
    const body = await response.json() as { words?: Array<{ text?: unknown; start?: unknown; end?: unknown }> };
    return (body.words ?? [])
      .map((one) => ({ text: String(one.text ?? "").trim(), start: Number(one.start), end: Number(one.end) }))
      .filter((one) => one.text && Number.isFinite(one.start) && Number.isFinite(one.end));
  };
}

/** ElevenLabs voice isolation: a few seconds of the song in, the voice alone out (what a lip sync follows best). */
export function elevenLabsIsolator(key: string, fetcher: typeof fetch = fetch): (audio: Buffer) => Promise<Buffer> {
  return async (audio) => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), "lines.mp3");
    const response = await fetcher("https://api.elevenlabs.io/v1/audio-isolation", { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(2 * 60_000) });
    if (!response.ok) throw new Error(`the voice isolation answered HTTP ${response.status}`);
    const voice = Buffer.from(await response.arrayBuffer());
    if (voice.length < 1000) throw new Error("the voice isolation answered with no audio");
    return voice;
  };
}

/** The sung lines of a song's words: section tags ([Chorus]) and blank lines are not sung. */
export function sungLines(lyrics: string): string[] {
  return lyrics.split("\n").map((line) => line.trim()).filter((line) => line && !/^\[[^\]]*\]$/.test(line));
}

/**
 * Timed words laid back onto the lines they were written in, in order, so
 * each line and each word knows when it is sung.
 */
export function syncLines(lyrics: string, timed: TimedWord[]): SyncedLine[] {
  const out: SyncedLine[] = [];
  let at = 0;
  for (const line of sungLines(lyrics)) {
    const words = line.split(/\s+/).filter(Boolean);
    const placed = words.map((word) => {
      const hit = timed[at];
      if (hit) at += 1;
      return hit ? { text: word, start: hit.start, end: hit.end } : null;
    }).filter((one): one is { text: string; start: number; end: number } => one !== null);
    if (placed.length === 0) break;
    out.push({ start: placed[0]!.start, end: placed[placed.length - 1]!.end, text: line, words: placed });
  }
  return out;
}

const STORYBOARD_SYSTEM = [
  "You storyboard music videos for original songs. Write one image prompt per scene, in order, following the song's story and mood.",
  "Keep the same main character(s), setting and color palette across scenes so it reads as one video; vary the shots (wide, close-up, action, detail).",
  "Each prompt: cinematic, photorealistic or stylized to suit the genre, at most 300 characters. No text, letters, logos, real people or real brands.",
  "Answer as JSON: {\"scenes\": [\"prompt\", ...]}.",
].join(" ");

/** Image prompts for a song's video, one a scene, from its words and mood. */
export async function writeStoryboard(
  artist: Pick<LabelArtist, "name" | "genre" | "sound"> & { cast?: string },
  album: Pick<LabelAlbum, "title" | "concept">,
  song: Pick<LabelSong, "title" | "style" | "lyrics">,
  scenes: number,
  ask: typeof askJson = askJson,
): Promise<string[]> {
  const answer = await ask({
    system: STORYBOARD_SYSTEM,
    prompt: [
      `Song: "${song.title}" by ${artist.name} (${artist.genre}; ${artist.sound}), from "${album.title}"${album.concept ? `: ${album.concept}` : ""}`,
      artist.cast ? `The band (these are the only performers; whenever one appears, name them and repeat their full look in that prompt, the image model remembers nothing): ${artist.cast}` : "",
      `Mood and arrangement: ${song.style}`,
      song.lyrics ? `Lyrics:\n${song.lyrics.slice(0, 1800)}` : "",
      `Exactly ${scenes} scenes.`,
    ].filter(Boolean).join("\n"),
    maxTokens: 2500,
    timeoutMs: 90_000,
  });
  const list = Array.isArray(answer.value["scenes"]) ? answer.value["scenes"] : [];
  const prompts = list.map((one) => clean(one, 400)).filter((one) => one.length > 10).slice(0, scenes);
  if (prompts.length < 2) throw new Error("the model wrote no storyboard");
  return prompts;
}

const VEO_STORY_SYSTEM = [
  "You write the story scenes of a music video for an original song, as prompts for a video model that films short moving shots.",
  "Tell the song's story in cinematic scenes away from any stage. The main characters are ONLY the band members listed (by role); every scene with a person in it features one to three of them, and each one keeps exactly the look given. Other people may appear only in the background, faces unseen.",
  "Keep the same settings and color palette across scenes so it reads as one short film; vary the shots (wide, tracking, close detail, aerial) and say how the camera moves. Nobody sings, speaks or lip-syncs, and nobody holds a microphone.",
  "Describe people by role and look, never by name. Each prompt at most 350 characters. No text, letters, logos, real people or real brands.",
  "Answer as JSON: {\"scenes\": [{\"prompt\": \"...\", \"cast\": [\"lead vocals\", ...]}, ...]} where cast lists the roles (exactly as given) of the members in that scene, [] for none.",
].join(" ");

/** A story scene for Veo: the prompt and the roles of the band members in it (their portraits go with it). */
export interface StoryScene { prompt: string; cast: string[] }

/** A single's story scenes for Veo: a short film from its words starring the band as they look, nobody singing. */
export async function writeVeoStory(
  artist: Pick<LabelArtist, "genre" | "sound">,
  members: Array<Pick<Member, "role" | "look">>,
  album: Pick<LabelAlbum, "title" | "concept">,
  song: Pick<LabelSong, "title" | "style" | "lyrics">,
  scenes: number,
  ask: typeof askJson = askJson,
): Promise<StoryScene[]> {
  const cast = members.slice(0, 5).map((one) => `${one.role}: ${one.look.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "")}`).join("; ");
  const answer = await ask({
    system: VEO_STORY_SYSTEM,
    prompt: [
      `Song: "${song.title}" (${artist.genre}; ${artist.sound}), from "${album.title}"${album.concept ? `: ${album.concept}` : ""}`,
      cast ? `The band (the only main characters), by role and look: ${cast}` : "",
      `Mood and arrangement: ${song.style}`,
      song.lyrics ? `Lyrics:\n${song.lyrics.slice(0, 1800)}` : "",
      `Exactly ${scenes} scenes.`,
    ].filter(Boolean).join("\n"),
    maxTokens: 4000,
    timeoutMs: 120_000,
  });
  const roles = new Set(members.map((one) => one.role.toLowerCase()));
  const list = Array.isArray(answer.value["scenes"]) ? answer.value["scenes"] : [];
  const out = list.map((one): StoryScene => {
    const item = (typeof one === "object" && one ? one : { prompt: one }) as { prompt?: unknown; cast?: unknown };
    const who = Array.isArray(item.cast) ? item.cast.map((role) => String(role).toLowerCase().trim()).filter((role) => roles.has(role)) : [];
    return { prompt: clean(item.prompt, 400), cast: [...new Set(who)].slice(0, 3) };
  }).filter((one) => one.prompt.length > 10).slice(0, scenes);
  if (out.length < 1) throw new Error("the model wrote no story");
  // A model asked for many scenes often writes fewer: the rest are its own scenes again, from other angles,
  // so every shot the plan paid for has something to film.
  const angles = ["a different angle and closer", "a wide establishing angle", "a slow tracking shot", "an overhead angle", "a low angle"];
  const written = out.length;
  for (let i = 0; out.length < scenes; i++) out.push({ ...out[i % written]!, prompt: `${out[i % written]!.prompt} Filmed as ${angles[i % angles.length]}.` });
  return out.map((scene) => ({
    cast: scene.cast,
    prompt: `Music video for a fictional ${artist.genre} song. ${scene.prompt} Mood: ${song.style}`.slice(0, 900)
      + " Nobody sings, speaks or lip-syncs on camera. Cinematic, 35mm film look, high detail. No text, no logos.",
  }));
}

/** Thrown by a Veo dependency when this month's budget is spent: no more shots until next month. */
export class VeoUnavailable extends Error {}

/** nixamp.com briefly away (a deploy: 502-504) or the network: worth asking again. */
const TRANSIENT = /\b50[234]\b|fetch failed|ECONN|timed? ?out/i;

// Nobody sings on camera: Veo's singers mouth a melody of their own, never the song's,
// so a mouth in shot is out of sync. The band plays; the vocalist is far off, from
// behind, in silhouette or between lines, never a close-up of singing.
const SHOTS = [
  "Close-up of the guitarist's hands on the fretboard and the strings, shallow focus, stage lights flaring",
  "Low-angle shot of the drummer hitting the cymbals at the song's climax, sticks blurred, sparks of light",
  "Close-up of the bass player's fingers and the amplifier, then a tilt up to the bassist in silhouette",
  "The guitarist and the bassist seen from behind, playing hard toward a huge crowd, backlit",
  "Slow push-in on the drummer in a quiet moment, moody light, sweat and smoke",
  "Slow aerial push over the crowd toward the stage, fans with hands up, the stage tiny in the distance",
];

// The singer's close-ups, which are lip-synced to the song afterwards (fal.ai). The mouth
// must be clear: whatever covers it is smeared into the face when the mouth is redrawn,
// and Veo puts a microphone in front of it whenever there is one in the scene, however
// the prompt asks for it held low. So there is none: the singer sings in the story's world.
const CLOSE_UPS = [
  "Close-up of the lead vocalist singing straight to camera at night in the rain on a neon-lit street, face and mouth fully lit, no microphone anywhere",
  "Medium close-up of the lead vocalist singing to camera from the driver's seat of a car at dusk, window down, wind in the hair, no microphone",
  "Close-up of the lead vocalist singing on an open road at golden hour, the camera slowly circling, face to camera, no microphone",
  "Close-up of the lead vocalist singing in a dark room lit by one warm lamp, head and shoulders, face to camera, no microphone",
  "Medium close-up of the lead vocalist singing on a rooftop at night, the city lights behind, face to camera, no microphone",
  "Close-up of the lead vocalist singing in the back of a moving train at dawn, soft window light on the face, no microphone",
];

/**
 * The prompts for a single's filmed shots. The people are the reference
 * images, described by role and look only: Veo refuses names with faces
 * ("we can't create videos with real people's names or likenesses").
 */
export function veoPrompts(artist: Pick<LabelArtist, "genre" | "sound">, song: Pick<LabelSong, "style">, members: Array<Pick<Member, "role" | "look">>, count: number, kind: "band" | "singer" = "band"): string[] {
  const cast = members.slice(0, 3).map((one, i) => `the ${one.role} from reference image ${i + 1} (${one.look.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "")})`).join("; ");
  const rule = kind === "singer"
    ? "The vocalist sings clearly to camera, the whole mouth always visible. There is no microphone, mic stand or instrument anywhere in the shot, and nothing in front of the face. Cinematic, 35mm film look. No text, no logos."
    : "The lead vocalist is not in this shot, and nobody sings, speaks or lip-syncs on camera. Cinematic, 35mm film look, dynamic camera. No text, no logos.";
  const list = kind === "singer" ? CLOSE_UPS : SHOTS;
  return Array.from({ length: Math.max(0, count) }, (_, i) => list[i % list.length]! + (i >= list.length ? ", from another angle" : "")).map((shot) => [
    `Music video for a fictional ${artist.genre} band. ${shot}.`,
    cast ? `The performers are exactly the people in the reference images: ${cast}.` : "",
    `Mood and sound: ${song.style} ${artist.sound}.`.slice(0, 400),
    rule,
  ].filter(Boolean).join(" "));
}

/** The DejaVu bold face most Linux boxes have, for the title card; "" when there is none. */
function titleFont(): string {
  for (const file of ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"]) {
    try { if (statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return "";
}

/** ffmpeg at the lowest priority, so the stations it shares the machine with come first. */
function runLow(ffmpeg: string[], args: string[], timeout: number, what: string): Promise<void> {
  const nice = process.platform === "linux" ? (() => { try { return statSync("/usr/bin/nice").isFile(); } catch { return false; } })() : false;
  const [bin, rest] = nice ? ["/usr/bin/nice", ["-n", "19", ffmpeg[0]!, ...args]] : [ffmpeg[0]!, args];
  return new Promise((done, fail) => {
    execFile(bin, rest, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error) => (error ? fail(new Error(`${what}: ${error.message}`)) : done()));
  });
}

/**
 * A song's music video from its storyboard: each scene's picture moves (a
 * slow zoom in, a pan, a zoom out, a pan back, in turn), scenes cross-fade,
 * the artist and title come up at the start, and the MP3's audio and tags
 * (title, artist, album, words) are copied in. 720p H.264.
 */
export function renderStoryVideo(ffmpeg: string[], input: { audio: string; images: string[]; seconds: number; artist: string; title: string; out: string; clips?: Array<{ path: string; seconds: number }> }): Promise<void> {
  const fade = 1;
  const clips = input.clips ?? [];
  // Stills fill what the filmed shots do not; each gets at least 3 s, so on a short song some are left out.
  let images = [...input.images];
  const clipTime = clips.reduce((sum, one) => sum + one.seconds, 0);
  const stillFor = (count: number): number => (input.seconds + (count + clips.length - 1) * fade - clipTime) / Math.max(1, count);
  while (images.length > 0 && stillFor(images.length) < 3) images = images.slice(0, -1);
  const each = images.length ? stillFor(images.length) : 0;
  // A still, then a filmed shot, in turn; whatever is left of either at the end.
  const order: Array<{ kind: "image"; path: string } | { kind: "clip"; path: string; seconds: number }> = [];
  for (let i = 0; i < Math.max(images.length, clips.length); i++) {
    if (images[i]) order.push({ kind: "image", path: images[i]! });
    if (clips[i]) order.push({ kind: "clip", ...clips[i]! });
  }
  const frames = Math.max(25, Math.round(each * 25));
  const moves = [
    `z='1+0.15*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.15':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
    `z='1.15-0.15*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
    `z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='(ih-ih/zoom)*on/${frames}'`,
  ];
  const parts: string[] = [];
  const lengths: number[] = [];
  let still = 0;
  order.forEach((item, i) => {
    if (item.kind === "image") {
      parts.push(`[${i}:v]scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900,zoompan=${moves[still++ % moves.length]}:d=1:s=1280x720:fps=25,setsar=1[v${i}]`);
      lengths.push(each);
    } else {
      // A filmed shot plays as it was filmed; the last one holds its final frame if the song runs on.
      const hold = i === order.length - 1 ? `,tpad=stop_mode=clone:stop_duration=${Math.max(0, input.seconds).toFixed(2)}` : "";
      parts.push(`[${i}:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=25,setsar=1,trim=duration=${item.seconds},setpts=PTS-STARTPTS${hold}[v${i}]`);
      lengths.push(item.seconds);
    }
  });
  const count = order.length;
  let last = "v0";
  let at = 0;
  for (let i = 1; i < count; i++) {
    at += lengths[i - 1]! - fade;
    parts.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade}:offset=${at.toFixed(2)}[x${i}]`);
    last = `x${i}`;
  }
  const font = titleFont();
  const card = `${input.artist} — ${input.title}`.replace(/[\\':%]/g, " ").slice(0, 80);
  parts.push(font
    ? `[${last}]drawtext=fontfile=${font}:text='${card}':fontcolor=white:fontsize=44:x=60:y=h-110:enable='between(t,0.5,6)':alpha='if(lt(t,1.5),t-0.5,if(gt(t,5),6-t,1))':shadowcolor=black@0.7:shadowx=2:shadowy=2,format=yuv420p[v]`
    : `[${last}]format=yuv420p[v]`);
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
    ...order.flatMap((item) => (item.kind === "image" ? ["-loop", "1", "-t", each.toFixed(2), "-i", item.path] : ["-i", item.path])),
    "-i", input.audio, "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", `${count}:a`, "-map_metadata", String(count), "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-r", "25", "-c:a", "copy", "-shortest",
    "-movflags", "+faststart+use_metadata_tags", input.out];
  return runLow(ffmpeg, [...ffmpeg.slice(1), ...args], 60 * 60_000, "the video failed");
}

/** What a second of Veo and of lip sync is counted at on nixamp.com (veo-studio.ts), and the shots' lengths. */
export const VEO_USD_PER_SECOND = 0.15;
export const LIPSYNC_USD_PER_SECOND = 0.1;
/** Story and band shots: the cut takes 4 s at a time, so a 4 s shot is used whole at half an 8 s one's price. */
export const SHOT_SECONDS = 4;
/** The singer's close-ups stay 8 s: each is lip-synced to 8 s of the song. */
export const SINGER_SECONDS = 8;
/** What one music video may cost (Anthony, 2026-10-21: "$5-10"); videoUsd in the settings. */
export const VIDEO_USD = 8;

/**
 * The shots a single gets for its budget: two lip-synced close-ups of the singer,
 * then as many 4 s shots as the rest buys, a third the band and the rest the
 * story. Footage shorter than the song is cut in turn and shown again.
 * $8 with a singer: 2 close-ups ($4.00 with their sync) and 6 shots ($3.60).
 */
export function shotPlan(seconds: number, singing: boolean, usd = VIDEO_USD): { story: number; band: number; singer: number } {
  const closeUp = SINGER_SECONDS * (VEO_USD_PER_SECOND + LIPSYNC_USD_PER_SECOND), shot = SHOT_SECONDS * VEO_USD_PER_SECOND;
  const length = Math.max(30, seconds);
  // About one lip-synced close-up every 30 s of song, as many as leave room for at least two shots.
  let singer = singing ? Math.max(1, Math.min(6, Math.round(length / 30))) : 0;
  while (singer > 1 && usd < singer * closeUp + 2 * shot) singer -= 1;
  // Then shots enough to cover the rest of the song once (nothing shown twice), as far as the money goes.
  const cover = Math.ceil(Math.max(0, length - singer * SINGER_SECONDS) / SHOT_SECONDS);
  const shots = Math.max(2, Math.min(cover, Math.floor((usd - singer * closeUp) / shot + 1e-9)));
  const band = Math.max(1, Math.round(shots / 4));
  return { story: Math.max(1, shots - band), band, singer };
}

/** What a plan costs on nixamp.com, in dollars. */
export function planUsd(plan: { story: number; band: number; singer: number }): number {
  return (plan.story + plan.band) * SHOT_SECONDS * VEO_USD_PER_SECOND + plan.singer * SINGER_SECONDS * (VEO_USD_PER_SECOND + LIPSYNC_USD_PER_SECOND);
}

/**
 * Where a single's lip-synced close-ups go: the start of a sung line (its .lrc)
 * nearest a quarter and three quarters in (one: a third in), each `length`
 * seconds, after the title card, never overlapping. Without timed words, those
 * points themselves.
 */
export function closeUpTimes(seconds: number, lines: Array<{ start: number }>, count: number, length = 8): number[] {
  if (count < 1) return [];
  // Two: a quarter and three quarters in; more: spread through the song.
  const edge = count <= 2 ? 0.25 : 0.12;
  const targets = count === 1 ? [1 / 3] : Array.from({ length: count }, (_, i) => edge + ((1 - 2 * edge) * i) / (count - 1));
  const fits = (t: number): boolean => t >= 6 && t + length <= seconds - 1;
  const starts = lines.map((line) => Math.round(line.start * 100) / 100).filter(fits);
  const chosen: number[] = [];
  for (const share of targets) {
    const want = share * seconds;
    const free = (t: number): boolean => fits(t) && chosen.every((one) => Math.abs(one - t) >= length);
    // A sung line near the point if one is free, else the point itself.
    const near = starts.filter(free).filter((t) => Math.abs(t - want) <= seconds / (2 * count));
    const pool = near.length ? near : [Math.round(want)].filter(free);
    if (pool.length) chosen.push(pool.reduce((best, t) => (Math.abs(t - want) < Math.abs(best - want) ? t : best)));
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * The version of a video cut from Veo footage: story scenes and the band playing with
 * nobody singing, the singer only in close-ups lip-synced to the song. Anything older
 * is not shown: a slideshow, 4 (singers out of sync) or 5 (all stage, the singer at
 * the mic in the wide shots). 6 and 7 (strangers in the story scenes, footage looped)
 * stay up until filmed again.
 */
export const FILMED = 8;
/** The oldest version still shown while its single waits to be filmed again: 6, story and band with a close-up, but footage looped and little singing. */
export const SHOWN = 6;

/** Google's answer when the project's daily Veo requests are used up (HTTP 429). */
export const VEO_QUOTA = /exceeded your current quota|RESOURCE_EXHAUSTED/i;

/** The next midnight in California, when Google's daily quotas reset. */
export function nextPacificMidnight(now: number): number {
  const hour = (at: number): number => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date(at)));
  let at = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  for (let i = 0; i < 26 && hour(at) !== 0; i++) at += 3_600_000;
  return at;
}

/**
 * A single's music video, cut from its filmed shots alone: 4 s cuts, each
 * shot's first half then its second, round and round the shots until the song
 * ends, so no picture holds still. The artist and title come up at the start;
 * the MP3's audio and tags are copied in. 1080p H.264.
 */
export function renderFilmedVideo(ffmpeg: string[], input: { audio: string; clips: Array<{ path: string; seconds: number }>; seconds: number; artist: string; title: string; out: string; pinned?: Array<{ path: string; at: number; seconds: number }> }): Promise<void> {
  if (input.clips.length === 0) return Promise.reject(new Error("no footage to cut"));
  const cut = 4;
  // Lip-synced close-ups play whole at the second of the song they were synced to; the band fills around them.
  const pinned = [...(input.pinned ?? [])].sort((a, b) => a.at - b.at);
  const cuts: Array<{ path: string; start: number; length: number }> = [];
  for (let at = 0, i = 0; at < input.seconds - 0.05;) {
    const pin = pinned.find((one) => Math.abs(one.at - at) < 0.05);
    if (pin) {
      const length = Math.min(pin.seconds, input.seconds - at + 0.5);
      cuts.push({ path: pin.path, start: 0, length });
      at += length;
      continue;
    }
    const next = pinned.find((one) => one.at > at + 0.05);
    const clip = input.clips[i % input.clips.length]!;
    const half = Math.floor(i / input.clips.length) % 2;
    let length = Math.min(cut, input.seconds - at + 0.5);
    // Up to a close-up: one cut to meet it exactly, never a sliver.
    if (next) length = next.at - at < cut * 1.5 ? next.at - at : Math.min(length, next.at - at);
    const start = length > cut ? 0 : Math.min(half * cut, Math.max(0, clip.seconds - cut));
    length = Math.min(length, clip.seconds - start);
    if (length < 0.04) break;
    cuts.push({ path: clip.path, start, length });
    at += length;
    i += 1;
  }
  const parts = cuts.map((_, i) => `[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=25,setsar=1,setpts=PTS-STARTPTS[c${i}]`);
  parts.push(`${cuts.map((_, i) => `[c${i}]`).join("")}concat=n=${cuts.length}:v=1:a=0[cut]`);
  const font = titleFont();
  const card = `${input.artist} — ${input.title}`.replace(/[\\':%]/g, " ").slice(0, 80);
  parts.push(font
    ? `[cut]drawtext=fontfile=${font}:text='${card}':fontcolor=white:fontsize=60:x=80:y=h-150:enable='between(t,0.5,6)':alpha='if(lt(t,1.5),t-0.5,if(gt(t,5),6-t,1))':shadowcolor=black@0.7:shadowx=3:shadowy=3,format=yuv420p[v]`
    : "[cut]format=yuv420p[v]");
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-threads", "2",
    ...cuts.flatMap((one) => ["-ss", one.start.toFixed(2), "-t", one.length.toFixed(2), "-i", one.path]),
    "-i", input.audio, "-filter_complex", parts.join(";"),
    "-map", "[v]", "-map", `${cuts.length}:a`, "-map_metadata", String(cuts.length), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "25", "-c:a", "copy", "-shortest",
    "-movflags", "+faststart+use_metadata_tags", input.out];
  return runLow(ffmpeg, [...ffmpeg.slice(1), ...args], 60 * 60_000, "the video failed");
}

/**
 * A song's music video without a storyboard: its album cover over a blurred
 * copy of itself, the song's waveform along the bottom, 720p H.264 with the
 * MP3's audio and tags copied in. Without a cover, a dark plate.
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
    "-map", "[v]", "-map", "1:a", "-map_metadata", "1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-r", "25", "-c:a", "copy", "-shortest",
    "-movflags", "+faststart+use_metadata_tags", out];
  return runLow(ffmpeg, args, 20 * 60_000, "the video failed");
}

/** A video made before videos carried tags, given its song's: streams copied, nothing re-encoded. */
export function retagVideo(ffmpeg: string[], video: string, audio: string, out: string): Promise<void> {
  const args = [...ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-y", "-i", video, "-i", audio,
    "-map", "0:v", "-map", "0:a", "-map_metadata", "1", "-c", "copy", "-movflags", "+faststart+use_metadata_tags", out];
  return new Promise((done, fail) => {
    execFile(ffmpeg[0]!, args, { timeout: 5 * 60_000 }, (error) => (error ? fail(new Error(`retagging the video failed: ${error.message}`)) : done()));
  });
}

/** Writes the tags (and the cover, as the attached picture) into a copy of the file. */
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

/**
 * The budget month `at` falls in, as "YYYY-MM" of the month it started in:
 * months run from `resetDay` (the provider's billing day, so the cap and the
 * credits renew together) to the same day of the next month.
 */
export function periodOf(at: number, resetDay = 1): string {
  const date = new Date(at);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth();
  if (date.getUTCDate() < resetDay) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** When the budget month after `at` begins. */
export function nextReset(at: number, resetDay = 1): number {
  const date = new Date(at);
  const thisMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), resetDay);
  return date.getUTCDate() < resetDay ? thisMonth : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, resetDay);
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
  /** Times each sung word in a recording; ElevenLabs forced alignment by default, null without a key. */
  align?: ((audio: string, text: string) => Promise<TimedWord[]>) | null;
  /** A filmed shot (Veo, through nixamp.com): the MP4, or a VeoUnavailable when the month's budget is spent. */
  veo?: ((input: { prompt: string; seconds: number; references: Buffer[] }) => Promise<Buffer>) | null;
  /** How long to wait before asking Veo again after nixamp.com or the network failed (60 s). */
  retryMs?: number;
  /** Cuts a single's filmed shots to its song; ffmpeg by default (renderFilmedVideo). */
  filmedVideo?: (input: { audio: string; clips: Array<{ path: string; seconds: number }>; seconds: number; artist: string; title: string; out: string; pinned?: Array<{ path: string; at: number; seconds: number }> }) => Promise<void>;
  /** The voice alone from a few seconds of a song (ElevenLabs by default when its key is set); null for none. */
  isolate?: ((audio: Buffer) => Promise<Buffer>) | null;
  /** A singer's close-up with the mouth redrawn to these seconds of the song (nixamp.com, fal.ai); VeoUnavailable when the month is spent. */
  lipsync?: ((input: { video: Buffer; audio: Buffer; seconds: number }) => Promise<Buffer>) | null;
  /** Renders a storyboard music video; ffmpeg by default (renderStoryVideo). */
  storyVideo?: (input: { audio: string; images: string[]; seconds: number; artist: string; title: string; out: string; clips?: Array<{ path: string; seconds: number }> }) => Promise<void>;
  /** A scene's picture for this prompt, or null when nothing can draw one; Workers AI by default. */
  image?: (prompt: string) => Promise<Buffer | null>;
  /** Tells the world an album landed (nixamp.com tells the artist's followers); never awaited. */
  announce?: (release: { artist: string; title: string; kind: "album" | "song" }) => void;
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
  private profiling = false;
  /** Songs being made now, by `<album>:<n>`. */
  private claims = new Map<string, { label: string; seconds: number }>();
  /** Artists whose next album is being planned now. */
  private planning = new Set<string>();
  private covering = new Map<string, Promise<void>>();
  private filming: Promise<number> | null = null;
  private timing: Promise<void> | null = null;
  /** Songs whose video failed since this server started. */
  private videoFailed = new Set<string>();
  /** Songs whose words were already sent to the aligner since this server started. */
  private alignTried = new Set<string>();
  /** The month ("YYYY-MM") Veo said its budget was spent; no more shots until the next. */
  private veoSpentIn = "";
  /** Until when Google's daily Veo quota is used up (its midnight, Pacific): nothing is asked before. */
  private veoQuotaUntil = 0;
  /** Old videos already tried as storyboards since this server started. */
  private upgradeTried = new Set<string>();
  /** When each single was last put in front of the camera: one that came up short is tried again an hour on. */
  private filmTriedAt = new Map<string, number>();
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

  /** The budget month now, renewing on resetDay. */
  private period(): string {
    return periodOf(this.now(), this.settings.resetDay ?? 1);
  }

  private budgetLeft(): number {
    if (this.settings.monthlySeconds === 0) return Number.POSITIVE_INFINITY;
    return this.settings.monthlySeconds - (this.usage[this.period()] ?? 0);
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
    const month = this.period();
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
      resetsAt: nextReset(this.now(), this.settings.resetDay ?? 1),
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
    if (input["veo"] !== undefined) this.settings.veo = input["veo"] === true;
    const shots = whole("veoShots", 0, 8);
    if (shots !== undefined) this.settings.veoShots = shots;
    const story = whole("storyShots", 0, 8);
    if (story !== undefined) this.settings.storyShots = story;
    const close = whole("lipsyncShots", 0, 4);
    if (close !== undefined) this.settings.lipsyncShots = close;
    // Counts given by hand mean those counts; coverSong says otherwise only when given too.
    if (shots !== undefined || story !== undefined || close !== undefined) this.settings.coverSong = false;
    if (input["coverSong"] !== undefined) this.settings.coverSong = input["coverSong"] === true;
    const usd = Number(input["videoUsd"]);
    if (input["videoUsd"] !== undefined && Number.isFinite(usd)) this.settings.videoUsd = Math.min(40, Math.max(2, usd));
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
    const resetDay = whole("resetDay", 1, 28);
    if (resetDay !== undefined) this.settings.resetDay = resetDay;
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
    await this.ensureProfile(artist).catch(() => undefined);
    const plan = await planAlbum({ ...artist, cast: this.castOf(artist) }, this.settings.songsPerAlbum, this.deps.ask ?? askJson);
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
    this.timer = setInterval(() => { void this.tick(); void this.videos(); void this.timeWords(); }, everyMs);
    this.timer.unref?.();
    void this.tick();
    // Side by side: a single about to be filmed makes its own artist's profile first (filmPass),
    // so a roster of new artists being profiled does not hold every video up.
    void this.profiles();
    void this.videos();
    void this.timeWords();
  }

  /** Every released song's words timed for the karaoke, one at a time, apart from filming. */
  timeWords(): Promise<void> {
    this.timing ??= (async () => {
      for (const artist of this.list()) {
        for (const album of artist.albums) {
          for (const song of album.songs) await this.sync(artist, album, song);
        }
      }
    })().finally(() => { this.timing = null; });
    return this.timing;
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
    // Also when nothing was made: the station keeps up with what may be shown.
    await this.placeVideos().catch(() => undefined);
    return total;
  }

  /**
   * One pass: songs without a video first, then old videos given their
   * song's tags (seconds each), then old cover-and-waveform videos made again
   * as storyboards.
   */
  /** The aligner this server can use: the dependency, else ElevenLabs with its key, else none. */
  private aligner(): ((audio: string, text: string) => Promise<TimedWord[]>) | null {
    if (this.deps.align !== undefined) return this.deps.align;
    const key = aiKey("ELEVENLABS_API_KEY");
    return key ? elevenLabsAligner(key) : null;
  }

  /** A song's words timed to its recording, written as 001. <title>.lrc beside it. Once per song (a failure is not retried this run). */
  private async sync(artist: LabelArtist, album: LabelAlbum, song: LabelSong): Promise<boolean> {
    const align = this.aligner();
    if (!align || !song.file || !song.lyrics || song.lrc || this.alignTried.has(song.file)) return false;
    this.alignTried.add(song.file);
    try {
      const timed = await align(song.file, sungLines(song.lyrics).join("\n"));
      const lines = syncLines(song.lyrics, timed);
      if (lines.length === 0) throw new Error("the aligner placed no words");
      const file = join(album.folder, `${songBase(song)}.lrc`);
      writeFileSync(file, formatLrc(lines, { title: song.title, artist: artist.name, album: album.title }));
      song.lrc = file;
      this.save();
      return true;
    } catch (error) {
      this.log(`could not time the words of "${song.title}": ${(error as Error).message}`);
      return false;
    }
  }

  private async filmPass(): Promise<number> {
    // The rest of the karaoke timing runs on its own (timeWords); a single's words are timed just before it is filmed.
    const songs = this.list().flatMap((artist) => artist.albums
      .filter((album) => album.cover || album.coverTried)
      .flatMap((album) => album.songs.filter((song) => song.file && !this.videoFailed.has(song.file)).map((song) => ({ artist, album, song }))));
    // Only a single is filmed, and only with Veo footage: a song with an older (slideshow) video is filmed when its turn comes.
    // A filmed video whose singer was never filmed (a quota or a refusal took the close-ups) is filmed again while it stays up.
    const singerless = (song: LabelSong): boolean => Boolean(this.deps.lipsync) && this.settings.lipsyncShots > 0 && (song.videoVersion ?? 1) >= FILMED && !song.singer;
    // Instrumentals have no singer and no band to cast the way Veo films them: no video.
    const missing = songs.filter(({ artist, song }) => craftFor(artist.genre)?.delivery !== "instrumental" && this.wantsVeo(song) && ((song.videoVersion ?? 1) < FILMED || singerless(song)) && this.now() - (this.filmTriedAt.get(song.file) ?? 0) > 60 * 60_000);
    // A single already on /music is filmed again before new ones: the month's budget finishes one video, not starts several.
    missing.sort((a, b) => Number((b.song.videoVersion ?? 1) >= SHOWN && Boolean(b.song.video)) - Number((a.song.videoVersion ?? 1) >= SHOWN && Boolean(a.song.video)));
    const untagged = songs.filter(({ song }) => song.video && !song.videoTagged && (song.videoVersion ?? 1) >= SHOWN);
    const old: typeof songs = [];
    let made = 0;
    for (const { album, song } of untagged) {
      if (!this.settings.videos) break;
      // Made before videos carried tags: give it its song's, in place.
      const partial = join(album.folder, `.${randomBytes(4).toString("hex")}.retag.mp4`);
      try {
        await retagVideo(this.deps.ffmpeg, song.video!, song.file, partial);
        renameSync(partial, song.video!);
        song.videoTagged = true;
        made += 1;
        this.save();
      } catch (error) {
        this.log(`could not tag the video of "${song.title}": ${(error as Error).message}`);
        song.videoTagged = true; // a storyboard remake brings the tags anyway
      } finally {
        rmSync(partial, { force: true });
      }
    }
    for (const { artist, album, song } of [...missing, ...old]) {
      if (!this.settings.videos) break;
      // Tried at most hourly: what was filmed is kept (filmShots), so a retry films only what is missing.
      const upgrade = Boolean(song.video);
      this.filmTriedAt.set(song.file, this.now());
      if (!this.wantsVeo(song)) break;
      const out = join(album.folder, `${songBase(song)}.mp4`);
      const partial = join(album.folder, `.${randomBytes(4).toString("hex")}.video.mp4`);
      const scenes = join(album.folder, `.scenes-${song.n}-${randomBytes(3).toString("hex")}`);
      try {
        // Its words timed (where the singer's close-ups go) and its people known (who is cast), now, not after everybody else's.
        await this.sync(artist, album, song);
        if (!(artist.members ?? []).length) await this.ensureProfile(artist).catch((error: unknown) => this.log(`no profile for ${artist.name}: ${(error as Error).message}`));
        const filmed = await this.filmSong(artist, album, song, scenes, partial, upgrade);
        song.videoVersion = filmed.version;
        if (filmed.singer) song.singer = filmed.singer;
        renameSync(partial, out);
        song.video = out;
        song.videoTagged = true;
        made += 1;
        this.save();
        // On the air as soon as it is made, not after the whole pass.
        await this.placeVideos().catch(() => undefined);
      } catch (error) {
        this.log(`no filmed video for "${song.title}" yet: ${(error as Error).message}`);
      } finally {
        rmSync(partial, { force: true });
        rmSync(scenes, { recursive: true, force: true });
      }
    }
    return made;
  }

  /**
   * A single's video: Veo shots of the band, cut to the whole song (FILMED).
   * Fewer than half the shots filmed (a refusal, the budget spent) makes no
   * video at all: footage stretched that thin would be a loop, not a video.
   */
  private async filmSong(artist: LabelArtist, _album: LabelAlbum, song: LabelSong, scenes: string, out: string, _upgrade = false): Promise<{ version: number; singer?: "synced" | "unsynced" }> {
    let seconds = song.seconds;
    try {
      const probed = await this.deps.probe(song.file);
      if (probed.duration > 5) seconds = probed.duration;
    } catch { /* the asked-for length */ }
    // Paid-for shots live beside the album until the video is cut, so nothing filmed is filmed twice.
    const shots = join(_album.folder, `.veo-${song.n}`);
    const plan = this.settings.coverSong
      ? shotPlan(seconds, Boolean(this.deps.lipsync), this.settings.videoUsd ?? VIDEO_USD)
      : { story: this.settings.storyShots, band: this.settings.veoShots, singer: this.settings.lipsyncShots };
    const { band: clips, singer } = await this.filmShots(artist, _album, song, shots, scenes, plan);
    const wanted = plan.band + plan.story;
    if (clips.length < Math.max(2, Math.ceil(wanted / 2))) throw new Error(`only ${clips.length} of ${wanted} shots filmed so far`);
    // The singer is the point of the video: with lip sync on, nothing is cut until a close-up is filmed.
    const singing = Boolean(this.deps.lipsync) && plan.singer > 0;
    if (singing && singer.length === 0) throw new Error("the singer's close-ups are not filmed yet");
    const pinned = await this.syncCloseUps(song, singer, seconds, shots);
    await (this.deps.filmedVideo ?? ((input) => renderFilmedVideo(this.deps.ffmpeg, input)))({ audio: song.file, clips, seconds, artist: artist.name, title: song.title, out, ...(pinned.length ? { pinned } : {}) });
    // Paid shots are kept until the video is whole (every close-up synced): a re-cut films only what is missing.
    if (!singing || pinned.length >= plan.singer) rmSync(shots, { recursive: true, force: true });
    return { version: FILMED, ...(singing ? { singer: pinned.length ? "synced" as const : "unsynced" as const } : {}) };
  }

  /**
   * The singer's close-ups, each placed on a sung line and its mouth redrawn
   * to those seconds of the song. A close-up that cannot be synced is left
   * out (the band fills its place): an unsynced singer is never shown.
   */
  private async syncCloseUps(song: LabelSong, singer: Array<{ path: string; seconds: number }>, seconds: number, keep: string): Promise<Array<{ path: string; at: number; seconds: number }>> {
    const lipsync = this.deps.lipsync;
    if (!lipsync || singer.length === 0) return [];
    let lines: Array<{ start: number }> = [];
    try { if (song.lrc) lines = parseLrc(readFileSync(song.lrc, "utf8")); } catch { /* the song's thirds instead */ }
    const times = closeUpTimes(seconds, lines, singer.length);
    const pinned: Array<{ path: string; at: number; seconds: number }> = [];
    for (const [i, at] of times.entries()) {
      const synced = join(keep, `synced-${i}-${Math.round(at * 100)}.mp4`);
      try {
        if (statSync(synced).size > 10_000) { pinned.push({ path: synced, at, seconds: 8 }); continue; }
      } catch { /* not synced yet */ }
      const shot = join(keep, `.send-${i}.mp4`);
      const audio = join(keep, `.send-${i}.mp3`);
      try {
        // The shot made small enough to send (1080p, no sound) and the song's same 8 seconds.
        await runLow(this.deps.ffmpeg, [...this.deps.ffmpeg.slice(1), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", singer[i]!.path, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-t", "8", shot], 5 * 60_000, "the close-up did not shrink");
        await runLow(this.deps.ffmpeg, [...this.deps.ffmpeg.slice(1), "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-t", "8", "-i", song.file, "-c:a", "libmp3lame", "-b:a", "192k", audio], 60_000, "the song's seconds did not cut");
        // The mouth follows the voice alone better than the whole mix; the video keeps the whole mix.
        let voice: Buffer = readFileSync(audio);
        const isolate = this.deps.isolate !== undefined ? this.deps.isolate : (aiKey("ELEVENLABS_API_KEY") ? elevenLabsIsolator(aiKey("ELEVENLABS_API_KEY")!) : null);
        if (isolate) voice = await isolate(voice).catch((error: unknown) => { this.log(`voice isolation for "${song.title}": ${(error as Error).message}; the whole mix instead`); return voice; });
        let bytes: Buffer | null = null;
        for (let attempt = 0; ; attempt++) {
          try { bytes = await lipsync({ video: readFileSync(shot), audio: voice, seconds: 8 }); break; } catch (error) {
            if (attempt >= 2 || !TRANSIENT.test((error as Error).message)) throw error;
            await new Promise((done) => setTimeout(done, this.deps.retryMs ?? 60_000));
          }
        }
        writeFileSync(`${synced}.part`, bytes!);
        renameSync(`${synced}.part`, synced);
        pinned.push({ path: synced, at, seconds: 8 });
      } catch (error) {
        // nixamp.com away (a deploy) or the month spent: nothing is cut yet; the shots wait for the next try.
        if (error instanceof VeoUnavailable || TRANSIENT.test((error as Error).message)) throw new Error(`lip sync ${i + 1} must wait: ${(error as Error).message}`);
        this.log(`lip sync ${i + 1} for "${song.title}": ${(error as Error).message}; the band plays there instead`);
      } finally {
        rmSync(shot, { force: true });
        rmSync(audio, { force: true });
      }
    }
    if (pinned.length) this.log(`lip-synced ${pinned.length} close-up(s) of "${song.title}"`);
    return pinned;
  }

  /** Whether this song gets filmed Veo shots: an album's single, Veo on, and the month's budget not spent. */
  private wantsVeo(song: Pick<LabelSong, "n">): boolean {
    return this.settings.veo && song.n === 1 && Boolean(this.deps.veo) && this.veoSpentIn !== new Date(this.now()).toISOString().slice(0, 7)
      && this.now() >= this.veoQuotaUntil;
  }

  /**
   * A single's filmed shots: the band, from their portraits (up to three as
   * Veo's reference images), on stage, in the song's mood. Stops for the
   * month when the budget is spent; a shot Veo will not make is skipped.
   */
  private async filmShots(artist: LabelArtist, album: LabelAlbum, song: LabelSong, keep: string, dir: string, counts: { story: number; band: number; singer: number }): Promise<{ band: Array<{ path: string; seconds: number }>; singer: Array<{ path: string; seconds: number }> }> {
    const veo = this.deps.veo;
    if (!veo) return { band: [], singer: [] };
    mkdirSync(dir, { recursive: true });
    mkdirSync(keep, { recursive: true });
    const members = this.cast(artist);
    // The players for the band shots, the voice for the close-ups: a singer's portrait in a band
    // shot puts the singer at a microphone, singing out of sync.
    const voice = (member: Member): boolean => /vocal|sing/i.test(member.role);
    const players = members.filter((member) => !voice(member));
    const singers = members.filter(voice).length ? members.filter(voice) : members.slice(0, 1);
    const shrunk = new Map<string, Buffer | null>();
    const portraits = async (list: Member[]): Promise<Buffer[]> => {
      const out: Buffer[] = [];
      for (const member of list.slice(0, 3)) {
        if (!shrunk.has(member.slug)) {
          const portrait = join(this.folderOf(artist), "members", `${member.slug}.jpg`);
          const small = join(dir, `ref-${member.slug}.jpg`);
          try {
            // 768 px keeps a face's detail and the request small.
            await runLow(this.deps.ffmpeg, [...this.deps.ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-y", "-i", portrait, "-vf", "scale=768:-2", "-q:v", "3", small], 60_000, "the portrait did not shrink");
            shrunk.set(member.slug, readFileSync(small));
          } catch {
            // A member without a portrait is described in words only.
            shrunk.set(member.slug, null);
          }
        }
        const bytes = shrunk.get(member.slug);
        if (bytes) out.push(bytes);
      }
      return out;
    };
    const [playerRefs, singerRefs] = [await portraits(players), await portraits(singers)];
    const band: Array<{ path: string; seconds: number }> = [];
    const story: Array<{ path: string; seconds: number }> = [];
    const singer: Array<{ path: string; seconds: number }> = [];
    // The story is written only while some of its scenes are still to film.
    const storyFiles = Array.from({ length: counts.story }, (_, i) => join(keep, `story-${i}.mp4`));
    let storyPrompts: StoryScene[] = [];
    if (storyFiles.some((file) => !existsSync(file)) && this.canAsk()) {
      try {
        storyPrompts = await writeVeoStory(artist, members, album, song, storyFiles.length, this.deps.ask ?? askJson);
      } catch (error) {
        this.log(`no story for "${song.title}" yet: ${(error as Error).message}`);
      }
    }
    // The singer's close-ups only where they can be lip-synced afterwards. Each story scene is filmed
    // with the portraits of the members in it, and their looks in words, so they are the same people
    // in every shot; a scene with nobody in it goes without.
    const byRole = new Map(members.map((member) => [member.role.toLowerCase(), member]));
    const storyCast = await Promise.all(storyPrompts.map(async (scene) => {
      const who = scene.cast.map((role) => byRole.get(role)).filter((member): member is Member => Boolean(member));
      const named = who.map((member, i) => `the ${member.role} from reference image ${i + 1} (${member.look.replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "")})`).join("; ");
      return {
        prompt: who.length ? `${scene.prompt} The people are exactly the ones in the reference images, same faces, hair and clothes: ${named}.` : scene.prompt,
        refs: await portraits(who),
      };
    }));
    // The singer first: a day's few Veo requests go to what the video is for, then the story and the band.
    const plan = [
      ...(this.deps.lipsync ? veoPrompts(artist, song, singers, counts.singer, "singer").map((prompt, i) => ({ prompt, file: join(keep, `singer-${i}.mp4`), into: singer, refs: singerRefs, seconds: SINGER_SECONDS })) : []),
      ...storyFiles.map((file, i) => ({ prompt: storyCast[i]?.prompt ?? "", file, into: story, refs: storyCast[i]?.refs ?? [], seconds: SHOT_SECONDS })),
      ...veoPrompts(artist, song, players, counts.band).map((prompt, i) => ({ prompt, file: join(keep, `shot-${i}.mp4`), into: band, refs: playerRefs, seconds: SHOT_SECONDS })),
    ];
    for (const [i, { prompt, file, into, refs, seconds }] of plan.entries()) {
      try {
        if (statSync(file).size > 10_000) { into.push({ path: file, seconds }); continue; }
      } catch { /* not filmed yet */ }
      if (!prompt) continue;
      try {
        // nixamp.com briefly away (a deploy: 502/503) or the network: twice more, a minute apart.
        let bytes: Buffer | null = null;
        for (let attempt = 0; ; attempt++) {
          try { bytes = await veo({ prompt, seconds, references: refs }); break; } catch (error) {
            if (attempt >= 2 || error instanceof VeoUnavailable || !TRANSIENT.test((error as Error).message)) throw error;
            await new Promise((done) => setTimeout(done, this.deps.retryMs ?? 60_000));
          }
        }
        const partial = `${file}.part`;
        writeFileSync(partial, bytes!);
        renameSync(partial, file);
        into.push({ path: file, seconds });
      } catch (error) {
        if (error instanceof VeoUnavailable) {
          this.veoSpentIn = new Date(this.now()).toISOString().slice(0, 7);
          this.log(`Veo: ${(error as Error).message}; no more videos until next month`);
          break;
        }
        if (VEO_QUOTA.test((error as Error).message)) {
          // Google's daily request quota: every further ask today is refused, so none is made.
          this.veoQuotaUntil = nextPacificMidnight(this.now());
          this.log(`Veo: Google's daily quota is used up; filming resumes after ${new Date(this.veoQuotaUntil).toISOString()}`);
          break;
        }
        this.log(`Veo shot ${i + 1} for "${song.title}": ${(error as Error).message}`);
      }
    }
    if (band.length || story.length || singer.length) this.log(`Veo: ${band.length + story.length + singer.length} filmed shots for "${song.title}" (${artist.name})`);
    // The cut takes them in turn: a story scene, then the band playing, and so on.
    const mixed: Array<{ path: string; seconds: number }> = [];
    for (let i = 0; i < Math.max(story.length, band.length); i++) {
      if (story[i]) mixed.push(story[i]!);
      if (band[i]) mixed.push(band[i]!);
    }
    return { band: mixed, singer };
  }

  /** The label's music videos as one TV station: free to watch, with its breaks. */
  private placeVideos(): Promise<void> {
    const next = this.placing.then(async () => {
      await this.deps.index.scan(this.source(), this.deps.probe).done;
      const files = this.list()
        .flatMap((artist) => artist.albums.flatMap((album) => album.songs.map((song) => ((song.videoVersion ?? 1) >= SHOWN ? song.video ?? "" : ""))))
        .filter((file) => file && this.deps.index.itemAt(file)?.state === "ready");
      const existing = this.deps.store.byAuto("ai:label:videos");
      if (files.length === 0) {
        // Nothing filmed yet (older slideshow videos are not shown): off the guide until there is.
        if (existing && existing.listed) this.deps.store.setAccess(existing.id, { visibility: "private", listed: false }, this.deps.owner || "ai-label");
        return;
      }
      const label = this.settings.holder.replace(/,?\s+(inc|llc|ltd|gmbh|co)\.?$/i, "");
      if (existing) {
        this.deps.store.update(existing.id, {}, files);
        if (!this.settings.publish || existing.listed) return;
      }
      const made = existing ?? this.deps.store.create({ name: `${label} AI · Music Videos`, description: `Music videos by ${label}'s AI artists, every genre.`, shuffle: true, repeat: true, video: true }, files, this.deps.owner);
      if (!existing) this.deps.store.markAuto(made.id, "ai:label:videos");
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
    // Out of credit last budget month: a new one has its credit again.
    if (this.settings.pausedReason && this.settings.pausedPeriod && this.settings.pausedPeriod !== this.period()) {
      this.log(`a new budget month (${this.period()}): composing again`);
      this.settings.pausedReason = "";
      delete this.settings.pausedPeriod;
      this.save();
    }
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
    // A paused artist's unfinished album waits without holding a slot.
    const inProgress = this.list().filter((one) => one.enabled && one.albums.some((album) => !album.doneAt)).length + this.planning.size;
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
    if (error instanceof OutOfCredit) {
      this.settings.pausedReason = `${artist.lastError}; resumes by itself when the budget month renews (day ${this.settings.resetDay}), or \`nixamp station label resume\``;
      this.settings.pausedPeriod = this.period();
    }
    this.save();
    this.log(`${artist.name}: ${artist.lastError}`);
  }

  private async compose(artist: LabelArtist, album: LabelAlbum, song: LabelSong, composer: Composer): Promise<void> {
    artist.lastAttemptAt = this.now();
    mkdirSync(album.folder, { recursive: true });
    const raw = join(album.folder, `.${randomBytes(4).toString("hex")}.raw.mp3`);
    try {
      let writer = song.made || album.writer;
      const instrumental = craftFor(artist.genre)?.delivery === "instrumental";
      if (!song.lyrics && !instrumental) {
        const written = await writeLyrics({ ...artist, cast: this.castOf(artist) }, album, song, this.deps.ask ?? askJson);
        song.lyrics = written.lyrics;
        writer = written.model;
        song.made = writer;
        this.save();
      }
      await this.ensureCover(artist, album);
      this.log(`composing "${song.title}" (${artist.name}, ${album.title}, ${song.seconds} s, ${composer.name})`);
      const prompt = composePrompt(artist, song);
      await composer.compose({ prompt, seconds: song.seconds, vocals: !instrumental, out: raw, ...(instrumental ? {} : { lyrics: song.lyrics }) });
      const month = this.period();
      this.usage[month] = (this.usage[month] ?? 0) + song.seconds;
      const base = songBase(song);
      const file = join(album.folder, `${base}.mp3`);
      // An instrumental has no words, so no words file.
      const lyricsFile = instrumental ? "" : join(album.folder, `${base}.lyrics.txt`);
      if (lyricsFile) writeFileSync(lyricsFile, `${song.lyrics}\n`);
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
        comment: instrumental ? `Made with AI for ${holder}: music by ${composer.name}, planned by ${writer}` : `Made with AI for ${holder}: music by ${composer.name}, words by ${writer}`,
        ...(instrumental ? {} : { "lyrics-eng": song.lyrics }),
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
        this.deps.announce?.({ artist: artist.key, title: album.title, kind: "album" });
        void this.ensureProfile(artist).catch(() => undefined);
      }
      this.save();
      this.writeAlbumJson(artist, album);
      await this.place(artist.genre);
      // Its words timed to the recording, then its video, without holding up the next song.
      await this.sync(artist, album, song).catch(() => undefined);
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
    const cast = this.castOf(artist);
    const prompt = `Album cover art for "${album.title}", a ${artist.genre} album by ${artist.name}. ${album.concept} Style: ${artist.sound}.${cast ? ` If the band appears, they look exactly like this: ${cast}.` : ""} Striking, original, square composition. No text, no letters, no logos, no watermark.`;
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
          members: this.cast(one).map((member) => ({ slug: member.slug, name: member.name, role: member.role, bio: member.bio })),
          albums: one.albums
            .filter((album) => album.songs.some((song) => song.file))
            .map((album) => ({
              key: album.key, title: album.title, year: album.year, concept: album.concept, cover: Boolean(album.cover), complete: album.doneAt > 0,
              songs: album.songs.filter((song) => song.file).map((song) => ({ n: song.n, title: song.title, seconds: song.seconds, lyrics: song.lyrics, ...(song.video && (song.videoVersion ?? 1) >= SHOWN ? { video: true } : {}) })),
            }))
            .reverse(),
        }))
        .filter((one) => one.albums.length > 0),
    })).filter((one) => one.artists.length > 0);
    return { holder: this.settings.holder, genres };
  }

  /** A released file anybody may fetch: its words, its music video, or its album's cover. */
  publicFile(artistKey: string, albumKey: string, what: string): { path: string; type: string } | null {
    const album = this.artists.get(artistKey)?.albums.find((one) => one.key === albumKey);
    if (!album) return null;
    if (what === "cover.jpg") return album.cover ? { path: album.cover, type: "image/jpeg" } : null;
    const match = /^(\d{1,3})\.(mp3|txt|mp4)$/.exec(what);
    const song = match ? album.songs.find((one) => one.n === Number(match[1]) && one.file) : undefined;
    if (!song) return null;
    if (match![2] === "mp4") return song.video && (song.videoVersion ?? 1) >= SHOWN ? { path: song.video, type: "video/mp4" } : null;
    if (match![2] === "mp3") return { path: song.file, type: "audio/mpeg" };
    return song.lyricsFile ? { path: song.lyricsFile, type: "text/plain; charset=utf-8" } : null;
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

  /** The artist's folder: <root>/<genre>/<artist>/, where its albums and profile pages live. */
  folderOf(artist: Pick<LabelArtist, "genre" | "name">): string {
    return join(this.root, genreSlug(artist.genre), fileName(artist.name));
  }

  /** The artist's people as their pages say now (hand edits win). */
  cast(artist: LabelArtist): Member[] {
    return readMembers(this.folderOf(artist), artist.members ?? []);
  }

  /** The people in one line, for a prompt; "" before they are cast. */
  castOf(artist: LabelArtist): string {
    return castLine(this.cast(artist));
  }

  /**
   * The artist's profile: its members invented once (and their portraits
   * drawn), and artist.md written again with what it has released.
   */
  async ensureProfile(artist: LabelArtist): Promise<void> {
    const folder = this.folderOf(artist);
    mkdirSync(folder, { recursive: true });
    const band = { name: artist.name, genre: artist.genre, holder: this.settings.holder };
    const draw = this.deps.image === undefined ? (prompt: string) => workersAiCover(prompt) : this.deps.image;
    if (!artist.members?.length && this.canAsk()) {
      const invented = await inventMembers(artist, this.deps.ask ?? askJson);
      const written = await writeMembers(folder, invented, band, draw);
      artist.members = written.map((one) => one.slug);
      this.save();
      this.log(`${artist.name}: ${written.map((one) => `${one.name} (${one.role})`).join(", ")}`);
    } else if (artist.members?.length) {
      // Portraits that are missing (a page added by hand, a failed drawing) are drawn now.
      await writeMembers(folder, this.cast(artist), band, draw);
    }
    writeFileSync(join(folder, "artist.md"), bandMarkdown({
      ...artist, holder: this.settings.holder, members: this.cast(artist),
      albums: artist.albums.filter((one) => one.doneAt || one.songs.some((song) => song.file)).map((one) => ({ year: one.year, title: one.title })),
    }));
  }

  /** Every artist's profile, made or brought up to date; one at a time. */
  async profiles(): Promise<void> {
    if (this.profiling) return;
    this.profiling = true;
    try {
      for (const artist of this.list()) await this.ensureProfile(artist).catch((error: unknown) => this.log(`no profile for ${artist.name}: ${(error as Error).message}`));
    } finally {
      this.profiling = false;
    }
  }

  /** A profile file anybody may read: artist.md, members/<slug>.md or members/<slug>.jpg. */
  profileFile(artistKey: string, what: string): { path: string; type: string } | null {
    const artist = this.artists.get(artistKey);
    if (!artist) return null;
    if (what === "artist.md") return { path: join(this.folderOf(artist), "artist.md"), type: "text/markdown; charset=utf-8" };
    const match = /^members\/([a-z0-9-]{1,40})\.(md|jpg)$/.exec(what);
    if (!match || !(artist.members ?? []).includes(match[1]!)) return null;
    return { path: join(this.folderOf(artist), "members", `${match[1]}.${match[2]}`), type: match[2] === "md" ? "text/markdown; charset=utf-8" : "image/jpeg" };
  }

  /** The song's MP3 when `file` is one of the label's music videos (it holds the tags, cover and words); else `file`. */
  audioFor(file: string): string {
    if (!file.endsWith(".mp4")) return file;
    for (const artist of this.artists.values()) {
      for (const album of artist.albums) {
        const song = album.songs.find((one) => one.video === file);
        if (song) return song.file;
      }
    }
    return file;
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
        if (song.lrc) entries.push({ name: `${folder}/${songBase(song)}.lrc`, path: song.lrc });
        if (song.video && (song.videoVersion ?? 1) >= SHOWN) entries.push({ name: `${folder}/${songBase(song)}.mp4`, path: song.video });
      }
      if (album.cover) entries.push({ name: `${folder}/cover.jpg`, path: album.cover });
      entries.push({ name: `${folder}/album.json`, bytes: Buffer.from(`${JSON.stringify({
        artist: artist.name, genre: artist.genre, album: album.title, year: album.year, concept: album.concept,
        label: this.settings.holder, copyright: `℗ ${album.year} ${this.settings.holder}`, madeWithAi: true,
        songs: songs.map((one) => ({ n: one.n, title: one.title, seconds: one.seconds, file: `${songBase(one)}.mp3`, lyrics: `${songBase(one)}.lyrics.txt` })),
      }, null, 2)}\n`) });
    }
    if (entries.length === 0) return null;
    // Everything by an artist comes with who they are: the band's page, each member's page and portrait.
    if (scope.kind === "artist") {
      const folder = this.folderOf(artist);
      const exists = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
      if (exists(join(folder, "artist.md"))) entries.push({ name: `${top}/artist.md`, path: join(folder, "artist.md") });
      for (const slug of artist.members ?? []) {
        for (const ext of ["md", "jpg"]) {
          const path = join(folder, "members", `${slug}.${ext}`);
          if (exists(path)) entries.push({ name: `${top}/members/${slug}.${ext}`, path });
        }
      }
    }
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
  /** The people (profile pages at /api/v1/label/<artist>/members/<slug>.md, portraits .jpg). */
  members: Array<{ slug: string; name: string; role: string; bio: string }>;
  albums: Array<{ key: string; title: string; year: number; concept: string; cover: boolean; complete: boolean; songs: Array<{ n: number; title: string; seconds: number; lyrics: string; video?: boolean }> }>;
}
