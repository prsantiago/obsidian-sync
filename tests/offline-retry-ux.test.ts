import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncPluginCore } from "../src/sync-plugin-core";
import { InMemoryVaultPort } from "./fakes/in-memory-vault";
import { FakeGoogleDriveHttp } from "./fakes/fake-drive-http";
import { CapturedNoticeSink } from "./fakes/notice-sink";
import type { ConfigBundle, PluginData } from "../src/types";

function makeBundle(overrides: Partial<ConfigBundle> = {}): ConfigBundle {
  return {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
    rootFolderId: "root-folder-1",
    rootFolderName: "gd-sb-chachin",
    ...overrides,
  };
}

describe("Offline queueing, reconnect auto-sync, retries & error UX (Ticket #8)", () => {
  let now: number;
  let online: boolean;
  let vault: InMemoryVaultPort;
  let http: FakeGoogleDriveHttp;
  let notices: CapturedNoticeSink;
  let plugin: SyncPluginCore;

  beforeEach(async () => {
    vi.useFakeTimers();
    now = 1_700_000_000_000;
    online = true;
    const clock = { now: () => now };
    vault = new InMemoryVaultPort(clock.now);
    http = new FakeGoogleDriveHttp(clock.now);
    notices = new CapturedNoticeSink();
    plugin = new SyncPluginCore({
      vault,
      http,
      notice: notices,
      clock,
      isOnline: () => online,
    });
    await plugin.load();
  });

  afterEach(() => {
    plugin.unload();
    vi.useRealTimers();
  });

  it("persists offline mutations (including deletions) across app restart, emits zero notices, and auto-syncs on online reconnect", async () => {
    http.seedFile({
      id: "to-delete-1",
      name: "DeleteMeOffline.md",
      parentId: "root-folder-1",
      content: "will be deleted offline",
    });
    await plugin.importConfigBundle(JSON.stringify(makeBundle()));
    expect(await vault.exists("DeleteMeOffline.md")).toBe(true);
    const requestsBeforeOffline = http.driveRequests.length;

    // Go offline and perform local mutations (create, rename, and delete)
    online = false;
    await vault.writeBinary("OfflineNote.md", new TextEncoder().encode("written offline").buffer);
    plugin.onVaultCreate("OfflineNote.md", "file");

    await vault.writeBinary("Draft.md", new TextEncoder().encode("v1").buffer);
    plugin.onVaultCreate("Draft.md", "file");
    await vault.rename("Draft.md", "RenamedOffline.md");
    plugin.onVaultRename("Draft.md", "RenamedOffline.md", "file");

    await vault.remove("DeleteMeOffline.md");
    plugin.onVaultDelete("DeleteMeOffline.md");

    await vi.advanceTimersByTimeAsync(1000);

    // Zero network calls, zero notices, zero errors while offline
    expect(http.driveRequests.length).toBe(requestsBeforeOffline);
    expect(notices.notices).toHaveLength(0);
    expect(plugin.getErrorLog()).toEqual([]);

    const persistedOffline = (await vault.loadPluginData()) as PluginData;
    expect(persistedOffline.pendingQueue?.deletes).toContain("DeleteMeOffline.md");

    // Simulate iOS app restart while still offline
    plugin.unload();
    const restarted = new SyncPluginCore({
      vault,
      http,
      notice: notices,
      clock: { now: () => now },
      isOnline: () => online,
    });
    await restarted.load();
    expect(http.driveRequests.length).toBe(requestsBeforeOffline);
    expect(notices.notices).toHaveLength(0);

    // Reconnect and fire online event
    online = true;
    await restarted.handleOnline();

    expect(http.findItemByName("OfflineNote.md", "root-folder-1")).toBeDefined();
    expect(http.findItemByName("RenamedOffline.md", "root-folder-1")).toBeDefined();
    expect(http.getItem("to-delete-1")?.trashed).toBe(true);
    expect(await vault.exists("DeleteMeOffline.md")).toBe(false);
    expect(notices.notices).toHaveLength(0);
    expect(restarted.getErrorLog()).toEqual([]);

    const persisted = (await vault.loadPluginData()) as PluginData;
    expect(persisted.pendingQueue?.upserts ?? []).toHaveLength(0);
    expect(persisted.pendingQueue?.renames ?? []).toHaveLength(0);
    expect(persisted.pendingQueue?.deletes ?? []).toHaveLength(0);

    restarted.unload();
  });

  it("retries transient errors (network, 429, 5xx) silently with exponential backoff and succeeds with zero notices", async () => {
    await plugin.importConfigBundle(JSON.stringify(makeBundle()));

    await vault.writeBinary("Flaky.md", new TextEncoder().encode("retry me").buffer);
    plugin.onVaultCreate("Flaky.md", "file");

    const origRequest = http.request.bind(http);
    let uploadAttempts = 0;
    const retryTimestamps: number[] = [];
    const spy = vi.spyOn(http, "request").mockImplementation(async (params) => {
      if (params.url.includes("/upload/drive/v3/files")) {
        uploadAttempts += 1;
        retryTimestamps.push(now);
        if (uploadAttempts === 1) {
          throw new Error("TypeError: Failed to fetch");
        }
        if (uploadAttempts === 2) {
          return {
            status: 429,
            headers: {},
            text: "Too Many Requests",
            json: { error: { message: "Rate Limit Exceeded" } },
            arrayBuffer: new ArrayBuffer(0),
          };
        }
        if (uploadAttempts === 3) {
          return {
            status: 503,
            headers: {},
            text: "Service Unavailable",
            json: { error: { message: "Backend Error" } },
            arrayBuffer: new ArrayBuffer(0),
          };
        }
      }
      return origRequest(params);
    });

    // Advance past 500ms debounce, then advance through exponential backoff (1s + 2s + 4s)
    const advancePromise = (async () => {
      await vi.advanceTimersByTimeAsync(500);
      expect(uploadAttempts).toBe(1);
      expect(notices.notices).toHaveLength(0);

      now += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(uploadAttempts).toBe(2);
      expect(notices.notices).toHaveLength(0);

      now += 2000;
      await vi.advanceTimersByTimeAsync(2000);
      expect(uploadAttempts).toBe(3);
      expect(notices.notices).toHaveLength(0);

      now += 4000;
      await vi.advanceTimersByTimeAsync(4000);
    })();

    await advancePromise;
    spy.mockRestore();

    expect(uploadAttempts).toBe(4);
    expect(http.findItemByName("Flaky.md", "root-folder-1")).toBeDefined();
    expect(notices.notices).toHaveLength(0);
    expect(plugin.getErrorLog()).toEqual([]);
  });

  it("emits an ~8s Notice and appends a timestamped entry to the Sync Error Log after exhausting retries, keeping items queued", async () => {
    await plugin.importConfigBundle(JSON.stringify(makeBundle()));

    await vault.writeBinary("StillQueued.md", new TextEncoder().encode("keep me").buffer);
    plugin.onVaultCreate("StillQueued.md", "file");

    const origRequest = http.request.bind(http);
    let uploadAttempts = 0;
    const spy = vi.spyOn(http, "request").mockImplementation(async (params) => {
      if (params.url.includes("/upload/drive/v3/files")) {
        uploadAttempts += 1;
        return {
          status: 500,
          headers: {},
          text: "Internal Server Error",
          json: { error: { message: "Server down" } },
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      return origRequest(params);
    });

    const syncPromise = plugin.syncNow();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await syncPromise;
    spy.mockRestore();

    expect(uploadAttempts).toBe(4);
    expect(notices.notices).toHaveLength(1);
    expect(notices.notices[0].durationMs).toBe(8000);
    expect(notices.notices[0].message).toMatch(/sync failed/i);

    const log = plugin.getErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].timestamp).toBe(now);
    expect(log[0].message).toMatch(/500|Server down/i);

    const persisted = (await vault.loadPluginData()) as PluginData;
    expect(persisted.pendingQueue?.upserts.map((u) => u.path)).toContain("StillQueued.md");
  });

  it("stops retry loops & polling on terminal invalid_grant, emits a persistent Notice (duration=0), and logs the error", async () => {
    await plugin.importConfigBundle(JSON.stringify(makeBundle()));

    let tokenRequests = 0;
    const origRequest = http.request.bind(http);
    const spy = vi.spyOn(http, "request").mockImplementation(async (params) => {
      if (params.url.includes("oauth2.googleapis.com/token")) {
        tokenRequests += 1;
      }
      return origRequest(params);
    });

    // Expire token and revoke refresh token on the server
    now += 2 * 60 * 60 * 1000;
    http.revokedRefreshToken = true;

    await plugin.pullDelta();

    // Should NOT retry (only 1 token refresh attempt)
    expect(tokenRequests).toBe(1);

    // Exactly one persistent Notice (durationMs === 0)
    expect(notices.notices).toHaveLength(1);
    expect(notices.notices[0].durationMs).toBe(0);
    expect(notices.notices[0].message).toMatch(/invalid_grant|revoked|auth/i);

    // Logged in Sync Error Log
    const log = plugin.getErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].code).toBe("invalid_grant");
    expect(log[0].message).toMatch(/invalid_grant/i);

    // Subsequent polling ticks or sync triggers do not keep hammering Drive while halted
    await vi.advanceTimersByTimeAsync(60_000);
    await plugin.pullDelta();
    expect(tokenRequests).toBe(1);

    spy.mockRestore();
  });

  it("bounds the Sync Error Log to the last 50 entries and supports clearErrorLog()", async () => {
    await plugin.importConfigBundle(JSON.stringify(makeBundle()));

    const origRequest = http.request.bind(http);
    let failCount = 0;
    const spy = vi.spyOn(http, "request").mockImplementation(async (params) => {
      if (params.url.includes("/changes")) {
        failCount += 1;
        return {
          status: 403,
          headers: {},
          text: `Forbidden #${failCount}`,
          json: { error: { message: `Forbidden #${failCount}` } },
          arrayBuffer: new ArrayBuffer(0),
        };
      }
      return origRequest(params);
    });

    for (let i = 1; i <= 55; i += 1) {
      now += 1000;
      await plugin.pullDelta();
    }
    spy.mockRestore();

    const log = plugin.getErrorLog();
    expect(log).toHaveLength(50);
    expect(log[0].message).toContain("Forbidden #6");
    expect(log[49].message).toContain("Forbidden #55");

    await plugin.clearErrorLog();
    expect(plugin.getErrorLog()).toEqual([]);

    const persisted = (await vault.loadPluginData()) as PluginData;
    expect(persisted.errorLog).toEqual([]);
  });
});
