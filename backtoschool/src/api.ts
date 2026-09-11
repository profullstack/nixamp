import type { LiveEvent } from "../../src/live-events.ts";
import type { Layout } from "../../src/layouts.ts";

export interface EventEnvelope {
  event: LiveEvent;
  permissions: string[];
  layout: Layout;
}

export interface Account {
  id: string;
  email: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  let value: unknown = {};
  try {
    value = await response.json();
  } catch {
    value = {};
  }
  if (!response.ok) {
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    throw new ApiError(String(record["error"] ?? "That did not work."), response.status);
  }
  return value as T;
}

export function send(path: string, value: unknown, method = "POST"): Promise<unknown> {
  return api(path, { method, body: JSON.stringify(value) });
}
