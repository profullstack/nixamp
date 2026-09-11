import { randomUUID } from "node:crypto";
import type { Queryable } from "./follows.ts";

export const PANEL_REGIONS = ["primary", "secondary", "sidebar", "drawer", "bottom", "overlay"] as const;
export const LAYOUT_SCOPES = ["system", "brand", "role", "user", "event"] as const;

export type PanelRegion = (typeof PANEL_REGIONS)[number];
export type LayoutScope = (typeof LAYOUT_SCOPES)[number];

export interface PanelDefinition {
  type: string;
  title: string;
  permissions?: string[];
}

export interface PanelInstance {
  id: string;
  type: string;
  title?: string;
  visible: boolean;
  enabled: boolean;
  region: PanelRegion;
  order: number;
  size?: { width?: number | string; height?: number | string };
  collapsed?: boolean;
  permissions?: string[];
  config: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Layout {
  id: string;
  name: string;
  scope: LayoutScope;
  scopeId?: string;
  ownerId?: string;
  panels: PanelInstance[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class LayoutError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export const PANEL_REGISTRY: readonly PanelDefinition[] = [
  { type: "event-header", title: "Event" },
  { type: "player", title: "Listen" },
  { type: "host", title: "Host" },
  { type: "about", title: "About" },
  { type: "join", title: "Join" },
  { type: "stage", title: "Stage", permissions: ["room.speak"] },
  // A show is watched as well as heard, and what surrounds it is how it earns.
  { type: "stage-video", title: "Stage" },
  { type: "setlist", title: "Setlist" },
  { type: "tip-jar", title: "Tip Jar" },
  { type: "merch", title: "Merch" },
  { type: "tickets", title: "Tickets" },
  { type: "lineup", title: "Lineup" },
  { type: "soundcheck", title: "Soundcheck", permissions: ["event.perform"] },
  { type: "chat", title: "Chat" },
  { type: "participants", title: "People", permissions: ["room.listen"] },
  { type: "speakers", title: "Speakers", permissions: ["room.speak"] },
  { type: "hand-raises", title: "Hand Raises", permissions: ["event.moderate"] },
  { type: "raise-hand", title: "Raise Hand", permissions: ["room.raise_hand"] },
  { type: "questions", title: "Questions" },
  { type: "invite", title: "Invite", permissions: ["event.invite"] },
  { type: "share", title: "Share" },
  { type: "schedule", title: "Schedule", permissions: ["event.update"] },
  { type: "event-controls", title: "Event Controls", permissions: ["event.start"] },
  { type: "recording", title: "Recording", permissions: ["recording.start"] },
  { type: "resources", title: "Resources" },
  { type: "replay", title: "Replay" },
  { type: "moderation", title: "Moderation", permissions: ["event.moderate"] },
  { type: "diagnostics", title: "Diagnostics", permissions: ["admin.diagnostics"] },
  { type: "network-health", title: "Network Health", permissions: ["admin.network"] },
  { type: "advanced-nixamp", title: "Advanced NixAmp", permissions: ["admin.network"] },
] as const;

const knownPanels = new Set(PANEL_REGISTRY.map((panel) => panel.type));

function presetPanel(
  id: string,
  type: string,
  region: PanelRegion,
  order: number,
  options: Partial<Pick<PanelInstance, "visible" | "enabled" | "collapsed" | "permissions" | "config">> = {},
): PanelInstance {
  const now = new Date(0).toISOString();
  const definition = PANEL_REGISTRY.find((panel) => panel.type === type);
  return {
    id,
    type,
    visible: options.visible ?? true,
    enabled: options.enabled ?? true,
    region,
    order,
    ...(options.collapsed !== undefined ? { collapsed: options.collapsed } : {}),
    ...(options.permissions ?? definition?.permissions
      ? { permissions: options.permissions ?? definition?.permissions }
      : {}),
    config: options.config ?? {},
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A preset belongs to the family its name starts with -- `concert-artist` is
 * the concert family -- so a new vertical is a set of presets and nothing else.
 * The admin layout is the exception: it is a role, not a brand.
 */
function preset(name: string, panels: PanelInstance[]): Layout {
  const now = new Date(0).toISOString();
  const family = name.split("-")[0] ?? name;
  return {
    id: name,
    name,
    scope: name === "nixamp-admin" ? "role" : "brand",
    scopeId: name === "nixamp-admin" ? "admin" : family,
    panels,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

const viewerPanels = [
    presetPanel("event-header", "event-header", "primary", 0),
    presetPanel("player", "player", "primary", 1),
    presetPanel("host", "host", "secondary", 2),
    presetPanel("about", "about", "secondary", 3),
    presetPanel("join", "join", "bottom", 4),
    presetPanel("chat", "chat", "drawer", 5, { collapsed: true }),
    presetPanel("questions", "questions", "drawer", 6, { collapsed: true }),
    presetPanel("resources", "resources", "drawer", 7, { collapsed: true }),
] satisfies PanelInstance[];

const memberPanels = [
    presetPanel("event-header", "event-header", "primary", 0),
    presetPanel("player", "player", "primary", 1),
    presetPanel("host", "host", "secondary", 2),
    presetPanel("chat", "chat", "secondary", 3),
    presetPanel("questions", "questions", "secondary", 4),
    presetPanel("participants", "participants", "sidebar", 5),
    presetPanel("invite", "invite", "sidebar", 6),
    presetPanel("raise-hand", "raise-hand", "bottom", 7),
    presetPanel("resources", "resources", "bottom", 8),
] satisfies PanelInstance[];

const hostPanels = [
    presetPanel("event-header", "event-header", "primary", 0),
    presetPanel("stage", "stage", "primary", 1),
    presetPanel("speakers", "speakers", "secondary", 2),
    presetPanel("participants", "participants", "secondary", 3),
    presetPanel("invite", "invite", "sidebar", 4),
    presetPanel("chat", "chat", "sidebar", 5),
    presetPanel("hand-raises", "hand-raises", "sidebar", 6),
    presetPanel("questions", "questions", "sidebar", 7),
    presetPanel("event-controls", "event-controls", "bottom", 8),
    presetPanel("schedule", "schedule", "bottom", 9),
    presetPanel("recording", "recording", "bottom", 10),
    presetPanel("share", "share", "bottom", 11),
] satisfies PanelInstance[];

const adminPanels = [
  ...hostPanels.map((panel) => ({ ...panel })),
  presetPanel("moderation", "moderation", "sidebar", 20),
  presetPanel("diagnostics", "diagnostics", "sidebar", 21),
  presetPanel("network-health", "network-health", "sidebar", 22),
  presetPanel("advanced-nixamp", "advanced-nixamp", "drawer", 23),
] satisfies PanelInstance[];

/**
 * A live show. The stage is the thing; the setlist says what is happening, the
 * tip jar and the merch shelf are how a night pays, and the till is a panel
 * like any other so a client that cannot sell tickets simply does not draw it.
 */
const concertViewerPanels = [
  presetPanel("event-header", "event-header", "primary", 0),
  presetPanel("stage-video", "stage-video", "primary", 1),
  presetPanel("tickets", "tickets", "secondary", 2),
  presetPanel("lineup", "lineup", "secondary", 3),
  presetPanel("about", "about", "secondary", 4),
  presetPanel("share", "share", "bottom", 5),
  presetPanel("chat", "chat", "drawer", 6, { collapsed: true }),
] satisfies PanelInstance[];

const concertTicketHolderPanels = [
  presetPanel("event-header", "event-header", "primary", 0),
  presetPanel("stage-video", "stage-video", "primary", 1),
  presetPanel("setlist", "setlist", "secondary", 2),
  presetPanel("chat", "chat", "secondary", 3),
  presetPanel("tip-jar", "tip-jar", "sidebar", 4),
  presetPanel("merch", "merch", "sidebar", 5),
  presetPanel("participants", "participants", "sidebar", 6),
  presetPanel("share", "share", "bottom", 7),
] satisfies PanelInstance[];

const concertArtistPanels = [
  presetPanel("event-header", "event-header", "primary", 0),
  presetPanel("stage-video", "stage-video", "primary", 1),
  presetPanel("setlist", "setlist", "secondary", 2),
  presetPanel("soundcheck", "soundcheck", "secondary", 3),
  presetPanel("chat", "chat", "sidebar", 4),
  presetPanel("participants", "participants", "sidebar", 5),
  presetPanel("invite", "invite", "sidebar", 6),
  presetPanel("tip-jar", "tip-jar", "sidebar", 7),
  presetPanel("merch", "merch", "sidebar", 8),
  presetPanel("event-controls", "event-controls", "bottom", 9),
  presetPanel("schedule", "schedule", "bottom", 10),
  presetPanel("recording", "recording", "bottom", 11),
  presetPanel("tickets", "tickets", "bottom", 12),
  presetPanel("share", "share", "bottom", 13),
] satisfies PanelInstance[];

export const LAYOUT_PRESETS: Readonly<Record<string, Layout>> = {
  "backtoschool-viewer": preset("backtoschool-viewer", viewerPanels),
  "backtoschool-member": preset("backtoschool-member", memberPanels),
  "backtoschool-host": preset("backtoschool-host", hostPanels),
  "concert-viewer": preset("concert-viewer", concertViewerPanels),
  "concert-ticketholder": preset("concert-ticketholder", concertTicketHolderPanels),
  "concert-artist": preset("concert-artist", concertArtistPanels),
  "nixamp-admin": preset("nixamp-admin", adminPanels),
};

/** Where a viewer stands in the room, whatever kind of room it is. */
export type LayoutRole = "viewer" | "member" | "host";

/**
 * The preset for a kind of event and who is looking at it.
 *
 * One place, because otherwise every client invents its own mapping and a new
 * kind of live means editing all of them. A kind with no presets of its own
 * falls back to the general ones rather than to nothing.
 */
export function layoutNameFor(kind: string, role: LayoutRole): string {
  if (kind === "concert") {
    return role === "host" ? "concert-artist" : role === "member" ? "concert-ticketholder" : "concert-viewer";
  }
  return `backtoschool-${role}`;
}

const LAYOUT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS nixamp_layouts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    scope       TEXT NOT NULL,
    scope_id    TEXT,
    owner_id    TEXT,
    panels      JSONB NOT NULL DEFAULT '[]'::jsonb,
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (scope IN ('system', 'brand', 'role', 'user', 'event'))
  );
  CREATE INDEX IF NOT EXISTS nixamp_layouts_resolution
    ON nixamp_layouts (scope, scope_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS nixamp_layout_history (
    id              BIGSERIAL PRIMARY KEY,
    layout_id       TEXT NOT NULL,
    version         INTEGER NOT NULL,
    panels          JSONB NOT NULL,
    changed_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS nixamp_layout_history_layout
    ON nixamp_layout_history (layout_id, version DESC);
`;

function string(value: unknown, name: string, limit: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new LayoutError(`${name} is required`, 422);
    return "";
  }
  if (typeof value !== "string") throw new LayoutError(`${name} must be text`, 422);
  const result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (required && !result) throw new LayoutError(`${name} is required`, 422);
  if (result.length > limit) throw new LayoutError(`${name} is too long`, 422);
  return result;
}

function when(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LayoutError(`${name} must be an object`, 422);
  }
  return value as Record<string, unknown>;
}

export function panelFrom(value: unknown, position = 0): PanelInstance {
  const input = object(value, "panel");
  const id = string(input["id"] ?? randomUUID(), "panel id", 100, true);
  const type = string(input["type"], "panel type", 100, true);
  const region = string(input["region"] ?? "primary", "panel region", 20, true);
  if (!PANEL_REGIONS.includes(region as PanelRegion)) throw new LayoutError("panel region is invalid", 422);
  const order = input["order"] === undefined ? position : Number(input["order"]);
  if (!Number.isInteger(order) || order < 0) throw new LayoutError("panel order must be a non-negative integer", 422);
  const permissions = input["permissions"];
  if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((item) => typeof item !== "string"))) {
    throw new LayoutError("panel permissions must be text", 422);
  }
  const version = input["version"] === undefined ? 1 : Number(input["version"]);
  if (!Number.isInteger(version) || version < 1) throw new LayoutError("panel version must be a positive integer", 422);
  const createdAt = typeof input["createdAt"] === "string" ? input["createdAt"] : new Date().toISOString();
  const updatedAt = typeof input["updatedAt"] === "string" ? input["updatedAt"] : createdAt;
  return {
    id,
    type,
    ...(input["title"] !== undefined ? { title: string(input["title"], "panel title", 100) } : {}),
    visible: input["visible"] === undefined ? true : Boolean(input["visible"]),
    enabled: input["enabled"] === undefined ? true : Boolean(input["enabled"]),
    region: region as PanelRegion,
    order,
    ...(input["size"] !== undefined ? { size: object(input["size"], "panel size") as PanelInstance["size"] } : {}),
    ...(input["collapsed"] !== undefined ? { collapsed: Boolean(input["collapsed"]) } : {}),
    ...(permissions !== undefined ? { permissions: permissions as string[] } : {}),
    config: object(input["config"], "panel config"),
    version,
    createdAt,
    updatedAt,
  };
}

function panelsFrom(value: unknown): PanelInstance[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) throw new LayoutError("panels must be a list", 422);
  const ids = new Set<string>();
  return parsed.map((panel, index) => {
    const result = panelFrom(panel, index);
    if (ids.has(result.id)) throw new LayoutError(`panel id ${result.id} is duplicated`, 422);
    ids.add(result.id);
    return result;
  }).sort((a, b) => a.order - b.order);
}

function layoutFrom(row: Record<string, unknown>): Layout {
  return {
    id: String(row["id"] ?? ""),
    name: String(row["name"] ?? ""),
    scope: String(row["scope"] ?? "user") as LayoutScope,
    ...(row["scope_id"] ? { scopeId: String(row["scope_id"]) } : {}),
    ...(row["owner_id"] ? { ownerId: String(row["owner_id"]) } : {}),
    panels: panelsFrom(row["panels"] ?? []),
    version: Number(row["version"] ?? 1),
    createdAt: when(row["created_at"]),
    updatedAt: when(row["updated_at"]),
  };
}

export function presetLayout(name: string): Layout | null {
  const found = LAYOUT_PRESETS[name];
  return found ? structuredClone(found) : null;
}

export function resolveLayout(layers: readonly Layout[], permissions: ReadonlySet<string>): PanelInstance[] {
  const resolved = new Map<string, PanelInstance>();
  for (const layout of layers) {
    for (const panel of layout.panels) resolved.set(panel.id, structuredClone(panel));
  }
  return [...resolved.values()]
    .filter((panel) => knownPanels.has(panel.type) && panel.enabled && panel.visible)
    .filter((panel) => (panel.permissions ?? []).every((permission) => permissions.has(permission)))
    .sort((a, b) => a.order - b.order);
}

export class Layouts {
  private ready: Promise<void> | null = null;

  constructor(private readonly db: Queryable) {}

  private async ensure(): Promise<void> {
    this.ready ??= this.db.query(LAYOUT_SCHEMA).then(() => undefined);
    await this.ready;
  }

  async get(reference: string): Promise<Layout | null> {
    const builtIn = presetLayout(reference);
    if (builtIn) return builtIn;
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT * FROM nixamp_layouts WHERE id = $1 OR name = $1 LIMIT 1",
      [reference],
    );
    return rows[0] ? layoutFrom(rows[0]) : null;
  }

  async scoped(scope: LayoutScope, scopeId: string): Promise<Layout[]> {
    await this.ensure();
    const { rows } = await this.db.query(
      "SELECT * FROM nixamp_layouts WHERE scope = $1 AND scope_id = $2 ORDER BY updated_at",
      [scope, scopeId],
    );
    return rows.map(layoutFrom);
  }

  async create(input: {
    name: unknown;
    scope: unknown;
    scopeId?: unknown;
    panels?: unknown;
  }, ownerId: string): Promise<Layout> {
    const name = string(input.name, "layout name", 100, true);
    const scope = string(input.scope, "layout scope", 20, true);
    if (!LAYOUT_SCOPES.includes(scope as LayoutScope)) throw new LayoutError("layout scope is invalid", 422);
    if ((scope === "user" || scope === "event") && !ownerId) throw new LayoutError("sign in to create this layout", 401);
    const panels = panelsFrom(input.panels ?? []);
    await this.ensure();
    const { rows } = await this.db.query(
      `INSERT INTO nixamp_layouts (id, name, scope, scope_id, owner_id, panels)
       VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6::jsonb)
       RETURNING *`,
      [randomUUID(), name, scope, string(input.scopeId, "scopeId", 160), ownerId, JSON.stringify(panels)],
    );
    const row = rows[0];
    if (!row) throw new LayoutError("could not create the layout", 500);
    return layoutFrom(row);
  }

  async update(reference: string, panels: unknown, version: unknown, accountId: string): Promise<Layout> {
    const current = await this.get(reference);
    if (!current) throw new LayoutError("layout not found", 404);
    if (!current.ownerId || current.ownerId !== accountId) {
      throw new LayoutError("only the layout owner can change it", 403);
    }
    if (!Number.isInteger(version) || Number(version) < 1) throw new LayoutError("version is required", 428);
    if (Number(version) !== current.version) throw new LayoutError("the layout changed; reload it and try again", 409);
    const nextPanels = panelsFrom(panels);
    await this.ensure();
    const { rows } = await this.db.query(
      `WITH previous AS (
         SELECT id, version, panels FROM nixamp_layouts
         WHERE (id = $1 OR name = $1) AND owner_id = $2 AND version = $3
       ), remembered AS (
         INSERT INTO nixamp_layout_history (layout_id, version, panels, changed_by)
         SELECT id, version, panels, $2 FROM previous
       )
       UPDATE nixamp_layouts SET panels = $4::jsonb, version = version + 1, updated_at = now()
       WHERE id IN (SELECT id FROM previous)
       RETURNING *`,
      [reference, accountId, current.version, JSON.stringify(nextPanels)],
    );
    const row = rows[0];
    if (!row) throw new LayoutError("the layout changed; reload it and try again", 409);
    return layoutFrom(row);
  }

  async addPanel(reference: string, panel: unknown, version: unknown, accountId: string): Promise<Layout> {
    const current = await this.get(reference);
    if (!current) throw new LayoutError("layout not found", 404);
    return this.update(reference, [...current.panels, panelFrom(panel, current.panels.length)], version, accountId);
  }

  async updatePanel(reference: string, panelId: string, patch: unknown, version: unknown, accountId: string): Promise<Layout> {
    const current = await this.get(reference);
    if (!current) throw new LayoutError("layout not found", 404);
    const at = current.panels.findIndex((panel) => panel.id === panelId);
    if (at < 0) throw new LayoutError("panel not found", 404);
    const changes = object(patch, "panel");
    const previous = current.panels[at]!;
    const updated = panelFrom({ ...previous, ...changes, id: previous.id, version: previous.version + 1 }, at);
    const panels = current.panels.with(at, updated);
    return this.update(reference, panels, version, accountId);
  }

  async removePanel(reference: string, panelId: string, version: unknown, accountId: string): Promise<Layout> {
    const current = await this.get(reference);
    if (!current) throw new LayoutError("layout not found", 404);
    if (!current.panels.some((panel) => panel.id === panelId)) throw new LayoutError("panel not found", 404);
    return this.update(reference, current.panels.filter((panel) => panel.id !== panelId), version, accountId);
  }

  async reset(reference: string, presetName: string, version: unknown, accountId: string): Promise<Layout> {
    const defaults = presetLayout(presetName);
    if (!defaults) throw new LayoutError("layout preset not found", 404);
    return this.update(reference, defaults.panels, version, accountId);
  }
}
