import { maskCredential, parseConfigBundle } from "./config-bundle";
import {
  buildConflictCandidatePath,
  bytesEqual,
  computeContentHash,
  formatConflictTimestamp,
} from "./conflict";
import { DriveApiError, GoogleDriveClient, type DriveChange, type DriveFileMetadata } from "./drive-client";
import { isExcludedPath, isGoogleWorkspaceNativeMime } from "./exclusions";
import { OAuthRefreshError, OAuthTokenManager, TerminalAuthError } from "./oauth-manager";
import {
  GOOGLE_FOLDER_MIME,
  PUSH_DEBOUNCE_MS,
  type Clock,
  type ConnectionInfo,
  type HttpTransport,
  type NoticeSink,
  type OAuthCredentials,
  type PendingQueue,
  type PendingRename,
  type PluginData,
  type SyncErrorLogEntry,
  type SyncIndexEntry,
  type VaultPort,
} from "./types";

export interface SyncPluginCoreDeps {
  vault: VaultPort;
  http: HttpTransport;
  notice: NoticeSink;
  clock?: Clock;
  isOnline?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

function emptyPendingQueue(): PendingQueue {
  return { upserts: [], renames: [] };
}

function emptyPluginData(): PluginData {
  return {
    credentials: null,
    syncIndex: {},
    startPageToken: null,
    pendingQueue: emptyPendingQueue(),
    errorLog: [],
  };
}

function normalizePluginData(raw: unknown): PluginData {
  if (typeof raw !== "object" || raw === null) {
    return emptyPluginData();
  }
  const rec = raw as Partial<PluginData>;
  const rawQueue = rec.pendingQueue;
  return {
    credentials: rec.credentials ?? null,
    syncIndex: rec.syncIndex ?? {},
    startPageToken: rec.startPageToken ?? null,
    pendingQueue: {
      upserts: Array.isArray(rawQueue?.upserts) ? rawQueue.upserts : [],
      renames: Array.isArray(rawQueue?.renames) ? rawQueue.renames : [],
    },
    errorLog: Array.isArray(rec.errorLog) ? rec.errorLog : [],
  };
}

const POLL_INTERVAL_MS = 30_000;
const ECHO_SUPPRESSION_WINDOW_MS = 2_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const ERROR_NOTICE_DURATION_MS = 8_000;
const MAX_ERROR_LOG_ENTRIES = 50;

export class SyncPluginCore {
  private readonly vault: VaultPort;
  private readonly notice: NoticeSink;
  private readonly clock: Clock;
  private readonly isOnline: () => boolean;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly auth: OAuthTokenManager;
  private readonly drive: GoogleDriveClient;
  private data: PluginData = emptyPluginData();
  private pullInFlight: Promise<void> | null = null;
  private pushInFlight: Promise<void> | null = null;
  private syncChain: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isVisible = true;
  private authHalted = false;
  private disposed = false;
  private readonly echoSuppressedUntil = new Map<string, number>();
  private pendingUpserts = new Map<string, "file" | "folder">();
  private pendingRenames: PendingRename[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressedPaths = new Set<string>();
  private followUpRequested = false;
  private readonly baselineHashes = new Map<string, string>();

  constructor(deps: SyncPluginCoreDeps) {
    this.vault = deps.vault;
    this.notice = deps.notice;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.isOnline =
      deps.isOnline ??
      (() =>
        typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
          ? navigator.onLine
          : true);
    this.sleep =
      deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
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
    this.restorePendingQueueFromData();
    if (this.data.credentials) {
      if (this.isVisible) {
        this.startPolling();
      }
      if (this.isOnline()) {
        await this.flushPendingPush();
        await this.pullDelta();
      }
    }
  }

  unload(): void {
    this.disposed = true;
    this.stopPolling();
    this.clearDebounceTimer();
  }

  dispose(): void {
    this.unload();
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
      this.clearDebounceTimer();
      await this.flushPendingPush();
      return;
    }
    if (this.data.credentials) {
      this.startPolling();
      await this.pullDelta();
    }
  }

  async handleOnline(): Promise<void> {
    if (!this.data.credentials || !this.isOnline()) {
      return;
    }
    this.clearDebounceTimer();
    await this.flushPendingPush();
    await this.pullDelta();
  }

