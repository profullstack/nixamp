import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StationUsage, alertsFor, limitsFromEnv, monthOf } from "../src/station-metering.ts";

test("limits come from the environment, with defaults that leave room", () => {
  assert.deepEqual(limitsFromEnv({}), { stationListeners: 200, totalListeners: 500, runningStations: 1000, monthlyBytes: 0 });
  // Kept in config.json, so an update's restart does not lose them; the environment still wins.
  assert.equal(limitsFromEnv({}, { runningStations: 30 }).runningStations, 30);
  assert.equal(limitsFromEnv({ NIXAMP_MAX_RUNNING_STATIONS: "5" }, { runningStations: 30 }).runningStations, 5);
  assert.equal(limitsFromEnv({}, { monthlyGb: 2 }).monthlyBytes, 2 * 1024 ** 3);
  assert.equal(limitsFromEnv({ NIXAMP_STATION_MONTHLY_GB: "1.5" }).monthlyBytes, Math.round(1.5 * 1024 ** 3));
  assert.equal(limitsFromEnv({ NIXAMP_STATION_MAX_LISTENERS: "nonsense" }).stationListeners, 200);
});

test("listening and delivery are counted, and admission says why not", () => {
  const dir = mkdtempSync(join(tmpdir(), "nixamp-usage-"));
  let now = Date.UTC(2026, 9, 31, 23, 59, 0);
  try {
    const usage = new StationUsage(StationUsage.fileFor(dir, 1), () => now);
    const limits = { stationListeners: 2, totalListeners: 3, runningStations: 1, monthlyBytes: 1000 };
    assert.equal(usage.admit("a", limits), null);
    const left1 = usage.joined("a");
    usage.joined("a");
    assert.equal(usage.admit("a", limits)?.code, "station_full");
    usage.joined("b");
    assert.equal(usage.admit("c", limits)?.code, "server_full", "one station cannot take the whole server");
    usage.delivered("a", 600);
    now += 30_000;
    left1();
    const october = usage.thisMonth("a");
    assert.equal(october.bytes, 600);
    assert.equal(october.peakListeners, 2);
    assert.equal(Math.round(october.listenerSeconds), 30);
    usage.delivered("a", 500);
    const refused = usage.admit("a", { ...limits, stationListeners: 10, totalListeners: 10 });
    assert.equal(refused?.code, "allowance_exhausted");
    assert.equal(refused?.status, 429);
    assert.ok((refused?.retryAfter ?? 0) > 0 && (refused?.retryAfter ?? 0) <= 30, "until the month turns");
    // A new month is a new allowance.
    now = Date.UTC(2026, 10, 1, 0, 1, 0);
    assert.equal(monthOf(now), "2026-11");
    assert.equal(usage.admit("a", { ...limits, stationListeners: 10, totalListeners: 10 }), null);
    usage.flush();
    const reread = new StationUsage(StationUsage.fileFor(dir, 1), () => now);
    assert.equal(reread.history("a")["2026-10"]?.bytes, 1100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("alerts say what an owner should know", () => {
  const limits = { stationListeners: 1, totalListeners: 1, runningStations: 1, monthlyBytes: 100 };
  const now = 1_000_000_000;
  const alerts = alertsFor({ desired: "running", failures: { "/a.mp3": 3, "/b.mp3": 1 } }, "offline", now - 5 * 60_000, { bytes: 95, listenerSeconds: 0, peakListeners: 0, restarts: 6, failures: 0 }, limits, now);
  assert.deepEqual(alerts, [
    "Off the air for 5 minutes while it should be running.",
    "1 file is left out because it would not play.",
    "Restarted 6 times this month: something keeps stopping it.",
    "95% of this month's delivery allowance is used.",
  ]);
  assert.deepEqual(alertsFor({ desired: "stopped", failures: {} }, "stopped", 0, { bytes: 0, listenerSeconds: 0, peakListeners: 0, restarts: 0, failures: 0 }, limits, now), []);
});
