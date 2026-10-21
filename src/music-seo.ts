/**
 * nixamp.com/music for crawlers and link previews: the page shell with its
 * head and a plain summary written on the server, per page. The app reads
 * /api/v1/music and replaces the summary when its script runs, so a person
 * sees the app and a crawler, a chat app or a social card sees the title,
 * the artist, the album and its artwork without running anything.
 *
 *   /music                                  the label: genres, artists, stations
 *   /music/genre/<slug>                     a genre's artists
 *   /music/artist/<server>/<artist>         an artist: bio, members, albums
 *   /music/album/<server>/<artist>/<album>  an album: cover, songs
 *   /music/me                               the listener's own page: never indexed
 */
import type { HubArtist, HubCatalogue } from "./music-hub.ts";

const slug = (text: string): string => text.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escape = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
};
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

interface Head {
  title: string;
  description: string;
  type: string;
  image?: { url: string; alt: string };
  noindex?: boolean;
  /** og:music:* and similar, as [property, content]. */
  extra?: Array<[string, string]>;
  ld?: Record<string, unknown>;
}

/** What the server writes for a /music address: its head, and a summary for the page body. */
export interface MusicPage { head: Head; body: string; status: number }

/** The head and summary of a /music address, from the catalogue. `site` is https://nixamp.com. */
export function musicPage(path: string, catalogue: HubCatalogue, site: string): MusicPage {
  const at = (rest: string): string => `${site}${rest}`;
  const file = (server: string, rest: string): string => at(`/api/v1/music/file/${server}/${rest}`);
  const artists = catalogue.genres.flatMap((genre) => genre.artists);
  const holder = catalogue.holders[0] ?? "Profullstack, Inc.";
  const parts = path.replace(/\/+$/, "").split("/").slice(2);
  const pictureOf = (artist: HubArtist): Head["image"] => {
    const album = [...artist.albums].reverse().find((one) => one.cover);
    if (album) return { url: file(artist.server, `${artist.key}/${album.key}/cover.jpg`), alt: `${album.title} by ${artist.name}, the cover` };
    const member = artist.members?.[0];
    return member ? { url: file(artist.server, `${artist.key}/members/${member.slug}.jpg`), alt: `${member.name} of ${artist.name}` } : undefined;
  };
  const artistLink = (artist: HubArtist): string => `/music/artist/${artist.server}/${artist.key}`;
  const missing = (what: string): MusicPage => ({
    status: 404,
    head: { title: `No such ${what} · nixamp music`, description: `Nothing by that name is on nixamp music.`, type: "website", noindex: true },
    body: `<h1>No such ${escape(what)}</h1><p><a href="/music">Every artist on nixamp music</a></p>`,
  });

  if (parts[0] === "me") {
    return {
      status: 200,
      head: { title: "My music · nixamp", description: "The songs and albums you bought on nixamp, and the artists you follow.", type: "website", noindex: true },
      body: "<h1>My music</h1><p>Sign in to see what you bought and who you follow.</p>",
    };
  }

  if (parts[0] === "genre" && parts[1]) {
    const genre = catalogue.genres.find((one) => slug(one.genre) === parts[1]);
    if (!genre) return missing("genre");
    const names = genre.artists.map((one) => one.name);
    const lead = genre.artists[0];
    return {
      status: 200,
      head: {
        title: `${genre.genre} · nixamp music`,
        description: clip(`${genre.genre} by AI artists on nixamp: ${names.join(", ")}. Listen free on the live station; follow the artists; buy the songs.`, 200),
        type: "website",
        ...(lead && pictureOf(lead) ? { image: pictureOf(lead)! } : {}),
      },
      body: `<h1>${escape(genre.genre)}</h1><ul>${genre.artists.map((one) => `<li><a href="${artistLink(one)}">${escape(one.name)}</a>${one.bio ? `: ${escape(clip(one.bio, 160))}` : ""}</li>`).join("")}</ul>`,
    };
  }

  if (parts[0] === "artist" && parts[1] && parts[2]) {
    const artist = artists.find((one) => one.server === parts[1] && one.key === parts[2]);
    if (!artist) return missing("artist");
    const image = pictureOf(artist);
    const albums = artist.albums.filter((one) => one.songs.length > 0);
    const members = artist.members ?? [];
    return {
      status: 200,
      head: {
        title: `${artist.name} · ${artist.genre} · nixamp music`,
        description: clip(artist.bio || `${artist.name}, ${artist.genre} on nixamp: ${albums.length} album${albums.length === 1 ? "" : "s"}.`, 200),
        type: "profile",
        ...(image ? { image } : {}),
        ld: {
          "@context": "https://schema.org", "@type": "MusicGroup", name: artist.name, genre: artist.genre, url: at(artistLink(artist)),
          ...(artist.bio ? { description: artist.bio } : {}),
          ...(image ? { image: image.url } : {}),
          ...(members.length ? { member: members.map((one) => ({ "@type": "Person", name: one.name, ...(one.role ? { roleName: one.role } : {}) })) } : {}),
          album: albums.map((one) => ({ "@type": "MusicAlbum", name: one.title, url: at(`/music/album/${artist.server}/${artist.key}/${one.key}`), ...(one.year ? { datePublished: String(one.year) } : {}) })),
          recordLabel: { "@type": "Organization", name: holder },
        },
      },
      body: `<p><a href="/music">Music</a> / <a href="/music/genre/${slug(artist.genre)}">${escape(artist.genre)}</a></p><h1>${escape(artist.name)}</h1>`
        + (artist.bio ? `<p>${escape(artist.bio)}</p>` : "")
        + (members.length ? `<h2>Members</h2><ul>${members.map((one) => `<li>${escape(one.name)}${one.role ? `, ${escape(one.role)}` : ""}</li>`).join("")}</ul>` : "")
        + (albums.length ? `<h2>Albums</h2><ul>${albums.map((one) => `<li><a href="/music/album/${artist.server}/${artist.key}/${one.key}">${escape(one.title)}</a>${one.year ? ` (${one.year})` : ""}</li>`).join("")}</ul>` : ""),
    };
  }

  if (parts[0] === "album" && parts[1] && parts[2] && parts[3]) {
    const artist = artists.find((one) => one.server === parts[1] && one.key === parts[2]);
    const album = artist?.albums.find((one) => one.key === parts[3]);
    if (!artist || !album) return missing("album");
    const image = album.cover ? { url: file(artist.server, `${artist.key}/${album.key}/cover.jpg`), alt: `${album.title} by ${artist.name}, the cover` } : pictureOf(artist);
    const url = at(`/music/album/${artist.server}/${artist.key}/${album.key}`);
    return {
      status: 200,
      head: {
        title: `${album.title} by ${artist.name} · nixamp music`,
        description: clip(album.concept || `${album.title}, ${album.songs.length} songs by ${artist.name} (${artist.genre})${album.year ? `, ${album.year}` : ""}. Listen free on nixamp.`, 200),
        type: "music.album",
        ...(image ? { image } : {}),
        extra: [
          ["music:musician", at(artistLink(artist))],
          ...(album.year ? [["music:release_date", String(album.year)] as [string, string]] : []),
          ...album.songs.slice(0, 30).map((song) => ["music:song", `${url}#${song.n}`] as [string, string]),
        ],
        ld: {
          "@context": "https://schema.org", "@type": "MusicAlbum", name: album.title, url,
          byArtist: { "@type": "MusicGroup", name: artist.name, url: at(artistLink(artist)) },
          genre: artist.genre, numTracks: album.songs.length,
          ...(album.year ? { datePublished: String(album.year) } : {}),
          ...(image ? { image: image.url } : {}),
          ...(album.concept ? { description: album.concept } : {}),
          recordLabel: { "@type": "Organization", name: holder },
          track: album.songs.map((song) => ({ "@type": "MusicRecording", name: song.title, position: song.n, ...(song.seconds ? { duration: `PT${Math.floor(song.seconds / 60)}M${Math.round(song.seconds % 60)}S` } : {}) })),
        },
      },
      body: `<p><a href="/music">Music</a> / <a href="${artistLink(artist)}">${escape(artist.name)}</a></p><h1>${escape(album.title)}</h1>`
        + `<p>by <a href="${artistLink(artist)}">${escape(artist.name)}</a>${album.year ? ` · ${album.year}` : ""} · ${album.songs.length} songs</p>`
        + (album.concept ? `<p>${escape(album.concept)}</p>` : "")
        + `<ol>${album.songs.map((song) => `<li>${escape(song.title)}${song.seconds ? ` <span>${clock(song.seconds)}</span>` : ""}</li>`).join("")}</ol>`,
    };
  }

  if (parts.length > 0) return missing("page");
  const lead = artists.find((one) => pictureOf(one));
  return {
    status: 200,
    head: {
      title: "AI music, live and on demand · nixamp",
      description: clip(`Original bands and artists, written and sung by AI and released by ${holder}: ${catalogue.genres.map((one) => one.genre).join(", ")}. Listen free; follow the artists; buy the songs.`, 200),
      type: "website",
      ...(lead ? { image: pictureOf(lead)! } : {}),
    },
    body: `<h1>AI music, live and on demand</h1>${catalogue.genres.map((genre) => `<h2><a href="/music/genre/${slug(genre.genre)}">${escape(genre.genre)}</a></h2><ul>${genre.artists.map((one) => `<li><a href="${artistLink(one)}">${escape(one.name)}</a></li>`).join("")}</ul>`).join("")}`,
  };
}

