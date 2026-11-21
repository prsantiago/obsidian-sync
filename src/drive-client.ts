import type { OAuthTokenManager } from "./oauth-manager";
import { GOOGLE_DRIVE_API_BASE } from "./types";

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
}

export class DriveApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveApiError";
    this.status = status;
  }
}

export class GoogleDriveClient {
  private readonly auth: OAuthTokenManager;

  constructor(auth: OAuthTokenManager) {
    this.auth = auth;
  }

  /**
   * Lists all non-trashed direct children of a Google Drive folder, handling pagination.
   */
  async listChildren(folderId: string): Promise<DriveFileMetadata[]> {
    const items: DriveFileMetadata[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, parents, md5Checksum, modifiedTime, size)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) {
        params.set("pageToken", pageToken);
      }

      const res = await this.auth.authorizedRequest({
        url: `${GOOGLE_DRIVE_API_BASE}/files?${params.toString()}`,
        method: "GET",
      });

      if (res.status < 200 || res.status >= 300) {
        throw new DriveApiError(res.status, `Drive files.list failed (${res.status}): ${res.text}`);
      }

      const body = res.json as {
        nextPageToken?: string;
        files?: DriveFileMetadata[];
      };

      if (Array.isArray(body.files)) {
        items.push(...body.files);
      }
      pageToken = body.nextPageToken;
    } while (pageToken);

    return items;
  }

  /**
   * Downloads raw file bytes via `alt=media`.
   */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const res = await this.auth.authorizedRequest({
      url: `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      method: "GET",
    });

    if (res.status < 200 || res.status >= 300) {
      throw new DriveApiError(
        res.status,
        `Drive files.get (${fileId}) failed (${res.status}): ${res.text}`,
      );
    }

    return res.arrayBuffer;
  }

  /**
   * Fetches the current Drive changes startPageToken for incremental delta sync.
   */
  async getStartPageToken(): Promise<string> {
    const res = await this.auth.authorizedRequest({
      url: `${GOOGLE_DRIVE_API_BASE}/changes/startPageToken?supportsAllDrives=true`,
      method: "GET",
    });

    if (res.status < 200 || res.status >= 300) {
      throw new DriveApiError(
        res.status,
        `Drive changes.getStartPageToken failed (${res.status}): ${res.text}`,
      );
    }

    const body = res.json as { startPageToken?: string };
    if (!body?.startPageToken) {
      throw new Error("Drive changes.getStartPageToken response missing startPageToken.");
    }

    return body.startPageToken;
  }
}
