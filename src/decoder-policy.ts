/**
 * What a decoder may open while reading one source.
 *
 * ffmpeg follows references inside what it reads: an .m3u8 names segments, a
 * concat list names files, a playlist on disk can name a URL. A file in
 * somebody's library is untrusted input, and without a list of protocols it
 * can make this machine fetch any address it likes, on the LAN included. So
 * a file on disk may open files and pipes and nothing else, and a link may
 * open the network protocols a stream needs and not the local file system.
 *
 * Sources this does not recognise (an ingest URL, a lavfi graph) are left
 * alone rather than broken: the list is for what comes out of a library or a
 * pasted link, which is where untrusted references come from.
 */

/** A file in a library: itself, and the pipes the pipeline is built from. */
export const LOCAL_PROTOCOLS = "file,pipe,fd";

/** A link: the network, as streams use it, and never `file`. */
export const REMOTE_PROTOCOLS = [
  "http", "https", "tcp", "tls", "crypto", "data", "httpproxy",
  "rtmp", "rtmps", "rtmpt", "rtmpts", "rtmpe", "rtmpte", "ffrtmpcrypt", "ffrtmphttp",
].join(",");

/** The `-protocol_whitelist` to put before this source's `-i`, or nothing. */
export function protocolArgs(source: string): string[] {
  if (source === "-" || source.startsWith("pipe:")) return ["-protocol_whitelist", LOCAL_PROTOCOLS];
  if (/^(https?|rtmp[a-z]*):\/\//i.test(source)) return ["-protocol_whitelist", REMOTE_PROTOCOLS];
  if (/^file:/i.test(source)) return ["-protocol_whitelist", LOCAL_PROTOCOLS];
  // Any other scheme (two letters or more, so `C:\` is still a path).
  if (/^[a-z][a-z0-9+.-]+:/i.test(source)) return [];
  return ["-protocol_whitelist", LOCAL_PROTOCOLS];
}
