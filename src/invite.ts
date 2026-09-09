/**
 * Asking somebody to watch, when that somebody is not technical.
 *
 * A share link is a URL with a key in it, which is fine for the person who
 * runs the server and useless as a thing to text your mother. An invite is two
 * things written as a sentence: a link that opens a player, and a phone number
 * with a code, which is the line where everyone watching talks to each other.
 * The phone is not another way to hear the stream -- it is the 800 number
 * beside a podcast. The show is on the screen; the call is the company.
 *
 * The sender is signed in, because sending is an action with a cost: a text
 * message is money and somebody's phone. The recipient signs in too, but only
 * once and only at the far end of a single click, because a stream can ask to
 * be paid for -- x402 starts charging past five listeners -- and there is
 * nobody to charge without an account. The dial-in path is the exception and
 * stays open to anybody, since a phone call cannot sign in to anything.
 */

/** Where the phone line answers, and what to key when it does. */
export interface Invite {
  /** What the stream is called, as the recipient will see it. */
  name: string;
  /** A link that opens a player on this stream, listen only. */
  link: string;
  /** The phone number, when this stream is one the line knows about. */
  phone: string;
  /** The six digits that reach this stream's room, once it has been published. */
  code: string;
}

/** Looks like a phone number rather than an address. */
export function isPhone(value: string): boolean {
  return /^\+?[\d\s().-]{7,20}$/.test(value.trim()) && /\d{7}/.test(value.replace(/\D/g, ""));
}

/** Looks like somewhere an email could arrive. */
export function isEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value.trim());
}

/**
 * The message itself.
 *
 * Short, because it is going into a text message, and ordered by how likely
 * each way in is to work for the person reading it. The link first: most
 * people have a browser in their hand. The phone last, because it is the one
 * that needs no browser at all and is therefore the fallback that never fails.
 */
export function inviteText(invite: Invite): string {
  const lines = [`${invite.name} is streaming.`, "", `Watch: ${invite.link}`];
  if (invite.phone && invite.code) {
    // "to talk about it", not "to listen": the line is a room full of the
    // other people watching, and telling somebody they will hear the stream
    // down the phone is telling them something that is not true.
    lines.push("", `To talk about it: call ${invite.phone} and key ${invite.code}.`);
  }
  return lines.join("\n");
}

/** The same thing as a subject line, for the surface that wants one. */
export function inviteSubject(invite: Invite): string {
  return `${invite.name} is streaming`;
}

/**
 * A link that opens a player on this stream.
 *
 * Sent through nixamp.com when the stream is https, because that page is a
 * player anybody can already open and reaches this stream with `?url=`. An
 * http stream is sent as its own address instead: a browser refuses every
 * request from an https page to an http one, so routing it through nixamp.com
 * would produce a link that cannot work, which is worse than a plainer one
 * that does.
 */
export function watchLink(streamUrl: string, site: string): string {
  const bare = streamUrl.replace(/\/+$/, "");
  if (!bare.startsWith("https://")) return bare;
  return `${site.replace(/\/+$/, "")}/?url=${encodeURIComponent(bare)}`;
}
