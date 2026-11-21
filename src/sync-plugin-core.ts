import { maskCredential, parseConfigBundle } from "./config-bundle";
import { GoogleDriveClient } from "./drive-client";
import { isExcludedPath, isGoogleWorkspaceNativeMime } from "./exclusions";
import { OAuthTokenManager } from "./oauth-manager";
import {
  GOOGLE_FOLDER_MIME,
  PUSH_DEBOUNCE_MS,
  type Clock,
  type ConnectionInfo,
  type HttpTransport,
  type NoticeSink,
  type OAuthCredentials,
  type PluginData,
  type SyncIndexEntry,
  type VaultPort,
} from "./types";

export interface SyncPluginCoreDeps {
  vault: VaultPort;
  http: HttpTransport;
  notice: NoticeSink;
  clock?: Clock;
}

function emptyPluginData(): PluginData {
  return {
    credentials: null,
    syncIndex: {},
    startPageToken: null,
  };
}

function normalizePluginData(raw: unknown): PluginData {
  if (typeof raw !== "object" || raw === null) {
    return emptyPluginData();
  }
  const rec = raw as Partial<PluginData>;
  return {
    credentials: rec.credentials ?? null,
    syncIndex: rec.syncIndex ?? {},
    startPageToken: rec.startPageToken ?? null,
  };
}

export class SyncPluginCore {
  private readonly vault: VaultPort;
  private readonly notice: NoticeSink;
  private readonly clock: Clock;
  private readonly auth: OAuthTokenManager;
  private readonly drive: GoogleDriveClient;
  private data: PluginData = emptyPluginData();
  private pendingUpserts = new Map<string, "file" | "folder">();
  private pendingRenames: Array<{ oldPath: string; newPath: string; type: "file" | "folder" }> = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressedPaths = new Set<string>();
  private activeSyncPromise: Promise<void> | null = null;
  private followUpRequested = false;

  constructor(deps: SyncPluginCoreDeps) {
    this.vault = deps.vault;
    this.notice = deps.notice;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.auth = new OAuthTokenManager({
      http: deps.http,
      notice: deps.notice,
      clock: this.clock,
      getCredentials: () => this.data.credentials,
      onTokenUpdated: async (updated: OAuthCredentials) => {
        this.data = { ...this.data, credentials: updated };
        await this.vault.savePluginData(this.data);
      },
    });
    this.drive = new GoogleDriveClient(this.auth);
  }

  async load(): Promise<void> {
    const raw = await this.vault.loadPluginData();
    this.data = normalizePluginData(raw);
  }

  getConnectionInfo(): ConnectionInfo {
    const creds = this.data.credentials;
    if (!creds) {
      return {
        connected: false,
        rootFolderName: null,
        rootFolderId: null,
        maskedClientId: null,
        credentialStatus: "disconnected",
      };
    }
    return {
      connected: true,
      rootFolderName: creds.rootFolderName,
      rootFolderId: creds.rootFolderId,
      maskedClientId: maskCredential(creds.clientId),
      credentialStatus: "connected",
    };
  }

  async importConfigBundle(rawBundle: string): Promise<void> {
    const bundle = parseConfigBundle(rawBundle);
    this.data = {
      credentials: { ...bundle },
      syncIndex: {},
      startPageToken: null,
    };
    await this.vault.savePluginData(this.data);
    await this.initialPull();
  }

  async disconnect(): Promise<void> {
    this.data = emptyPluginData();
    await this.vault.savePluginData(this.data);
  }

