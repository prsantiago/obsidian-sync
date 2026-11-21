import { maskCredential, parseConfigBundle } from "./config-bundle";
import { DriveApiError, GoogleDriveClient, type DriveChange, type DriveFileMetadata } from "./drive-client";
import { isExcludedPath, isGoogleWorkspaceNativeMime } from "./exclusions";
import { OAuthTokenManager } from "./oauth-manager";
import {
  GOOGLE_FOLDER_MIME,
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

const POLL_INTERVAL_MS = 30_000;
const ECHO_SUPPRESSION_WINDOW_MS = 2_000;

export class SyncPluginCore {
  private readonly vault: VaultPort;
  private readonly notice: NoticeSink;
  private readonly clock: Clock;
  private readonly auth: OAuthTokenManager;
  private readonly drive: GoogleDriveClient;
  private data: PluginData = emptyPluginData();
  private pullInFlight: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isVisible = true;
  private readonly echoSuppressedUntil = new Map<string, number>();

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
    if (this.data.credentials) {
      if (this.isVisible) {
        this.startPolling();
      }
      await this.pullDelta();
    }
  }

  unload(): void {
    this.stopPolling();
  }

  /**
   * Returns true if `path` was recently written, renamed, or deleted by a remote pull
   * so local vault event handlers can skip push echo loops.
   */
  isEchoSuppressed(path: string): boolean {
    const until = this.echoSuppressedUntil.get(path);
    if (until === undefined) {
      return false;
    }
    if (this.clock.now() >= until) {
      this.echoSuppressedUntil.delete(path);
      return false;
    }
    return true;
  }

  private suppressEcho(path: string): void {
    this.echoSuppressedUntil.set(path, this.clock.now() + ECHO_SUPPRESSION_WINDOW_MS);
  }

  async handleVisibilityChange(visible: boolean): Promise<void> {
    this.isVisible = visible;
    if (!visible) {
      this.stopPolling();
      return;
    }
    if (this.data.credentials) {
      this.startPolling();
      await this.pullDelta();
    }
  }

  private startPolling(): void {
    if (this.pollTimer !== null || !this.data.credentials || !this.isVisible) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pullDelta().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        this.notice.show(`Google Drive sync failed: ${message}`);
      });
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    if (this.isVisible) {
      this.startPolling();
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
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
    await this.pullSubtree(creds.rootFolderId, "", syncIndex);

    this.data = {
      ...this.data,
      syncIndex,
      startPageToken,
    };
    await this.vault.savePluginData(this.data);
  }

  private async pullSubtree(
    rootFolderId: string,
    rootRelativePrefix: string,
    syncIndex: Record<string, SyncIndexEntry>,
    byDriveId?: Map<string, SyncIndexEntry>,
  ): Promise<void> {
    const queue: Array<{ folderId: string; relativePrefix: string }> = [
      { folderId: rootFolderId, relativePrefix: rootRelativePrefix },
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
          this.suppressEcho(relativePath);
          if (!(await this.vault.exists(relativePath))) {
            await this.vault.mkdir(relativePath);
          }
          const folderEntry: SyncIndexEntry = {
            path: relativePath,
            driveId: item.id,
            parentId: current.folderId,
            md5Checksum: null,
            localMtime: 0,
            remoteModifiedTime: item.modifiedTime,
            type: "folder",
          };
          syncIndex[relativePath] = folderEntry;
          byDriveId?.set(item.id, folderEntry);
          queue.push({ folderId: item.id, relativePrefix: relativePath });
          continue;
        }

        if (isGoogleWorkspaceNativeMime(item.mimeType)) {
          continue;
        }

        const content = await this.drive.downloadFile(item.id);
        this.suppressEcho(relativePath);
        const stat = await this.vault.writeBinary(relativePath, content);
        const fileEntry: SyncIndexEntry = {
          path: relativePath,
          driveId: item.id,
          parentId: current.folderId,
          md5Checksum: item.md5Checksum ?? null,
          localMtime: stat.mtime,
          remoteModifiedTime: item.modifiedTime,
          type: "file",
        };
        syncIndex[relativePath] = fileEntry;
        byDriveId?.set(item.id, fileEntry);
      }
    }
  }

  /**
   * Pulls incremental remote changes using Google Drive's `changes.list` API.
   * Coalesces concurrent calls into a single in-flight pull.
   */
  async pullDelta(): Promise<void> {
    if (!this.data.credentials) {
      return;
    }
    if (this.pullInFlight) {
      return this.pullInFlight;
    }
    this.pullInFlight = this.executePullDelta().finally(() => {
      this.pullInFlight = null;
    });
    return this.pullInFlight;
  }

  private async executePullDelta(): Promise<void> {
    const creds = this.data.credentials;
    if (!creds) return;

    if (!this.data.startPageToken) {
      await this.initialPull();
      return;
    }

    let changes: DriveChange[];
    let newStartPageToken: string;
    try {
      const result = await this.drive.listChanges(this.data.startPageToken);
      changes = result.changes;
      newStartPageToken = result.newStartPageToken;
    } catch (err) {
      if (
        err instanceof DriveApiError &&
        (err.status === 410 || (err.status === 400 && /pageToken|invalid/i.test(err.message)))
      ) {
        await this.reconcileFullSubtree();
        return;
      }
      throw err;
    }

    const latestById = new Map<string, DriveChange>();
    for (const change of changes) {
      latestById.set(change.fileId, change);
    }

    const syncIndex: Record<string, SyncIndexEntry> = { ...this.data.syncIndex };
    const byDriveId = new Map<string, SyncIndexEntry>();
    for (const entry of Object.values(syncIndex)) {
      byDriveId.set(entry.driveId, entry);
    }

    const resolvedNewFolders = new Map<string, string | null>();
    resolvedNewFolders.set(creds.rootFolderId, "");

    const resolveParentPath = (parentId: string | undefined, seen = new Set<string>()): string | null => {
      if (!parentId) return null;
      if (resolvedNewFolders.has(parentId)) {
        return resolvedNewFolders.get(parentId)!;
      }
      if (seen.has(parentId)) return null;
      seen.add(parentId);

      const pendingParent = latestById.get(parentId);
      if (pendingParent) {
        if (
          !pendingParent.file ||
          pendingParent.removed ||
          pendingParent.file.trashed ||
          pendingParent.file.mimeType !== GOOGLE_FOLDER_MIME
        ) {
          resolvedNewFolders.set(parentId, null);
          return null;
        }
        const grandParentPath = resolveParentPath(pendingParent.file.parents?.[0], seen);
        if (grandParentPath === null) {
          resolvedNewFolders.set(parentId, null);
          return null;
        }
        const folderPath = grandParentPath
          ? `${grandParentPath}/${pendingParent.file.name}`
          : pendingParent.file.name;
        resolvedNewFolders.set(parentId, folderPath);
        return folderPath;
      }

      const indexed = byDriveId.get(parentId);
      if (indexed && indexed.type === "folder") {
        resolvedNewFolders.set(parentId, indexed.path);
        return indexed.path;
      }

      resolvedNewFolders.set(parentId, null);
      return null;
    };

    const removeIndexedSubtree = (folderPath: string) => {
      const prefix = `${folderPath}/`;
      for (const key of Object.keys(syncIndex)) {
        if (key === folderPath || key.startsWith(prefix)) {
          const removed = syncIndex[key];
          delete syncIndex[key];
          byDriveId.delete(removed.driveId);
        }
      }
    };

    const renameIndexedSubtree = (oldFolderPath: string, newFolderPath: string) => {
      const oldPrefix = `${oldFolderPath}/`;
      const entriesToMove: SyncIndexEntry[] = [];
      for (const key of Object.keys(syncIndex)) {
        if (key.startsWith(oldPrefix)) {
          entriesToMove.push(syncIndex[key]);
          delete syncIndex[key];
        }
      }
      for (const child of entriesToMove) {
        const updatedPath = `${newFolderPath}/${child.path.slice(oldPrefix.length)}`;
        const updatedChild: SyncIndexEntry = { ...child, path: updatedPath };
        syncIndex[updatedPath] = updatedChild;
        byDriveId.set(updatedChild.driveId, updatedChild);
      }
    };

    // Pass 1: Folders (moves out, renames/moves within, creates/moves into)
    for (const change of latestById.values()) {
      const file = change.file;
      const existing = byDriveId.get(change.fileId);

      if (file?.mimeType !== GOOGLE_FOLDER_MIME && existing?.type !== "folder") {
        continue;
      }

      if (!file || change.removed || file.trashed) {
        if (existing?.type === "folder") {
          this.suppressEcho(existing.path);
          if (await this.vault.exists(existing.path)) {
            await this.vault.rmdir(existing.path, true);
          }
          removeIndexedSubtree(existing.path);
        }
        continue;
      }

      const parentId = file.parents?.[0];
      const parentPath = resolveParentPath(parentId);
      if (parentPath === null) {
        // Folder moved outside synced root subtree
        if (existing?.type === "folder") {
          this.suppressEcho(existing.path);
          if (await this.vault.exists(existing.path)) {
            await this.vault.rmdir(existing.path, true);
          }
          removeIndexedSubtree(existing.path);
        }
        continue;
      }

      const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
      if (isExcludedPath(relativePath)) {
        continue;
      }

      if (existing && existing.type === "folder") {
        if (existing.path !== relativePath) {
          this.suppressEcho(existing.path);
          this.suppressEcho(relativePath);
          if (await this.vault.exists(existing.path)) {
            await this.vault.rename(existing.path, relativePath);
          } else if (!(await this.vault.exists(relativePath))) {
            await this.vault.mkdir(relativePath);
          }
          delete syncIndex[existing.path];
          renameIndexedSubtree(existing.path, relativePath);
        }
        const entry: SyncIndexEntry = {
          ...existing,
          path: relativePath,
          parentId: parentId!,
          remoteModifiedTime: file.modifiedTime,
        };
        syncIndex[relativePath] = entry;
        byDriveId.set(file.id, entry);
      } else {
        // New folder or external folder moved INTO synced root subtree
        if (!(await this.vault.exists(relativePath))) {
          await this.vault.mkdir(relativePath);
        }
        const entry: SyncIndexEntry = {
          path: relativePath,
          driveId: file.id,
          parentId: parentId!,
          md5Checksum: null,
          localMtime: 0,
          remoteModifiedTime: file.modifiedTime,
          type: "folder",
        };
        syncIndex[relativePath] = entry;
        byDriveId.set(file.id, entry);
        await this.pullSubtree(file.id, relativePath, syncIndex, byDriveId);
      }
    }

    // Pass 2: Files (moves out, renames/moves within, creates/edits)
    for (const change of latestById.values()) {
      const file = change.file;
      const existing = byDriveId.get(change.fileId);

      if (file?.mimeType === GOOGLE_FOLDER_MIME || existing?.type === "folder") {
        continue;
      }

      if (!file || change.removed || file.trashed) {
        if (existing?.type === "file") {
          this.suppressEcho(existing.path);
          if (await this.vault.exists(existing.path)) {
            await this.vault.remove(existing.path);
          }
          delete syncIndex[existing.path];
          byDriveId.delete(change.fileId);
        }
        continue;
      }

      if (isGoogleWorkspaceNativeMime(file.mimeType)) continue;

      const parentId = file.parents?.[0];
      const parentPath = resolveParentPath(parentId);
      if (parentPath === null) {
        // File moved outside synced root subtree
        if (existing?.type === "file") {
          this.suppressEcho(existing.path);
          if (await this.vault.exists(existing.path)) {
            await this.vault.remove(existing.path);
          }
          delete syncIndex[existing.path];
          byDriveId.delete(file.id);
        }
        continue;
      }

      const relativePath = parentPath ? `${parentPath}/${file.name}` : file.name;
      if (isExcludedPath(relativePath)) continue;

      if (existing && existing.type === "file" && existing.path !== relativePath) {
        this.suppressEcho(existing.path);
        this.suppressEcho(relativePath);
        if (await this.vault.exists(existing.path)) {
          await this.vault.rename(existing.path, relativePath);
        }
        delete syncIndex[existing.path];
      }

      if (
        existing &&
        existing.type === "file" &&
        existing.md5Checksum &&
        file.md5Checksum &&
        existing.md5Checksum === file.md5Checksum &&
        (await this.vault.exists(relativePath))
      ) {
        const updatedEntry: SyncIndexEntry = {
          ...existing,
          path: relativePath,
          parentId: parentId!,
          remoteModifiedTime: file.modifiedTime,
        };
        syncIndex[relativePath] = updatedEntry;
        byDriveId.set(file.id, updatedEntry);
        continue;
      }

      const content = await this.drive.downloadFile(file.id);
      this.suppressEcho(relativePath);
      const stat = await this.vault.writeBinary(relativePath, content);
      const entry: SyncIndexEntry = {
        path: relativePath,
        driveId: file.id,
        parentId: parentId!,
        md5Checksum: file.md5Checksum ?? null,
        localMtime: stat.mtime,
        remoteModifiedTime: file.modifiedTime,
        type: "file",
      };
      syncIndex[relativePath] = entry;
      byDriveId.set(file.id, entry);
    }

    this.data = {
      ...this.data,
      syncIndex,
      startPageToken: newStartPageToken,
    };
    await this.vault.savePluginData(this.data);
  }

  private async reconcileFullSubtree(): Promise<void> {
    const oldSyncIndex = this.data.syncIndex;
    await this.initialPull();
    const newSyncIndex = this.data.syncIndex;

    // Remove any previously synced files/folders that are no longer in the Drive subtree.
    const staleEntries = Object.values(oldSyncIndex)
      .filter((entry) => !newSyncIndex[entry.path])
      .sort((a, b) => b.path.length - a.path.length);

    for (const stale of staleEntries) {
      if (!(await this.vault.exists(stale.path))) continue;
      this.suppressEcho(stale.path);
      if (stale.type === "file") {
        await this.vault.remove(stale.path);
      } else {
        await this.vault.rmdir(stale.path, true);
      }
    }
  }
}