/** The shell with a page's head and summary written in. */
export function renderMusicPage(shell: string, page: MusicPage, url: string): string {
  const { head } = page;
  const meta: string[] = [
    `<title>${escape(head.title)}</title>`,
    `<meta name="description" content="${escape(head.description)}" />`,
    `<link rel="canonical" href="${escape(url)}" />`,
    ...(head.noindex ? [`<meta name="robots" content="noindex" />`] : []),
    `<meta property="og:site_name" content="nixamp" />`,
    `<meta property="og:title" content="${escape(head.title.replace(/ · nixamp( music)?$/, ""))}" />`,
    `<meta property="og:description" content="${escape(head.description)}" />`,
    `<meta property="og:type" content="${escape(head.type)}" />`,
    `<meta property="og:url" content="${escape(url)}" />`,
    ...(head.image ? [
      `<meta property="og:image" content="${escape(head.image.url)}" />`,
      `<meta property="og:image:alt" content="${escape(head.image.alt)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:image" content="${escape(head.image.url)}" />`,
    ] : [`<meta name="twitter:card" content="summary" />`]),
    `<meta name="twitter:title" content="${escape(head.title)}" />`,
    `<meta name="twitter:description" content="${escape(head.description)}" />`,
    ...(head.extra ?? []).map(([property, content]) => `<meta property="${escape(property)}" content="${escape(content)}" />`),
    ...(head.ld ? [`<script type="application/ld+json">${JSON.stringify(head.ld).replace(/</g, "\\u003c")}</script>`] : []),
  ];
  return shell
    .replace(/<title>[^<]*<\/title>/, "")
    .replace(/<meta name="description"[^>]*>/, "")
    .replace("</head>", `    ${meta.join("\n    ")}\n  </head>`)
    .replace(/(<main id="view"[^>]*>)(<\/main>)/, `$1${page.body}$2`);
}