  /**
   * Performs an initial full pull of the configured Google Drive root folder
   * into the local vault and persists the Sync Index + startPageToken.
   */
  async initialPull(): Promise<void> {
    const creds = this.data.credentials;
    if (!creds) {
      throw new Error("Cannot run initialPull: Google Drive is not connected.");
    }

    const startPageToken = await this.drive.getStartPageToken();
    const syncIndex: Record<string, SyncIndexEntry> = {};

    const queue: Array<{ folderId: string; relativePrefix: string }> = [
      { folderId: creds.rootFolderId, relativePrefix: "" },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = await this.drive.listChildren(current.folderId);

      for (const item of children) {
        const relativePath = current.relativePrefix
          ? `${current.relativePrefix}/${item.name}`
          : item.name;

        if (isExcludedPath(relativePath)) {
          continue;
        }

        if (item.mimeType === GOOGLE_FOLDER_MIME) {
          if (!(await this.vault.exists(relativePath))) {
            await this.withSuppressedPath(relativePath, () => this.vault.mkdir(relativePath));
          }
          syncIndex[relativePath] = {
            path: relativePath,
            driveId: item.id,
            parentId: current.folderId,
            md5Checksum: null,
            localMtime: 0,
            remoteModifiedTime: item.modifiedTime,
            type: "folder",
          };
          queue.push({ folderId: item.id, relativePrefix: relativePath });
          continue;
        }

        if (isGoogleWorkspaceNativeMime(item.mimeType)) {
          continue;
        }

        const content = await this.drive.downloadFile(item.id);
        const stat = await this.withSuppressedPath(relativePath, () =>
          this.vault.writeBinary(relativePath, content),
        );
        syncIndex[relativePath] = {
          path: relativePath,
          driveId: item.id,
          parentId: current.folderId,
          md5Checksum: item.md5Checksum ?? null,
          localMtime: stat.mtime,
          remoteModifiedTime: item.modifiedTime,
          type: "file",
        };
      }
    }

    this.data = {
      ...this.data,
      syncIndex,
      startPageToken,
    };
    await this.vault.savePluginData(this.data);
  }

  private async withSuppressedPath<T>(path: string, fn: () => Promise<T>): Promise<T> {
    this.suppressedPaths.add(path);
    try {
      return await fn();
    } finally {
      this.suppressedPaths.delete(path);
    }
  }

  onVaultCreate(path: string, type: "file" | "folder"): void {
    if (!this.data.credentials || isExcludedPath(path) || this.suppressedPaths.has(path)) return;
    this.pendingUpserts.set(path, type);
    this.schedulePushDebounce();
  }

  onVaultModify(path: string): void {
    if (!this.data.credentials || isExcludedPath(path) || this.suppressedPaths.has(path)) return;
    this.pendingUpserts.set(path, "file");
    this.schedulePushDebounce();
  }

  onVaultRename(oldPath: string, newPath: string, type: "file" | "folder"): void {
    if (!this.data.credentials) return;
    if (this.suppressedPaths.has(oldPath) || this.suppressedPaths.has(newPath)) return;
    const oldExcluded = isExcludedPath(oldPath);
    const newExcluded = isExcludedPath(newPath);
    if (oldExcluded && newExcluded) return;
    if (oldExcluded && !newExcluded) {
      this.pendingUpserts.set(newPath, type);
      this.schedulePushDebounce();
      return;
    }
    if (!oldExcluded && newExcluded) {
      this.pendingUpserts.delete(oldPath);
      return;
    }

    const pendingType = this.pendingUpserts.get(oldPath);
    if (pendingType) {
      this.pendingUpserts.delete(oldPath);
      this.pendingUpserts.set(newPath, pendingType);
    }

    this.pendingRenames.push({ oldPath, newPath, type });
    this.schedulePushDebounce();
  }

  onVaultDelete(path: string): void {
    this.pendingUpserts.delete(path);
  }

  async onVisibilityHidden(): Promise<void> {
    this.clearDebounceTimer();
    await this.flushPendingPush();
  }

  async syncNow(): Promise<void> {
    this.clearDebounceTimer();
    await this.flushPendingPush();
  }

