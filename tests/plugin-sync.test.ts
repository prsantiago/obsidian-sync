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

  describe("Automatic near-instant push & app-switch flush", () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
    });

    afterEach(() => {
      plugin.dispose();
      vi.useRealTimers();
    });

    it("pushes a newly created markdown note to Google Drive ~500ms after the vault create event and updates Sync Index", async () => {
      await vault.writeBinary("Daily.md", new TextEncoder().encode("# Hello Drive").buffer);
      plugin.onVaultCreate("Daily.md", "file");

      // Before 500ms, it has not been uploaded yet
      await vi.advanceTimersByTimeAsync(400);
      expect(http.findItemByName("Daily.md", "root-folder-1")).toBeUndefined();

      // At 500ms, debounce fires and uploads via multipart
      await vi.advanceTimersByTimeAsync(100);
      const remote = http.findItemByName("Daily.md", "root-folder-1");
      expect(remote).toBeDefined();
      expect(new TextDecoder().decode(remote!.content)).toBe("# Hello Drive");
      expect(http.multipartUploadCount).toBe(1);

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.syncIndex["Daily.md"]).toMatchObject({
        path: "Daily.md",
        driveId: remote!.id,
        parentId: "root-folder-1",
        md5Checksum: remote!.md5Checksum,
        remoteModifiedTime: remote!.modifiedTime,
        type: "file",
      });
    });

    it("coalesces rapid consecutive edits within the 500ms debounce window into a single upload", async () => {
      http.seedFile({
        id: "existing-note",
        name: "Journal.md",
        parentId: "root-folder-1",
        content: "v0",
      });
      // Re-run initial pull to track Journal.md
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));

      await vault.writeBinary("Journal.md", new TextEncoder().encode("v1").buffer);
      plugin.onVaultModify("Journal.md");
      await vi.advanceTimersByTimeAsync(250);

      await vault.writeBinary("Journal.md", new TextEncoder().encode("v2").buffer);
      plugin.onVaultModify("Journal.md");
      await vi.advanceTimersByTimeAsync(250);

      // Still hasn't fired because second edit reset the 500ms timer
      expect(http.multipartUploadCount).toBe(0);

      await vault.writeBinary("Journal.md", new TextEncoder().encode("v3-final").buffer);
      plugin.onVaultModify("Journal.md");
      await vi.advanceTimersByTimeAsync(500);

      expect(http.multipartUploadCount).toBe(1);
      const remote = http.getItem("existing-note");
      expect(new TextDecoder().decode(remote!.content)).toBe("v3-final");
    });

    it("creates nested Drive folders on demand and uploads binary attachments byte-for-byte", async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      await vault.mkdir("Projects/2026/Assets");
      plugin.onVaultCreate("Projects", "folder");
      plugin.onVaultCreate("Projects/2026", "folder");
      plugin.onVaultCreate("Projects/2026/Assets", "folder");
      await vault.writeBinary("Projects/2026/Assets/diagram.png", pngBytes.buffer);
      plugin.onVaultCreate("Projects/2026/Assets/diagram.png", "file");

      await vi.advanceTimersByTimeAsync(500);

      const projectsFolder = http.findItemByName("Projects", "root-folder-1");
      expect(projectsFolder).toBeDefined();
      const yearFolder = http.findItemByName("2026", projectsFolder!.id);
      expect(yearFolder).toBeDefined();
      const assetsFolder = http.findItemByName("Assets", yearFolder!.id);
      expect(assetsFolder).toBeDefined();
      const remotePng = http.findItemByName("diagram.png", assetsFolder!.id);
      expect(remotePng).toBeDefined();
      expect(remotePng!.content).toEqual(pngBytes);

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.syncIndex["Projects/2026/Assets"]?.driveId).toBe(assetsFolder!.id);
      expect(persisted.syncIndex["Projects/2026/Assets/diagram.png"]?.parentId).toBe(
        assetsFolder!.id,
      );
    });

    it("uses multipart upload for files <= 5 MB and resumable upload for files > 5 MB with byte-for-byte fidelity", async () => {
      const fiveMb = 5 * 1024 * 1024;
      const exact5Mb = new Uint8Array(fiveMb);
      exact5Mb[0] = 0x11;
      exact5Mb[fiveMb - 1] = 0x22;

      const over5Mb = new Uint8Array(fiveMb + 1);
      over5Mb[0] = 0xaa;
      over5Mb[fiveMb] = 0xbb;

      await vault.writeBinary("exact-5mb.bin", exact5Mb.buffer);
      plugin.onVaultCreate("exact-5mb.bin", "file");
      await vi.advanceTimersByTimeAsync(500);

      expect(http.multipartUploadCount).toBe(1);
      expect(http.resumableUploadCount).toBe(0);
      const remoteExact = http.findItemByName("exact-5mb.bin", "root-folder-1");
      expect(remoteExact!.content!.byteLength).toBe(fiveMb);
      expect(remoteExact!.content![0]).toBe(0x11);
      expect(remoteExact!.content![fiveMb - 1]).toBe(0x22);

      await vault.writeBinary("large-video.bin", over5Mb.buffer);
      plugin.onVaultCreate("large-video.bin", "file");
      await vi.advanceTimersByTimeAsync(500);

      expect(http.multipartUploadCount).toBe(1);
      expect(http.resumableUploadCount).toBe(1);
      const remoteLarge = http.findItemByName("large-video.bin", "root-folder-1");
      expect(remoteLarge!.content!.byteLength).toBe(fiveMb + 1);
      expect(remoteLarge!.content![0]).toBe(0xaa);
      expect(remoteLarge!.content![fiveMb]).toBe(0xbb);
    });

    it("renames and moves files and folders on Drive without leaving duplicate ghost files", async () => {
      http.seedFolder("dir-a", "Inbox", "root-folder-1");
      http.seedFolder("dir-b", "Archive", "root-folder-1");
      http.seedFile({
        id: "note-1",
        name: "Draft.md",
        parentId: "dir-a",
        content: "hello",
      });
      await plugin.importConfigBundle(JSON.stringify(makeBundle()));

      // Move and rename Draft.md -> Archive/Published.md
      vault.simulateRename("Inbox/Draft.md", "Archive/Published.md");
      plugin.onVaultRename("Inbox/Draft.md", "Archive/Published.md", "file");
      await vi.advanceTimersByTimeAsync(500);

      const movedNote = http.getItem("note-1");
      expect(movedNote?.name).toBe("Published.md");
      expect(movedNote?.parents).toEqual(["dir-b"]);
      expect(http.findItemByName("Draft.md", "dir-a")).toBeUndefined();

      // Rename folder Archive -> Done (updating descendant Sync Index paths too)
      vault.simulateRename("Archive", "Done");
      plugin.onVaultRename("Archive", "Done", "folder");
      await vi.advanceTimersByTimeAsync(500);

      const renamedFolder = http.getItem("dir-b");
      expect(renamedFolder?.name).toBe("Done");
      expect(renamedFolder?.parents).toEqual(["root-folder-1"]);
      expect(http.listAllItems().filter((i) => i.name === "Published.md")).toHaveLength(1);

      const persisted = (await vault.loadPluginData()) as PluginData;
      expect(persisted.syncIndex["Inbox/Draft.md"]).toBeUndefined();
      expect(persisted.syncIndex["Archive"]).toBeUndefined();
      expect(persisted.syncIndex["Archive/Published.md"]).toBeUndefined();
      expect(persisted.syncIndex["Done"]?.driveId).toBe("dir-b");
      expect(persisted.syncIndex["Done/Published.md"]?.driveId).toBe("note-1");
    });

    it("cancels the debounce timer and immediately flushes pending changes on visibilitychange: hidden", async () => {
      await vault.writeBinary("QuickNote.md", new TextEncoder().encode("before lock").buffer);
      plugin.onVaultCreate("QuickNote.md", "file");

      // Only 50ms elapsed, timer hasn't fired
      await vi.advanceTimersByTimeAsync(50);
      expect(http.findItemByName("QuickNote.md", "root-folder-1")).toBeUndefined();

      // App switches away / screen locks -> immediate flush
      await plugin.onVisibilityHidden();
      expect(http.findItemByName("QuickNote.md", "root-folder-1")).toBeDefined();
      expect(http.multipartUploadCount).toBe(1);

      // Advancing past the original 500ms window does NOT trigger a duplicate upload
      await vi.advanceTimersByTimeAsync(500);
      expect(http.multipartUploadCount).toBe(1);
    });

    it("flushes pending changes immediately when syncNow() command is triggered", async () => {
      await vault.writeBinary("ManualSync.md", new TextEncoder().encode("sync me").buffer);
      plugin.onVaultCreate("ManualSync.md", "file");

      await plugin.syncNow();
      expect(http.findItemByName("ManualSync.md", "root-folder-1")).toBeDefined();
      expect(http.multipartUploadCount).toBe(1);

      await vi.advanceTimersByTimeAsync(500);
      expect(http.multipartUploadCount).toBe(1);
    });

    it("ignores local changes under .obsidian/, .trash/, and any .DS_Store", async () => {
      await vault.writeBinary(".obsidian/workspace.json", new TextEncoder().encode("{}").buffer);
      await vault.writeBinary(".trash/deleted.md", new TextEncoder().encode("trash").buffer);
      await vault.writeBinary(".DS_Store", new Uint8Array([1, 2, 3]).buffer);
      await vault.writeBinary("Notes/.DS_Store", new Uint8Array([4, 5, 6]).buffer);

      plugin.onVaultCreate(".obsidian/workspace.json", "file");
      plugin.onVaultModify(".obsidian/workspace.json");
      plugin.onVaultCreate(".trash/deleted.md", "file");
      plugin.onVaultCreate(".DS_Store", "file");
      plugin.onVaultCreate("Notes/.DS_Store", "file");

      await vi.advanceTimersByTimeAsync(500);
      expect(http.multipartUploadCount).toBe(0);
      expect(http.listAllItems()).toHaveLength(0);
    });

    it("serializes concurrent sync triggers via a single-flight lock with a follow-up pass", async () => {
      await vault.writeBinary("A.md", new TextEncoder().encode("first").buffer);
      plugin.onVaultCreate("A.md", "file");

      // Gate the first HTTP upload so we can trigger a concurrent sync while it is in flight
      let releaseFirstUpload!: () => void;
      const firstUploadGate = new Promise<void>((resolve) => {
        releaseFirstUpload = resolve;
      });
      let inFlightUploads = 0;
      let maxConcurrentUploads = 0;
      const origRequest = http.request.bind(http);
      const requestSpy = vi.spyOn(http, "request").mockImplementation(async (params) => {
        if (params.url.includes("/upload/drive/v3/files")) {
          inFlightUploads += 1;
          maxConcurrentUploads = Math.max(maxConcurrentUploads, inFlightUploads);
          if (http.multipartUploadCount === 0) {
            await firstUploadGate;
          }
          try {
            return await origRequest(params);
          } finally {
            inFlightUploads -= 1;
          }
        }
        return origRequest(params);
      });

      const firstSync = plugin.syncNow();
      // Yield microtasks so firstSync reaches the upload gate
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Queue another local change and trigger a concurrent syncNow while firstSync is in flight
      await vault.writeBinary("B.md", new TextEncoder().encode("second").buffer);
      plugin.onVaultCreate("B.md", "file");
      const secondSync = plugin.syncNow();

      // Release the first upload and await both sync calls
      releaseFirstUpload();
      await Promise.all([firstSync, secondSync]);
      requestSpy.mockRestore();

      expect(maxConcurrentUploads).toBe(1);
      expect(http.findItemByName("A.md", "root-folder-1")).toBeDefined();
      expect(http.findItemByName("B.md", "root-folder-1")).toBeDefined();
    });

    it("suppresses echo pushes for plugin-initiated local writes during pull", async () => {
      http.seedFile({
        id: "remote-1",
        name: "FromMac.md",
        parentId: "root-folder-1",
        content: "mac content",
      });

      // Simulate Obsidian emitting vault create/modify events whenever writeBinary/mkdir runs
      const origWrite = vault.writeBinary.bind(vault);
      const writeSpy = vi.spyOn(vault, "writeBinary").mockImplementation(async (path, data) => {
        const st = await origWrite(path, data);
        plugin.onVaultCreate(path, "file");
        plugin.onVaultModify(path);
        return st;
      });

      await plugin.importConfigBundle(JSON.stringify(makeBundle()));
      writeSpy.mockRestore();

      await vi.advanceTimersByTimeAsync(1000);
      expect(http.multipartUploadCount).toBe(0);
    });
  });
});
