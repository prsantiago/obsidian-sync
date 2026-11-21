import { maskCredential, parseConfigBundle } from "./config-bundle";
import { GoogleDriveClient } from "./drive-client";
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

export class SyncPluginCore {
  private readonly vault: VaultPort;
  private readonly notice: NoticeSink;
  private readonly clock: Clock;
  private readonly auth: OAuthTokenManager;
  private readonly drive: GoogleDriveClient;
  private data: PluginData = emptyPluginData();

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
            await this.vault.mkdir(relativePath);
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
        const stat = await this.vault.writeBinary(relativePath, content);
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
}
