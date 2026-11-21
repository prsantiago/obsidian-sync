import type { OAuthTokenManager } from "./oauth-manager";
import {
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_DRIVE_UPLOAD_BASE,
  GOOGLE_FOLDER_MIME,
  MULTIPART_UPLOAD_MAX_BYTES,
} from "./types";

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

  /**
   * Creates a folder in Google Drive under the given parent folder ID.
   */
  async createFolder(name: string, parentId: string): Promise<DriveFileMetadata> {
    const fields = "id,name,mimeType,parents,md5Checksum,modifiedTime,size";
    const res = await this.auth.authorizedRequest({
      url: `${GOOGLE_DRIVE_API_BASE}/files?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: GOOGLE_FOLDER_MIME,
        parents: [parentId],
      }),
    });

    if (res.status < 200 || res.status >= 300) {
      throw new DriveApiError(
        res.status,
        `Drive createFolder (${name}) failed (${res.status}): ${res.text}`,
      );
    }

    return res.json as DriveFileMetadata;
  }

  /**
   * Renames and/or moves a Google Drive file or folder using addParents/removeParents.
   */
  async renameOrMoveFile(params: {
    fileId: string;
    newName: string;
    addParentId?: string;
    removeParentId?: string;
  }): Promise<DriveFileMetadata> {
    const query = new URLSearchParams({
      fields: "id,name,mimeType,parents,md5Checksum,modifiedTime,size",
      supportsAllDrives: "true",
    });
    if (params.addParentId) {
      query.set("addParents", params.addParentId);
    }
    if (params.removeParentId) {
      query.set("removeParents", params.removeParentId);
    }

    const res = await this.auth.authorizedRequest({
      url: `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(params.fileId)}?${query.toString()}`,
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: params.newName }),
    });

    if (res.status < 200 || res.status >= 300) {
      throw new DriveApiError(
        res.status,
        `Drive renameOrMove (${params.fileId}) failed (${res.status}): ${res.text}`,
      );
    }

    return res.json as DriveFileMetadata;
  }

  /**
   * Uploads a file <= 5 MB using Google Drive's multipart/related upload protocol.
   */
  async uploadFileMultipart(params: {
    fileId?: string;
    name: string;
    parentId: string;
    mimeType?: string;
    data: ArrayBuffer;
  }): Promise<DriveFileMetadata> {
    const boundary = `obsidian_sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    const contentMime = params.mimeType ?? "application/octet-stream";
    const metadata: Record<string, unknown> = params.fileId
      ? { name: params.name }
      : { name: params.name, parents: [params.parentId] };

    const enc = new TextEncoder();
    const preamble = enc.encode(
      `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${contentMime}\r\n\r\n`,
    );
    const epilogue = enc.encode(`\r\n--${boundary}--`);
    const fileBytes = new Uint8Array(params.data);

    const body = new Uint8Array(preamble.byteLength + fileBytes.byteLength + epilogue.byteLength);
    body.set(preamble, 0);
    body.set(fileBytes, preamble.byteLength);
    body.set(epilogue, preamble.byteLength + fileBytes.byteLength);

    const fields = "id,name,mimeType,parents,md5Checksum,modifiedTime,size";
    const url = params.fileId
      ? `${GOOGLE_DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(params.fileId)}?uploadType=multipart&fields=${encodeURIComponent(fields)}&supportsAllDrives=true`
      : `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;

    const res = await this.auth.authorizedRequest({
      url,
      method: params.fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: body.buffer,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new DriveApiError(
        res.status,
        `Drive multipart upload (${params.name}) failed (${res.status}): ${res.text}`,
      );
    }

    return res.json as DriveFileMetadata;
  }

  /**
   * Uploads a file > 5 MB using Google Drive's resumable upload protocol.
   */
  async uploadFileResumable(params: {
    fileId?: string;
    name: string;
    parentId: string;
    mimeType?: string;
    data: ArrayBuffer;
  }): Promise<DriveFileMetadata> {
    const contentMime = params.mimeType ?? "application/octet-stream";
    const metadata: Record<string, unknown> = params.fileId
      ? { name: params.name }
      : { name: params.name, parents: [params.parentId] };

    const fields = "id,name,mimeType,parents,md5Checksum,modifiedTime,size";
    const initUrl = params.fileId
      ? `${GOOGLE_DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(params.fileId)}?uploadType=resumable&fields=${encodeURIComponent(fields)}&supportsAllDrives=true`
      : `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;

    const initRes = await this.auth.authorizedRequest({
      url: initUrl,
      method: params.fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": contentMime,
        "X-Upload-Content-Length": String(params.data.byteLength),
      },
      body: JSON.stringify(metadata),
    });

    if (initRes.status < 200 || initRes.status >= 300) {
      throw new DriveApiError(
        initRes.status,
        `Drive resumable upload init (${params.name}) failed (${initRes.status}): ${initRes.text}`,
      );
    }

    const uploadUrl =
      initRes.headers["location"] ??
      initRes.headers["Location"] ??
      Object.entries(initRes.headers).find(([k]) => k.toLowerCase() === "location")?.[1];

    if (!uploadUrl) {
      throw new Error(`Drive resumable upload init (${params.name}) missing Location header.`);
    }

    const putRes = await this.auth.authorizedRequest({
      url: uploadUrl,
      method: "PUT",
      headers: {
        "Content-Type": contentMime,
      },
      body: params.data,
    });

    if (putRes.status < 200 || putRes.status >= 300) {
      throw new DriveApiError(
        putRes.status,
        `Drive resumable upload PUT (${params.name}) failed (${putRes.status}): ${putRes.text}`,
      );
    }

    return putRes.json as DriveFileMetadata;
  }

  /**
   * Uploads a file using multipart (<= 5 MB) or resumable (> 5 MB) upload.
   */
  async uploadFile(params: {
    fileId?: string;
    name: string;
    parentId: string;
    mimeType?: string;
    data: ArrayBuffer;
  }): Promise<DriveFileMetadata> {
    if (params.data.byteLength > MULTIPART_UPLOAD_MAX_BYTES) {
      return this.uploadFileResumable(params);
    }
    return this.uploadFileMultipart(params);
  }
}
