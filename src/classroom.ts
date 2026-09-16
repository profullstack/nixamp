/** Public classroom metadata, shared by the API and the small school client. */
export interface ClassroomSettings {
  broadcastUrl?: string;
  hostName?: string;
  homepageUrl?: string;
  avatarUrl?: string;
  recurrence?: "daily" | "weekly";
}

export function publicWebUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function classroomBroadcast(value: unknown): { provider: "pairux" | "nixamp" | "media"; url: string; embed: string; join: string } | null {
  const safe = publicWebUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  if (!url.port && (url.hostname === "pairux.com" || url.hostname === "www.pairux.com")) {
    const code = /^\/(?:l|join|embed)\/([A-Za-z0-9_-]{1,64})\/?$/.exec(url.pathname)?.[1];
    if (!code) return null;
    return { provider: "pairux", url: `https://pairux.com/l/${code}`, embed: `https://pairux.com/embed/${code}`, join: `https://pairux.com/join/${code}` };
  }
  if (!url.port && (url.hostname === "nixamp.com" || url.hostname === "www.nixamp.com")) {
    if (url.pathname !== "/") return null;
    // Never publish an admin credential in a classroom share link.
    const server = url.searchParams.get("url") || "";
    // The server's Share panel supplies a viewer URL without a track selection.
    const play = url.searchParams.get("play") || (server ? "live" : "");
    if (/\/admin\//i.test(server) || /\/admin\//i.test(play) || url.searchParams.has("key")) return null;
    if (server && !publicWebUrl(server)) return null;
    if (!/^(?:live|channel:[^\s]+|track:\d+)$/.test(play) && !publicWebUrl(play)) return null;
    const clean = new URL("https://nixamp.com/");
    if (server) clean.searchParams.set("url", server);
    clean.searchParams.set("play", play);
    const original = clean.href;
    clean.searchParams.set("embed", "1");
    return { provider: "nixamp", url: original, embed: clean.href, join: original };
  }
  // A self-hosted Nixamp viewer link can be played through the shared client.
  if (url.hostname.endsWith(".nixamp.com") && /^\/view\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) && !url.search) {
    const player = new URL("https://nixamp.com/");
    player.searchParams.set("url", url.href);
    player.searchParams.set("play", "live");
    return classroomBroadcast(player.href);
  }
  // Direct media is loaded by the browser, never fetched by this server.
  if (/\.(?:m3u8|mp4|webm|mp3|m4a|ogg|wav|ts)$/i.test(url.pathname)) {
    return { provider: "media", url: safe, embed: safe, join: safe };
  }
  return null;
}
