/**
 * The panels: which are shown, in what order, and which are shaded.
 *
 * Winamp's windows could be dragged about and snapped into place, shaded to
 * their title bar with one click, and closed and brought back from a menu.
 * The page's panels do the same: a grip drags one into a new slot, ▁ shades
 * it, ✕ closes it, and the Panels list puts any of it back. What is decided
 * here is the pure part -- the layout as a value, read from and written to
 * one localStorage key -- so it can be tested without a page.
 *
 * `order` is every panel id in display order, whichever zone it is in;
 * `placement` says which zone and column a panel was moved to, for the ones
 * moved out of where the markup put them; `collapsed` and `closed` are the
 * shaded and the closed ones. An id nobody has heard of is kept -- a panel
 * from a newer page, or an older one -- and ignored when applied.
 */

export const PANELS_KEY = "nixamp.panels";

export interface PanelLayout {
  order: string[];
  placement: Record<string, string>;
  collapsed: string[];
  closed: string[];
}

export function emptyLayout(): PanelLayout {
  return { order: [], placement: {}, collapsed: [], closed: [] };
}

/** A panel id as the markup writes it: what is safe to keep and to look up. */
const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Where a panel was put: a zone id, a colon, and a column letter or nothing. */
const PLACE = /^[a-z][a-z0-9-]{0,63}:[ab]?$/;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const one of value) {
    if (typeof one !== "string" || !ID.test(one) || seen.has(one)) continue;
    seen.add(one);
    out.push(one);
  }
  return out;
}

/** The layout as stored, read tolerantly: anything malformed is the empty layout. */
export function parseLayout(raw: string | null | undefined): PanelLayout {
  if (!raw) return emptyLayout();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyLayout();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyLayout();
  const record = parsed as Record<string, unknown>;
  const placement: Record<string, string> = {};
  if (record["placement"] && typeof record["placement"] === "object") {
    for (const [id, where] of Object.entries(record["placement"] as Record<string, unknown>)) {
      if (ID.test(id) && typeof where === "string" && PLACE.test(where)) placement[id] = where;
    }
  }
  return {
    order: ids(record["order"]),
    placement,
    collapsed: ids(record["collapsed"]),
    closed: ids(record["closed"]),
  };
}

export function serializeLayout(layout: PanelLayout): string {
  return JSON.stringify(layout);
}

/**
 * The display order: the saved order first, for the panels that still
 * exist, then whatever the page has that was never ordered, each slotted in
 * after its nearest earlier neighbour from the markup. A new panel lands
 * about where it was designed to be, not at the end of everything.
 */
export function orderedIds(documentOrder: string[], saved: string[]): string[] {
  const present = new Set(documentOrder);
  const out = saved.filter((id) => present.has(id));
  const placed = new Set(out);
  documentOrder.forEach((id, at) => {
    if (placed.has(id)) return;
    let insertAt = 0;
    for (let back = at - 1; back >= 0; back--) {
      const where = out.indexOf(documentOrder[back] as string);
      if (where >= 0) {
        insertAt = where + 1;
        break;
      }
    }
    out.splice(insertAt, 0, id);
    placed.add(id);
  });
  return out;
}

/** A list with an id switched on or off. */
export function toggled(list: string[], id: string, on: boolean): string[] {
  const without = list.filter((one) => one !== id);
  return on ? [...without, id] : without;
}