  dispose(): void {
    this.clearDebounceTimer();
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private schedulePushDebounce(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flushPendingPush();
    }, PUSH_DEBOUNCE_MS);
  }

  private async ensureDriveFolder(folderPath: string, rootFolderId: string): Promise<string> {
    if (!folderPath) return rootFolderId;

    const segments = folderPath.split("/").filter(Boolean);
    let currentPath = "";
    let parentId = rootFolderId;

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.data.syncIndex[currentPath];
      if (existing && existing.type === "folder") {
        parentId = existing.driveId;
        continue;
      }

      const created = await this.drive.createFolder(segment, parentId);
      this.data.syncIndex[currentPath] = {
        path: currentPath,
        driveId: created.id,
        parentId,
        md5Checksum: null,
        localMtime: 0,
        remoteModifiedTime: created.modifiedTime,
        type: "folder",
      };
      parentId = created.id;
    }

    return parentId;
  }

  async flushPendingPush(): Promise<void> {
    if (this.activeSyncPromise) {
      this.followUpRequested = true;
      await this.activeSyncPromise;
      return;
    }

    this.activeSyncPromise = (async () => {
      do {
        this.followUpRequested = false;
        await this.runFlushOnce();
      } while (
        this.followUpRequested ||
        this.pendingUpserts.size > 0 ||
        this.pendingRenames.length > 0
      );
    })().finally(() => {
      this.activeSyncPromise = null;
    });

    await this.activeSyncPromise;
  }

  private async runFlushOnce(): Promise<void> {
    const creds = this.data.credentials;
    if (!creds || (this.pendingUpserts.size === 0 && this.pendingRenames.length === 0)) return;

    const renames = this.pendingRenames.splice(0, this.pendingRenames.length);
    for (const { oldPath, newPath, type } of renames) {
      const existing = this.data.syncIndex[oldPath];
      if (!existing) {
        // Not yet tracked on Drive — upload as a new item if it exists locally
        this.pendingUpserts.set(newPath, type);
        continue;
      }

      const slashIdx = newPath.lastIndexOf("/");
      const newParentPath = slashIdx >= 0 ? newPath.slice(0, slashIdx) : "";
      const newName = slashIdx >= 0 ? newPath.slice(slashIdx + 1) : newPath;
      const newParentId = await this.ensureDriveFolder(newParentPath, creds.rootFolderId);

      const meta = await this.drive.renameOrMoveFile({
        fileId: existing.driveId,
        newName,
        ...(newParentId !== existing.parentId
          ? { addParentId: newParentId, removeParentId: existing.parentId }
          : {}),
      });

      delete this.data.syncIndex[oldPath];
      this.data.syncIndex[newPath] = {
        ...existing,
        path: newPath,
        parentId: newParentId,
        remoteModifiedTime: meta.modifiedTime,
      };

      if (existing.type === "folder") {
        const oldPrefix = `${oldPath}/`;
        const newPrefix = `${newPath}/`;
        for (const key of Object.keys(this.data.syncIndex)) {
          if (key.startsWith(oldPrefix)) {
            const childEntry = this.data.syncIndex[key];
            const updatedKey = newPrefix + key.slice(oldPrefix.length);
            delete this.data.syncIndex[key];
            this.data.syncIndex[updatedKey] = {
              ...childEntry,
              path: updatedKey,
            };
          }
        }
      }
    }

    const batch = Array.from(this.pendingUpserts.entries());
    this.pendingUpserts.clear();

    for (const [path, type] of batch) {
      const stat = await this.vault.stat(path);
      if (!stat) continue;

      if (type === "folder" || stat.type === "folder") {
        await this.ensureDriveFolder(path, creds.rootFolderId);
        continue;
      }

      const data = await this.vault.readBinary(path);
      const slashIdx = path.lastIndexOf("/");
      const parentPath = slashIdx >= 0 ? path.slice(0, slashIdx) : "";
      const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
      const parentId = await this.ensureDriveFolder(parentPath, creds.rootFolderId);

      const existing = this.data.syncIndex[path];
      const meta = await this.drive.uploadFile({
        fileId: existing?.driveId,
        name,
        parentId,
        data,
      });

      this.data.syncIndex[path] = {
        path,
        driveId: meta.id,
        parentId,
        md5Checksum: meta.md5Checksum ?? null,
        localMtime: stat.mtime,
        remoteModifiedTime: meta.modifiedTime,
        type: "file",
      };
    }

    await this.vault.savePluginData(this.data);
  }
}
