/**
 * Whether this server goes in the public directory.
 *
 * A listing is a phone code and a link anybody can open, so it is a thing
 * somebody chose, not a thing that happens because a daemon had no terminal
 * to ask on. The choice is asked once, or taken from a flag, and written into
 * config.json beside the library, and every later start reads it back.
 *
 * Servers that were listed before the choice was written down keep being
 * listed: a daemon without a terminal used to publish by itself, and quietly
 * taking it off the directory on an update would be changing somebody's
 * choice for them. A server new to this machine is not listed until asked.
 */
export type PublishFlag = "ask" | "yes" | "no";

/**
 * "yes" or "no" when the answer is already known, "ask" when there is a
 * person at the terminal to ask.
 */
export function publishChoice(
  flag: PublishFlag,
  recorded: boolean | undefined,
  interactive: boolean,
  established: boolean,
): "yes" | "no" | "ask" {
  if (flag !== "ask") return flag;
  if (recorded !== undefined) return recorded ? "yes" : "no";
  if (interactive) return "ask";
  return established ? "yes" : "no";
}

/** Whether to write the answer down: only a choice nobody had made yet. */
export function shouldRecord(flag: PublishFlag, recorded: boolean | undefined): boolean {
  return flag === "ask" && recorded === undefined;
}
