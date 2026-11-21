import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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

describe("Google Drive Sync Plugin (Primary Seam)", () => {
  let now: number;
  let vault: InMemoryVaultPort;
  let http: FakeGoogleDriveHttp;
  let notices: CapturedNoticeSink;
  let plugin: SyncPluginCore;

  beforeEach(async () => {
    now = 1_700_000_000_000;
    const clock = { now: () => now };
    vault = new InMemoryVaultPort(clock.now);
    http = new FakeGoogleDriveHttp(clock.now);
    notices = new CapturedNoticeSink();
    plugin = new SyncPluginCore({ vault, http, notice: notices, clock });
    await plugin.load();
  });

  afterEach(() => {
    plugin.unload();
  });

  describe("Settings configuration bundle import & validation", () => {
    it("accepts a valid JSON config bundle, persists credentials in private plugin data, and exposes read-only connection info", async () => {
      const bundle = makeBundle({ clientId: "1234567890-abcdef.apps.googleusercontent.com" });
      http.validClientId = bundle.clientId;

      await plugin.importConfigBundle(JSON.stringify(bundle));

      const info = plugin.getConnectionInfo();
      expect(info.connected).toBe(true);
      expect(info.rootFolderName).toBe("gd-sb-chachin");
      expect(info.rootFolderId).toBe("root-folder-1");
      expect(info.credentialStatus).toBe("connected");
      expect(info.maskedClientId).toBe("1234...com");

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.credentials?.clientId).toBe(bundle.clientId);
      expect(persisted.credentials?.clientSecret).toBe(bundle.clientSecret);
      expect(persisted.credentials?.refreshToken).toBe(bundle.refreshToken);
      expect(persisted.credentials?.rootFolderId).toBe("root-folder-1");
      expect(persisted.credentials?.rootFolderName).toBe("gd-sb-chachin");
    });

    it("accepts a base64-encoded config bundle", async () => {
      const bundle = makeBundle();
      const bytes = new TextEncoder().encode(JSON.stringify(bundle));
      const base64 = btoa(String.fromCharCode(...bytes));

      await plugin.importConfigBundle(base64);

      const info = plugin.getConnectionInfo();
      expect(info.connected).toBe(true);
      expect(info.rootFolderId).toBe("root-folder-1");
    });

    it("rejects invalid or incomplete config bundles with a clear validation message and does not overwrite existing data", async () => {
      await expect(plugin.importConfigBundle("not valid json or base64!!!")).rejects.toThrow(
        /invalid configuration bundle/i,
      );

      await expect(
        plugin.importConfigBundle(JSON.stringify({ clientId: "abc", rootFolderId: "" })),
      ).rejects.toThrow(/missing or empty required fields/i);

      expect(plugin.getConnectionInfo().connected).toBe(false);
      expect(await vault.loadPluginData()).toBeNull();
    });

    it("disconnects cleanly, clearing credentials and sync metadata from private plugin data", async () => {
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      expect(plugin.getConnectionInfo().connected).toBe(true);

      await plugin.disconnect();

      expect(plugin.getConnectionInfo()).toEqual({
        connected: false,
        rootFolderName: null,
        rootFolderId: null,
        maskedClientId: null,
        credentialStatus: "disconnected",
      });
      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.credentials).toBeNull();
      expect(persisted.syncIndex).toEqual({});
      expect(persisted.startPageToken).toBeNull();
    });
  });

  describe("OAuth token refresh & 401 retry", () => {
    it("proactively refreshes expired access tokens before calling Drive API and persists the new token", async () => {
      http.seedFile({
        id: "file-1",
        name: "Hello.md",
        parentId: "root-folder-1",
        content: "# Hello",
      });

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      expect(http.tokenRefreshCount).toBe(1);
      expect(vault.readTextSync("Hello.md")).toBe("# Hello");

      // Advance clock past 1-hour token expiry
      now += 3_700_000;
      http.seedFile({
        id: "file-2",
        name: "Later.md",
        parentId: "root-folder-1",
        content: "# Later",
      });

      await plugin.initialPull();
      expect(http.tokenRefreshCount).toBe(2);
      expect(vault.readTextSync("Later.md")).toBe("# Later");

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.credentials?.accessToken).toBe("access-token-2");
      expect(persisted.credentials?.expiresAt).toBeGreaterThan(now);
    });

    it("reactively refreshes and retries once on HTTP 401 without user intervention", async () => {
      http.seedFile({
        id: "file-1",
        name: "Retry.md",
        parentId: "root-folder-1",
        content: "retried ok",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      expect(http.tokenRefreshCount).toBe(1);

      // Simulate server rejecting the cached access token with 401
      http.forceNextDrive401 = true;
      await plugin.initialPull();

      expect(http.tokenRefreshCount).toBe(2);
      expect(vault.readTextSync("Retry.md")).toBe("retried ok");
    });

    it("surfaces a persistent Notice on terminal invalid_grant refresh failure", async () => {
      http.revokedRefreshToken = true;

      await expect(plugin.importConfigBundle(JSON.stringify(makeBundle()))).rejects.toThrow(
        /invalid_grant|revoked|auth/i,
      );

      expect(notices.notices.some((n) => n.durationMs === 0)).toBe(true);
    });
  });

  describe("Initial pull, Unicode paths, binary preservation, exclusions & Sync Index", () => {
    it("pulls nested Unicode folders, markdown notes, and exact binary attachments, and persists Sync Index + startPageToken in private plugin data", async () => {
      const binaryPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      http.setStartPageToken("4242");

      http.seedFolder("folder-areas", "02 - Áreas", "root-folder-1", "2026-02-01T10:00:00.000Z");
      http.seedFolder("folder-sub", "Salud & Nutrición", "folder-areas", "2026-02-01T10:05:00.000Z");
      http.seedFile({
        id: "note-root",
        name: "Index.md",
        parentId: "root-folder-1",
        content: "# Vault Root\nWelcome!",
        md5Checksum: "abc123",
        modifiedTime: "2026-02-02T12:00:00.000Z",
      });
      http.seedFile({
        id: "note-nested",
        name: "Planificación.md",
        parentId: "folder-sub",
        content: "# Planificación\n- Día 1: café",
        md5Checksum: "def456",
        modifiedTime: "2026-02-03T15:30:00.000Z",
      });
      http.seedFile({
        id: "img-1",
        name: "diagram.png",
        parentId: "folder-areas",
        mimeType: "image/png",
        content: binaryPng,
        md5Checksum: "png999",
        modifiedTime: "2026-02-04T08:00:00.000Z",
      });

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));

      // Verify local vault files and exact binary content
      expect(vault.listAllFilePaths()).toEqual([
        "02 - Áreas/Salud & Nutrición/Planificación.md",
        "02 - Áreas/diagram.png",
        "Index.md",
      ]);
      expect(vault.readTextSync("Index.md")).toBe("# Vault Root\nWelcome!");
      expect(vault.readTextSync("02 - Áreas/Salud & Nutrición/Planificación.md")).toBe(
        "# Planificación\n- Día 1: café",
      );
      expect(vault.readBytesSync("02 - Áreas/diagram.png")).toEqual(binaryPng);

      // Verify Sync Index and startPageToken are persisted in private plugin data (not in vault files)
      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.startPageToken).toBe("4242");
      expect(persisted.syncIndex["Index.md"]).toEqual({
        path: "Index.md",
        driveId: "note-root",
        parentId: "root-folder-1",
        md5Checksum: "abc123",
        localMtime: now,
        remoteModifiedTime: "2026-02-02T12:00:00.000Z",
        type: "file",
      });
      expect(persisted.syncIndex["02 - Áreas"]).toEqual({
        path: "02 - Áreas",
        driveId: "folder-areas",
        parentId: "root-folder-1",
        md5Checksum: null,
        localMtime: 0,
        remoteModifiedTime: "2026-02-01T10:00:00.000Z",
        type: "folder",
      });
      expect(persisted.syncIndex["02 - Áreas/diagram.png"]).toEqual({
        path: "02 - Áreas/diagram.png",
        driveId: "img-1",
        parentId: "folder-areas",
        md5Checksum: "png999",
        localMtime: now,
        remoteModifiedTime: "2026-02-04T08:00:00.000Z",
        type: "file",
      });

      // Verify a fresh plugin instance loading from persisted plugin data retains connection info
      const reloaded = new SyncPluginCore({ vault, http, notice: notices });
      await reloaded.load();
      expect(reloaded.getConnectionInfo().connected).toBe(true);
      expect(reloaded.getConnectionInfo().rootFolderName).toBe("gd-sb-chachin");
    });

    it("excludes .obsidian/, .trash/, .DS_Store (root & nested), trashed items, and Google Workspace native files", async () => {
      http.seedFolder("obs-dir", ".obsidian", "root-folder-1");
      http.seedFile({
        id: "obs-cfg",
        name: "app.json",
        parentId: "obs-dir",
        content: "{}",
      });
      http.seedFolder("trash-dir", ".trash", "root-folder-1");
      http.seedFile({
        id: "trash-note",
        name: "deleted.md",
        parentId: "trash-dir",
        content: "old",
      });
      http.seedFile({
        id: "ds-root",
        name: ".DS_Store",
        parentId: "root-folder-1",
        content: "junk",
      });
      http.seedFolder("notes-dir", "Notes", "root-folder-1");
      http.seedFile({
        id: "ds-nested",
        name: ".DS_Store",
        parentId: "notes-dir",
        content: "junk",
      });
      http.seedFile({
        id: "gdoc-1",
        name: "Meeting Notes",
        parentId: "notes-dir",
        mimeType: "application/vnd.google-apps.document",
      });
      http.seedFile({
        id: "gsheet-1",
        name: "Budget",
        parentId: "root-folder-1",
        mimeType: "application/vnd.google-apps.spreadsheet",
      });
      http.seedFile({
        id: "trashed-1",
        name: "Trashed.md",
        parentId: "root-folder-1",
        content: "nope",
        trashed: true,
      });
      http.seedFile({
        id: "valid-1",
        name: "Valid.md",
        parentId: "notes-dir",
        content: "keep me",
      });

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));

      expect(vault.listAllFilePaths()).toEqual(["Notes/Valid.md"]);
      expect(vault.listAllFolderPaths()).toEqual(["Notes"]);

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(Object.keys(persisted.syncIndex).sort()).toEqual(["Notes", "Notes/Valid.md"]);
    });

    it("handles paginated Drive files.list responses across multiple pages", async () => {
      http.defaultPageSize = 2;
      for (let i = 1; i <= 5; i++) {
        http.seedFile({
          id: `f-${i}`,
          name: `Note-${i}.md`,
          parentId: "root-folder-1",
          content: `content ${i}`,
        });
      }

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));

      expect(vault.listAllFilePaths()).toEqual([
        "Note-1.md",
        "Note-2.md",
        "Note-3.md",
        "Note-4.md",
        "Note-5.md",
      ]);
    });
  });

  describe("Delta pull on cold start, foreground resume & 30-second polling", () => {
    it("pulls remote creates, new folders, and edits via changes.list on cold start (load) and updates startPageToken + Sync Index", async () => {
      http.seedFile({
        id: "f-1",
        name: "Existing.md",
        parentId: "root-folder-1",
        content: "v1",
        md5Checksum: "md5-v1",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      const initialData = (await vault.loadPluginData()) as PluginData;
      const initialToken = initialData.startPageToken!;
      expect(vault.readTextSync("Existing.md")).toBe("v1");

      // Simulate app restart (cold start): create a fresh plugin instance against same vault & http
      http.seedFolder("dir-new", "02 - Áreas", "root-folder-1");
      http.seedFile({
        id: "f-2",
        name: "NewNote.md",
        parentId: "dir-new",
        content: "created while closed",
        md5Checksum: "md5-new-1",
      });
      http.seedFile({
        id: "f-1",
        name: "Existing.md",
        parentId: "root-folder-1",
        content: "v2 from macOS",
        md5Checksum: "md5-v2",
        modifiedTime: "2026-01-02T00:00:00.000Z",
      });

      const restartedPlugin = new SyncPluginCore({
        vault,
        http,
        notice: notices,
        clock: { now: () => now },
      });
      await restartedPlugin.load();

      expect(vault.readTextSync("Existing.md")).toBe("v2 from macOS");
      expect(vault.readTextSync("02 - Áreas/NewNote.md")).toBe("created while closed");

      const updatedData = (await vault.loadPluginData()) as PluginData;
      expect(updatedData.startPageToken).not.toBe(initialToken);
      expect(updatedData.syncIndex["Existing.md"]?.md5Checksum).toBe("md5-v2");
      expect(updatedData.syncIndex["02 - Áreas"]?.type).toBe("folder");
      expect(updatedData.syncIndex["02 - Áreas/NewNote.md"]?.driveId).toBe("f-2");
      restartedPlugin.unload();
    });

    it("polls every 30s while visible, pauses when hidden, and pulls immediately on visibilitychange: visible", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(now);
        await plugin.importConfigBundle(JSON.stringify(makeBundle()));

        // 1. Remote edit arrives; advance 30s -> pulled automatically
        http.seedFile({
          id: "f-poll-1",
          name: "Polled.md",
          parentId: "root-folder-1",
          content: "polled at 30s",
          md5Checksum: "md5-poll-1",
        });

        await vi.advanceTimersByTimeAsync(29_999);
        expect(await vault.exists("Polled.md")).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(vault.readTextSync("Polled.md")).toBe("polled at 30s");

        // 2. App becomes hidden -> polling pauses
        await plugin.handleVisibilityChange(false);
        http.seedFile({
          id: "f-poll-2",
          name: "WhileHidden.md",
          parentId: "root-folder-1",
          content: "should wait until visible",
          md5Checksum: "md5-poll-2",
        });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(await vault.exists("WhileHidden.md")).toBe(false);

        // 3. App returns to foreground (visible) -> immediate pull + resumes 30s polling
        await plugin.handleVisibilityChange(true);
        expect(vault.readTextSync("WhileHidden.md")).toBe("should wait until visible");

        http.seedFile({
          id: "f-poll-3",
          name: "ResumedPoll.md",
          parentId: "root-folder-1",
          content: "polled after resume",
          md5Checksum: "md5-poll-3",
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(vault.readTextSync("ResumedPoll.md")).toBe("polled after resume");
      } finally {
        plugin.unload();
        vi.useRealTimers();
      }
    });

    it("skips changes outside root subtree, ignored paths, Google Workspace native files, and unchanged MD5 files", async () => {
      http.seedFile({
        id: "f-keep",
        name: "Keep.md",
        parentId: "root-folder-1",
        content: "unchanged body",
        md5Checksum: "md5-same",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      http.downloadedFileIds = [];

      // Seed changes outside root subtree, ignored paths, native Docs, and metadata-only touch (same MD5)
      http.seedFolder("other-root", "OtherFolder", "my-drive-root");
      http.seedFile({
        id: "outside-1",
        name: "Secret.md",
        parentId: "other-root",
        content: "outside",
      });
      http.seedFolder("obs-dir", ".obsidian", "root-folder-1");
      http.seedFile({
        id: "obs-1",
        name: "app.json",
        parentId: "obs-dir",
        content: "{}",
      });
      http.seedFile({
        id: "ds-1",
        name: ".DS_Store",
        parentId: "root-folder-1",
        content: "junk",
      });
      http.seedFolder("trash-dir", ".trash", "root-folder-1");
      http.seedFile({
        id: "trash-1",
        name: "Deleted.md",
        parentId: "trash-dir",
        content: "trashed",
      });
      http.seedFile({
        id: "gdoc-1",
        name: "Roadmap",
        parentId: "root-folder-1",
        mimeType: "application/vnd.google-apps.document",
      });
      // Metadata-only update with identical MD5
      http.seedFile({
        id: "f-keep",
        name: "Keep.md",
        parentId: "root-folder-1",
        content: "unchanged body",
        md5Checksum: "md5-same",
        modifiedTime: "2026-01-03T00:00:00.000Z",
      });

      await plugin.pullDelta();

      expect(vault.listAllFilePaths()).toEqual(["Keep.md"]);
      expect(vault.listAllFolderPaths()).toEqual([]);
      expect(http.downloadedFileIds).toEqual([]);
      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.syncIndex["Keep.md"]?.remoteModifiedTime).toBe("2026-01-03T00:00:00.000Z");
    });

    it("handles remote file/folder renames and moves within, into, and out of synced root subtree without orphaned duplicates", async () => {
      http.seedFolder("dir-a", "FolderA", "root-folder-1");
      http.seedFolder("dir-b", "FolderB", "root-folder-1");
      http.seedFile({
        id: "f-a1",
        name: "Alpha.md",
        parentId: "dir-a",
        content: "alpha body",
        md5Checksum: "md5-alpha",
      });
      http.seedFile({
        id: "f-move-out",
        name: "LeaveRoot.md",
        parentId: "root-folder-1",
        content: "leaving",
        md5Checksum: "md5-leave",
      });
      // External folder outside root-folder-1 with an existing child
      http.seedFolder("ext-dir", "ImportedProject", "my-drive-root");
      http.seedFile({
        id: "ext-file",
        name: "Spec.md",
        parentId: "ext-dir",
        content: "external spec",
        md5Checksum: "md5-ext",
      });

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      http.downloadedFileIds = [];

      // 1. Rename FolderA -> FolderA-Renamed (moves Alpha.md with it)
      http.renameOrMoveItem("dir-a", { name: "FolderA-Renamed" });
      // 2. Move Alpha.md into FolderB and rename to AlphaMoved.md (same content/MD5)
      http.renameOrMoveItem("f-a1", { name: "AlphaMoved.md", parentId: "dir-b" });
      // 3. Move external folder ImportedProject INTO root-folder-1
      http.renameOrMoveItem("ext-dir", { parentId: "root-folder-1" });
      // 4. Move LeaveRoot.md OUT of root-folder-1 into my-drive-root
      http.renameOrMoveItem("f-move-out", { parentId: "my-drive-root" });

      await plugin.pullDelta();

      expect(vault.listAllFilePaths()).toEqual([
        "FolderB/AlphaMoved.md",
        "ImportedProject/Spec.md",
      ]);
      expect(vault.readTextSync("FolderB/AlphaMoved.md")).toBe("alpha body");
      expect(vault.readTextSync("ImportedProject/Spec.md")).toBe("external spec");
      // AlphaMoved.md had same MD5, so only ext-file should have been downloaded
      expect(http.downloadedFileIds).toEqual(["ext-file"]);

      expect(vault.listAllFolderPaths()).toEqual([
        "FolderA-Renamed",
        "FolderB",
        "ImportedProject",
      ]);

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(Object.keys(persisted.syncIndex).sort()).toEqual([
        "FolderA-Renamed",
        "FolderB",
        "FolderB/AlphaMoved.md",
        "ImportedProject",
        "ImportedProject/Spec.md",
      ]);
      expect(persisted.syncIndex["FolderA"]).toBeUndefined();
      expect(persisted.syncIndex["FolderA/Alpha.md"]).toBeUndefined();
      expect(persisted.syncIndex["LeaveRoot.md"]).toBeUndefined();
    });

    it("falls back to full Drive subtree reconciliation when startPageToken is expired (HTTP 410) and persists a fresh token", async () => {
      http.seedFile({
        id: "f-1",
        name: "Keep.md",
        parentId: "root-folder-1",
        content: "v1",
        md5Checksum: "md5-1",
      });
      http.seedFile({
        id: "f-stale",
        name: "MovedOutWhileExpired.md",
        parentId: "root-folder-1",
        content: "stale",
        md5Checksum: "md5-stale",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      const oldData = (await vault.loadPluginData()) as PluginData;
      const expiredToken = oldData.startPageToken!;

      // Expire the stored token and mutate Drive state
      http.expirePageToken(expiredToken);
      http.renameOrMoveItem("f-stale", { parentId: "other-root" });
      http.seedFile({
        id: "f-new",
        name: "Recovered.md",
        parentId: "root-folder-1",
        content: "recovered after 410",
        md5Checksum: "md5-rec",
      });
      http.setStartPageToken("9999");

      await plugin.pullDelta();

      expect(vault.listAllFilePaths()).toEqual(["Keep.md", "Recovered.md"]);
      expect(vault.readTextSync("Recovered.md")).toBe("recovered after 410");
      const freshData = (await vault.loadPluginData()) as PluginData;
      expect(freshData.startPageToken).toBe("9999");
      expect(freshData.syncIndex["MovedOutWhileExpired.md"]).toBeUndefined();
      expect(freshData.syncIndex["Recovered.md"]?.driveId).toBe("f-new");
    });

    it("suppresses push echo loops on pulled writes and renames and issues zero Drive write requests", async () => {
      http.seedFile({
        id: "f-echo",
        name: "Original.md",
        parentId: "root-folder-1",
        content: "v1",
        md5Checksum: "md5-1",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      http.driveRequests = [];

      http.renameOrMoveItem("f-echo", { name: "Renamed.md" });
      http.seedFile({
        id: "f-echo-new",
        name: "PulledWrite.md",
        parentId: "root-folder-1",
        content: "from drive",
        md5Checksum: "md5-2",
      });

      await plugin.pullDelta();

      // Zero non-GET (upload/mutation) requests to Drive
      expect(http.driveRequests.filter((r) => r.method !== "GET")).toEqual([]);

      // Pulled/renamed paths are echo-suppressed; unrelated paths are not
      expect(plugin.isEchoSuppressed("PulledWrite.md")).toBe(true);
      expect(plugin.isEchoSuppressed("Original.md")).toBe(true);
      expect(plugin.isEchoSuppressed("Renamed.md")).toBe(true);
      expect(plugin.isEchoSuppressed("UnrelatedLocalEdit.md")).toBe(false);

      // Suppression expires after the echo window
      now += 5_000;
      expect(plugin.isEchoSuppressed("PulledWrite.md")).toBe(false);
    });
  });
});