  getErrorLog(): SyncErrorLogEntry[] {
    return [...(this.data.errorLog ?? [])];
  }

  async clearErrorLog(): Promise<void> {
    this.data = { ...this.data, errorLog: [] };
    await this.vault.savePluginData(this.data);
  }

  private restorePendingQueueFromData(): void {
    this.pendingUpserts.clear();
    this.pendingRenames = [];
    const queue = this.data.pendingQueue;
    if (!queue) return;
    for (const item of queue.upserts) {
      this.pendingUpserts.set(item.path, item.type);
    }
    for (const rename of queue.renames) {
      this.pendingRenames.push({ ...rename });
    }
  }

  private syncPendingQueueToData(): void {
    this.data = {
      ...this.data,
      pendingQueue: {
        upserts: Array.from(this.pendingUpserts.entries()).map(([path, type]) => ({ path, type })),
        renames: this.pendingRenames.map((r) => ({ ...r })),
      },
    };
  }

  private persistPendingQueue(): void {
    this.syncPendingQueueToData();
    void this.vault.savePluginData(this.data);
  }

  private startPolling(): void {
    if (this.pollTimer !== null || !this.data.credentials || !this.isVisible || this.authHalted) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pullDelta();
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
    this.authHalted = false;
    this.data = {
      credentials: { ...bundle },
      syncIndex: {},
      startPageToken: null,
      pendingQueue: emptyPendingQueue(),
      errorLog: this.data.errorLog ?? [],
    };
    await this.vault.savePluginData(this.data);
    try {
      await this.initialPull();
    } catch (err) {
      if (err instanceof TerminalAuthError) {
        this.authHalted = true;
        this.stopPolling();
        await this.appendErrorLog(err.message, "invalid_grant");
      }
      throw err;
    }
    if (this.isVisible) {
      this.startPolling();
    }
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.authHalted = false;
    this.pendingUpserts.clear();
    this.pendingRenames = [];
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
            await this.withSuppressedPath(relativePath, () => this.vault.mkdir(relativePath));
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
        const stat = await this.withSuppressedPath(relativePath, () =>
          this.vault.writeBinary(relativePath, content),
        );
        const fileEntry: SyncIndexEntry = {
          path: relativePath,
          driveId: item.id,
          parentId: current.folderId,
          md5Checksum: item.md5Checksum ?? null,
          localMtime: stat.mtime,
          remoteModifiedTime: item.modifiedTime,
          type: "file",
        };
        this.baselineHashes.set(relativePath, computeContentHash(content));
        syncIndex[relativePath] = fileEntry;
        byDriveId?.set(item.id, fileEntry);
      }
    }
  }

  private enqueueSync(fn: () => Promise<void>): Promise<void> {
    const next = this.syncChain.then(fn, fn);
    this.syncChain = next.catch(() => {});
    return next;
  }

  private async appendErrorLog(message: string, code?: string): Promise<void> {
    const entry: SyncErrorLogEntry = {
      timestamp: this.clock.now(),
      message,
      ...(code ? { code } : {}),
    };
    const nextLog = [...(this.data.errorLog ?? []), entry].slice(-MAX_ERROR_LOG_ENTRIES);
    this.data = { ...this.data, errorLog: nextLog };
    await this.vault.savePluginData(this.data);
  }

  private isTransientError(err: unknown): boolean {
    if (err instanceof TerminalAuthError) {
      return false;
    }
    if (err instanceof DriveApiError || err instanceof OAuthRefreshError) {
      return err.status === 429 || (err.status >= 500 && err.status < 600);
    }
    return true;
  }

  private async runWithRetryAndErrorHandling(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (this.disposed || !this.data.credentials || !this.isOnline() || this.authHalted) {
        return;
      }
      try {
        await operation();
        return;
      } catch (err) {
        if (err instanceof TerminalAuthError) {
          this.authHalted = true;
          this.stopPolling();
          await this.appendErrorLog(err.message, "invalid_grant");
          return;
        }
        if (this.disposed || !this.isOnline()) {
          return;
        }
        if (this.isTransientError(err) && attempt < this.retryDelaysMs.length) {
          await this.sleep(this.retryDelaysMs[attempt]);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        await this.appendErrorLog(message);
        this.notice.show(`Google Drive sync failed: ${message}`, ERROR_NOTICE_DURATION_MS);
        return;
      }
    }
  }

  /**
   * Pulls incremental remote changes using Google Drive's `changes.list` API.
   * Coalesces concurrent calls into a single in-flight pull, serialized with pushes.
   */
  async pullDelta(): Promise<void> {
    if (!this.data.credentials || !this.isOnline() || this.authHalted) {
      return;
    }
    if (this.pullInFlight) {
      return this.pullInFlight;
    }
    this.pullInFlight = this.enqueueSync(() =>
      this.runWithRetryAndErrorHandling(() => this.executePullDelta()),
    ).finally(() => {
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
      const localStat = await this.vault.stat(relativePath);
      if (localStat && localStat.type === "file") {
        const localModified =
          !existing ||
          localStat.mtime !== existing.localMtime ||
          this.pendingUpserts.has(relativePath);
        if (localModified) {
          const localBytes = await this.vault.readBinary(relativePath);
          const baselineHash = this.baselineHashes.get(relativePath);
          const localContentUnchanged =
            baselineHash !== undefined && computeContentHash(localBytes) === baselineHash;
          if (!localContentUnchanged) {
            if (bytesEqual(localBytes, content)) {
              const convergedEntry: SyncIndexEntry = {
                path: relativePath,
                driveId: file.id,
                parentId: parentId!,
                md5Checksum: file.md5Checksum ?? null,
                localMtime: localStat.mtime,
                remoteModifiedTime: file.modifiedTime,
                type: "file",
              };
              syncIndex[relativePath] = convergedEntry;
              byDriveId.set(file.id, convergedEntry);
              this.baselineHashes.set(relativePath, computeContentHash(localBytes));
              this.pendingUpserts.delete(relativePath);
              continue;
            }

            await this.resolveEditConflict({
              path: relativePath,
              parentId: parentId!,
              driveId: file.id,
              localBytes,
              localMtime: localStat.mtime,
              remoteBytes: content,
              remoteMeta: file,
              syncIndex,
              byDriveId,
            });
            continue;
          }
        }
      }

      this.suppressEcho(relativePath);
      const stat = await this.withSuppressedPath(relativePath, () =>
        this.vault.writeBinary(relativePath, content),
      );
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
      this.baselineHashes.set(relativePath, computeContentHash(content));
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

  private async resolveUniqueConflictPath(
    originalPath: string,
    syncIndex: Record<string, SyncIndexEntry>,
  ): Promise<string> {
    const timestampStr = formatConflictTimestamp(this.clock.now());
    let attempt = 1;
    while (true) {
      const candidate = buildConflictCandidatePath(originalPath, timestampStr, attempt);
      if (!(await this.vault.exists(candidate)) && !syncIndex[candidate]) {
        return candidate;
      }
      attempt += 1;
    }
  }

  private async resolveEditConflict(params: {
    path: string;
    parentId: string;
    driveId: string;
    localBytes: ArrayBuffer;
    localMtime: number;
    remoteBytes: ArrayBuffer;
    remoteMeta: DriveFileMetadata;
    syncIndex: Record<string, SyncIndexEntry>;
    byDriveId?: Map<string, SyncIndexEntry>;
  }): Promise<void> {
    const {
      path,
      parentId,
      driveId,
      localBytes,
      localMtime,
      remoteBytes,
      remoteMeta,
      syncIndex,
      byDriveId,
    } = params;

    const remoteMtimeMs = Date.parse(remoteMeta.modifiedTime) || 0;
    const localIsNewer = localMtime >= remoteMtimeMs;
    const conflictPath = await this.resolveUniqueConflictPath(path, syncIndex);

    const slashCanonical = path.lastIndexOf("/");
    const canonicalName = slashCanonical >= 0 ? path.slice(slashCanonical + 1) : path;
    const slashConflict = conflictPath.lastIndexOf("/");
    const conflictName = slashConflict >= 0 ? conflictPath.slice(slashConflict + 1) : conflictPath;

    const olderBytes = localIsNewer ? remoteBytes : localBytes;

    if (localIsNewer) {
      const updatedCanonicalMeta = await this.drive.uploadFile({
        fileId: driveId,
        name: canonicalName,
        parentId,
        data: localBytes,
      });
      const canonicalEntry: SyncIndexEntry = {
        path,
        driveId: updatedCanonicalMeta.id,
        parentId,
        md5Checksum: updatedCanonicalMeta.md5Checksum ?? null,
        localMtime,
        remoteModifiedTime: updatedCanonicalMeta.modifiedTime,
        type: "file",
      };
      syncIndex[path] = canonicalEntry;
      byDriveId?.set(updatedCanonicalMeta.id, canonicalEntry);
      this.baselineHashes.set(path, computeContentHash(localBytes));
    } else {
      this.suppressEcho(path);
      const canonicalStat = await this.withSuppressedPath(path, () =>
        this.vault.writeBinary(path, remoteBytes),
      );
      const canonicalEntry: SyncIndexEntry = {
        path,
        driveId,
        parentId,
        md5Checksum: remoteMeta.md5Checksum ?? null,
        localMtime: canonicalStat.mtime,
        remoteModifiedTime: remoteMeta.modifiedTime,
        type: "file",
      };
      syncIndex[path] = canonicalEntry;
      byDriveId?.set(driveId, canonicalEntry);
      this.baselineHashes.set(path, computeContentHash(remoteBytes));
    }

    this.suppressEcho(conflictPath);
    const conflictStat = await this.withSuppressedPath(conflictPath, () =>
      this.vault.writeBinary(conflictPath, olderBytes),
    );
    const conflictDriveMeta = await this.drive.uploadFile({
      name: conflictName,
      parentId,
      data: olderBytes,
    });
    const conflictEntry: SyncIndexEntry = {
      path: conflictPath,
      driveId: conflictDriveMeta.id,
      parentId,
      md5Checksum: conflictDriveMeta.md5Checksum ?? null,
      localMtime: conflictStat.mtime,
      remoteModifiedTime: conflictDriveMeta.modifiedTime,
      type: "file",
    };
    syncIndex[conflictPath] = conflictEntry;
    byDriveId?.set(conflictDriveMeta.id, conflictEntry);
    this.baselineHashes.set(conflictPath, computeContentHash(olderBytes));

    this.pendingUpserts.delete(path);
    this.notice.show(`Sync conflict on "${path}". Saved older version as "${conflictPath}".`);
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
    if (!this.data.credentials || isExcludedPath(path) || this.suppressedPaths.has(path)) {
      return;
    }
    this.pendingUpserts.set(path, type);
    this.persistPendingQueue();
    this.schedulePushDebounce();
  }

  onVaultModify(path: string): void {
    if (!this.data.credentials || isExcludedPath(path) || this.suppressedPaths.has(path)) {
      return;
    }
    this.pendingUpserts.set(path, "file");
    this.persistPendingQueue();
    this.schedulePushDebounce();
  }

  onVaultRename(oldPath: string, newPath: string, type: "file" | "folder"): void {
    if (!this.data.credentials) return;
    if (this.suppressedPaths.has(oldPath) || this.suppressedPaths.has(newPath)) {
      return;
    }
    const oldExcluded = isExcludedPath(oldPath);
    const newExcluded = isExcludedPath(newPath);
    if (oldExcluded && newExcluded) return;
    if (oldExcluded && !newExcluded) {
      this.pendingUpserts.set(newPath, type);
      this.persistPendingQueue();
      this.schedulePushDebounce();
      return;
    }
    if (!oldExcluded && newExcluded) {
      this.pendingUpserts.delete(oldPath);
      this.persistPendingQueue();
      return;
    }

    const pendingType = this.pendingUpserts.get(oldPath);
    if (pendingType) {
      this.pendingUpserts.delete(oldPath);
      this.pendingUpserts.set(newPath, pendingType);
    }

    this.pendingRenames.push({ oldPath, newPath, type });
    this.persistPendingQueue();
    this.schedulePushDebounce();
  }

  onVaultDelete(path: string): void {
    if (this.pendingUpserts.delete(path)) {
      this.persistPendingQueue();
    }
  }

  async onVisibilityHidden(): Promise<void> {
    await this.handleVisibilityChange(false);
  }

  async syncNow(): Promise<void> {
    this.clearDebounceTimer();
    await this.flushPendingPush();
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
    if (!this.data.credentials || !this.isOnline() || this.authHalted) {
      return;
    }
    if (this.pushInFlight) {
      this.followUpRequested = true;
      await this.pushInFlight;
      return;
    }

    this.pushInFlight = this.enqueueSync(() =>
      this.runWithRetryAndErrorHandling(async () => {
        do {
          this.followUpRequested = false;
          if (!this.isOnline() || this.authHalted) break;
          await this.runFlushOnce();
        } while (
          this.isOnline() &&
          !this.authHalted &&
          (this.followUpRequested ||
            this.pendingUpserts.size > 0 ||
            this.pendingRenames.length > 0)
        );
      }),
    ).finally(() => {
      this.pushInFlight = null;
    });

    await this.pushInFlight;
  }

  private async runFlushOnce(): Promise<void> {
    const creds = this.data.credentials;
    if (!creds || (this.pendingUpserts.size === 0 && this.pendingRenames.length === 0)) return;

    try {
      while (this.pendingRenames.length > 0) {
        const { oldPath, newPath, type } = this.pendingRenames[0];
        const existing = this.data.syncIndex[oldPath];
        if (!existing) {
          // Not yet tracked on Drive — upload as a new item if it exists locally
          this.pendingRenames.shift();
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

        this.pendingRenames.shift();
      }

      const batch = Array.from(this.pendingUpserts.entries());
      for (const [path, type] of batch) {
        const stat = await this.vault.stat(path);
        if (!stat) {
          this.pendingUpserts.delete(path);
          continue;
        }

        if (type === "folder" || stat.type === "folder") {
          await this.ensureDriveFolder(path, creds.rootFolderId);
          this.pendingUpserts.delete(path);
          continue;
        }

        const data = await this.vault.readBinary(path);
        const slashIdx = path.lastIndexOf("/");
        const parentPath = slashIdx >= 0 ? path.slice(0, slashIdx) : "";
        const name = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;
        const parentId = await this.ensureDriveFolder(parentPath, creds.rootFolderId);

        const existing = this.data.syncIndex[path];
        if (existing && existing.type === "file" && existing.driveId) {
          const remoteMeta = await this.drive.getFileMetadata(existing.driveId);
          if (remoteMeta && !remoteMeta.trashed) {
            const remoteChanged =
              remoteMeta.md5Checksum && existing.md5Checksum
                ? remoteMeta.md5Checksum !== existing.md5Checksum
                : remoteMeta.modifiedTime !== existing.remoteModifiedTime;
            if (remoteChanged) {
              const remoteBytes = await this.drive.downloadFile(existing.driveId);
              if (bytesEqual(data, remoteBytes)) {
                this.data.syncIndex[path] = {
                  path,
                  driveId: existing.driveId,
                  parentId,
                  md5Checksum: remoteMeta.md5Checksum ?? null,
                  localMtime: stat.mtime,
                  remoteModifiedTime: remoteMeta.modifiedTime,
                  type: "file",
                };
                this.baselineHashes.set(path, computeContentHash(data));
                this.pendingUpserts.delete(path);
                continue;
              }
              const baselineHash = this.baselineHashes.get(path);
              const localContentUnchanged =
                baselineHash !== undefined && computeContentHash(data) === baselineHash;
              if (localContentUnchanged) {
                this.suppressEcho(path);
                const updatedStat = await this.withSuppressedPath(path, () =>
                  this.vault.writeBinary(path, remoteBytes),
                );
                this.data.syncIndex[path] = {
                  path,
                  driveId: existing.driveId,
                  parentId,
                  md5Checksum: remoteMeta.md5Checksum ?? null,
                  localMtime: updatedStat.mtime,
                  remoteModifiedTime: remoteMeta.modifiedTime,
                  type: "file",
                };
                this.baselineHashes.set(path, computeContentHash(remoteBytes));
                this.pendingUpserts.delete(path);
                continue;
              }
              await this.resolveEditConflict({
                path,
                parentId,
                driveId: existing.driveId,
                localBytes: data,
                localMtime: stat.mtime,
                remoteBytes,
                remoteMeta,
                syncIndex: this.data.syncIndex,
              });
              this.pendingUpserts.delete(path);
              continue;
            }
          }
        }

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
        this.baselineHashes.set(path, computeContentHash(data));
        this.pendingUpserts.delete(path);
      }
    } finally {
      this.syncPendingQueueToData();
      await this.vault.savePluginData(this.data);
    }
  }
}
