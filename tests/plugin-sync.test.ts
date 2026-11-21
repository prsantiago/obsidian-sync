import { describe, expect, it, beforeEach } from "vitest";
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
});
