import {
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_FOLDER_MIME,
  GOOGLE_OAUTH_TOKEN_URL,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from "../../src/types";

export interface FakeDriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: Uint8Array;
  md5Checksum?: string;
  modifiedTime: string;
  trashed?: boolean;
}

interface RecordedChange {
  seq: number;
  fileId: string;
  removed?: boolean;
}

interface ResumableSession {
  fileId?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
}

export class FakeGoogleDriveHttp implements HttpTransport {
  private items = new Map<string, FakeDriveItem>();
  private validAccessTokens = new Map<string, number>(); // token -> expiresAt
  private resumableSessions = new Map<string, ResumableSession>();
  private tokenCounter = 0;
  private itemCounter = 0;
  private sessionCounter = 0;
  private startPageToken = "100";
  private changeSeq = 100;
  private hasIssuedStartPageToken = false;
  private changesLog: RecordedChange[] = [];
  private expiredPageTokens = new Set<string>();
  private nowFn: () => number;

  public validClientId = "test-client-id";
  public validClientSecret = "test-client-secret";
  public validRefreshToken = "test-refresh-token";
  public validAuthCode = "test-auth-code";
  public omitRefreshTokenOnCodeExchange = false;
  public revokedRefreshToken = false;
  public forceNextDrive401 = false;
  public defaultPageSize = 1000;
  public tokenRefreshCount = 0;
  public downloadedFileIds: string[] = [];
  public driveRequests: Array<{ method: string; url: string }> = [];
  public multipartUploadCount = 0;
  public resumableUploadCount = 0;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  seedFolder(id: string, name: string, parentId: string, modifiedTime = "2026-01-01T00:00:00.000Z", trashed = false): void {
    this.items.set(id, {
      id,
      name,
      mimeType: GOOGLE_FOLDER_MIME,
      parents: [parentId],
      modifiedTime,
      trashed,
    });
    if (this.hasIssuedStartPageToken) {
      this.recordChange(id);
    }
  }

  seedFile(opts: {
    id: string;
    name: string;
    parentId: string;
    mimeType?: string;
    content?: string | Uint8Array;
    md5Checksum?: string;
    modifiedTime?: string;
    trashed?: boolean;
  }): void {
    const rawContent = opts.content ?? "";
    const bytes = typeof rawContent === "string" ? new TextEncoder().encode(rawContent) : rawContent.slice();
    this.items.set(opts.id, {
      id: opts.id,
      name: opts.name,
      mimeType: opts.mimeType ?? "text/markdown",
      parents: [opts.parentId],
      content: bytes,
      md5Checksum: opts.md5Checksum ?? `md5-${opts.id}`,
      modifiedTime: opts.modifiedTime ?? "2026-01-01T00:00:00.000Z",
      trashed: opts.trashed ?? false,
    });
    if (this.hasIssuedStartPageToken) {
      this.recordChange(opts.id);
    }
  }

  renameOrMoveItem(id: string, updates: { name?: string; parentId?: string; modifiedTime?: string }): void {
    const item = this.items.get(id);
    if (!item) {
      throw new Error(`FakeGoogleDriveHttp: item not found: ${id}`);
    }
    if (updates.name !== undefined) item.name = updates.name;
    if (updates.parentId !== undefined) item.parents = [updates.parentId];
    if (updates.modifiedTime !== undefined) item.modifiedTime = updates.modifiedTime;
    this.recordChange(id);
  }

  recordChange(fileId: string, removed = false): string {
    this.changeSeq += 1;
    this.startPageToken = String(this.changeSeq);
    this.changesLog.push({ seq: this.changeSeq, fileId, removed });
    return this.startPageToken;
  }

  expirePageToken(token: string): void {
    this.expiredPageTokens.add(token);
  }

  setStartPageToken(token: string): void {
    this.startPageToken = token;
    const numeric = Number(token);
    if (!Number.isNaN(numeric) && numeric > this.changeSeq) {
      this.changeSeq = numeric;
    }
  }

  getItem(id: string): FakeDriveItem | undefined {
    return this.items.get(id);
  }

  findItemByName(name: string, parentId?: string): FakeDriveItem | undefined {
    for (const item of this.items.values()) {
      if (item.trashed) continue;
      if (item.name === name && (!parentId || item.parents.includes(parentId))) {
        return item;
      }
    }
    return undefined;
  }

  listAllItems(): FakeDriveItem[] {
    return Array.from(this.items.values()).filter((i) => !i.trashed);
  }

  async request(params: HttpRequest): Promise<HttpResponse> {
    if (params.url === GOOGLE_OAUTH_TOKEN_URL && params.method === "POST") {
      return this.handleTokenRefresh(params);
    }

    const url = new URL(params.url);

    // Resumable upload PUT to session URI does not require Bearer header (session URI is pre-authenticated)
    const sessionMatch = url.pathname.match(/^\/upload\/drive\/v3\/sessions\/([^/]+)$/);
    if (sessionMatch && params.method === "PUT") {
      return this.handleResumablePut(decodeURIComponent(sessionMatch[1]), params);
    }

    if (
      params.url.startsWith(GOOGLE_DRIVE_API_BASE) ||
      params.url.startsWith("https://www.googleapis.com/upload/drive/v3")
    ) {
      if (!this.isAuthorized(params.headers)) {
        return this.jsonResponse(401, {
          error: { code: 401, message: "Invalid Credentials" },
        });
      }
      if (this.forceNextDrive401) {
        this.forceNextDrive401 = false;
        return this.jsonResponse(401, {
          error: { code: 401, message: "Token expired" },
        });
      }

      this.driveRequests.push({ method: params.method ?? "GET", url: params.url });
      const url = new URL(params.url);
      const method = params.method ?? "GET";

      if (url.pathname === "/drive/v3/files" && method === "GET") {
        return this.handleFilesList(url);
      }

      if (url.pathname === "/drive/v3/files" && method === "POST") {
        return this.handleCreateMetadata(params);
      }

      if (url.pathname === "/drive/v3/changes/startPageToken" && method === "GET") {
        this.hasIssuedStartPageToken = true;
        return this.jsonResponse(200, { startPageToken: this.startPageToken });
      }

      if (url.pathname === "/drive/v3/changes" && method === "GET") {
        return this.handleChangesList(url);
      }

      const fileMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (fileMatch && method === "GET") {
        const fileId = decodeURIComponent(fileMatch[1]);
        const item = this.items.get(fileId);
        if (url.searchParams.get("alt") === "media") {
          if (!item || !item.content) {
            return this.jsonResponse(404, { error: { code: 404, message: "File not found" } });
          }
          this.downloadedFileIds.push(fileId);
          return this.binaryResponse(200, item.content);
        }
        if (!item) {
          return this.jsonResponse(404, { error: { code: 404, message: "File not found" } });
        }
        return this.jsonResponse(200, this.toFileMetadata(item));
      }

      if (fileMatch && method === "PATCH") {
        return this.handlePatchMetadata(decodeURIComponent(fileMatch[1]), url, params);
      }

      if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
        const uploadType = url.searchParams.get("uploadType");
        if (uploadType === "multipart") {
          return this.handleMultipartUpload(undefined, params);
        }
        if (uploadType === "resumable") {
          return this.handleResumableInit(undefined, params);
        }
      }

      const uploadFileMatch = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (uploadFileMatch && method === "PATCH") {
        const fileId = decodeURIComponent(uploadFileMatch[1]);
        const uploadType = url.searchParams.get("uploadType");
        if (uploadType === "multipart") {
          return this.handleMultipartUpload(fileId, params);
        }
        if (uploadType === "resumable") {
          return this.handleResumableInit(fileId, params);
        }
      }
    }

    return this.jsonResponse(404, { error: { code: 404, message: `Unhandled URL: ${params.url}` } });
  }

  private handleTokenRefresh(params: HttpRequest): HttpResponse {
    const bodyText = typeof params.body === "string" ? params.body : "";
    const form = new URLSearchParams(bodyText);
    const clientId = form.get("client_id");
    const clientSecret = form.get("client_secret");
    const refreshToken = form.get("refresh_token");
    const grantType = form.get("grant_type");

    if (grantType === "authorization_code") {
      const code = form.get("code");
      const redirectUri = form.get("redirect_uri");
      if (
        !redirectUri ||
        clientId !== this.validClientId ||
        clientSecret !== this.validClientSecret ||
        code !== this.validAuthCode
      ) {
        return this.jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Invalid authorization code or client credentials.",
        });
      }

      const accessToken = `access-token-${++this.tokenCounter}`;
      const expiresIn = 3600;
      this.validAccessTokens.set(accessToken, this.nowFn() + expiresIn * 1000);

      return this.jsonResponse(200, {
        access_token: accessToken,
        expires_in: expiresIn,
        token_type: "Bearer",
        ...(this.omitRefreshTokenOnCodeExchange ? {} : { refresh_token: this.validRefreshToken }),
      });
    }

    if (
      this.revokedRefreshToken ||
      grantType !== "refresh_token" ||
      clientId !== this.validClientId ||
      clientSecret !== this.validClientSecret ||
      refreshToken !== this.validRefreshToken
    ) {
      return this.jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      });
    }

    this.tokenRefreshCount += 1;
    const accessToken = `access-token-${++this.tokenCounter}`;
    const expiresIn = 3600;
    this.validAccessTokens.set(accessToken, this.nowFn() + expiresIn * 1000);

    return this.jsonResponse(200, {
      access_token: accessToken,
      expires_in: expiresIn,
      token_type: "Bearer",
    });
  }

  private isAuthorized(headers?: Record<string, string>): boolean {
    if (!headers) return false;
    const auth = headers["Authorization"] ?? headers["authorization"];
    if (!auth || !auth.startsWith("Bearer ")) return false;
    const token = auth.slice("Bearer ".length);
    const expiresAt = this.validAccessTokens.get(token);
    if (expiresAt === undefined) return false;
    return this.nowFn() < expiresAt;
  }

  private handleFilesList(url: URL): HttpResponse {
    const q = url.searchParams.get("q") ?? "";
    const parentMatch = q.match(/'([^']+)' in parents/);
    const parentId = parentMatch ? parentMatch[1] : null;
    const nameMatch = q.match(/name\s*=\s*'((?:\\'|[^'])*)'/);
    const expectedName = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : null;
    const mimeMatch = q.match(/mimeType\s*=\s*'([^']+)'/);
    const expectedMime = mimeMatch ? mimeMatch[1] : null;
    const requireNotTrashed = q.includes("trashed = false");

    const matching = Array.from(this.items.values()).filter((item) => {
      if (parentId && !item.parents.includes(parentId)) return false;
      if (expectedName !== null && item.name !== expectedName) return false;
      if (expectedMime !== null && item.mimeType !== expectedMime) return false;
      if (requireNotTrashed && item.trashed) return false;
      return true;
    });

    const pageSize = Math.min(
      Number(url.searchParams.get("pageSize") ?? this.defaultPageSize),
      this.defaultPageSize,
    );
    const offset = Number(url.searchParams.get("pageToken") ?? "0");
    const slice = matching.slice(offset, offset + pageSize);
    const nextOffset = offset + slice.length;
    const nextPageToken = nextOffset < matching.length ? String(nextOffset) : undefined;

    return this.jsonResponse(200, {
      ...(nextPageToken ? { nextPageToken } : {}),
      files: slice.map((item) => this.toFileMetadata(item)),
    });
  }

  private handleChangesList(url: URL): HttpResponse {
    const pageToken = url.searchParams.get("pageToken") ?? "";
    if (!pageToken || this.expiredPageTokens.has(pageToken)) {
      return this.jsonResponse(410, {
        error: { code: 410, message: "Start page token is invalid or expired." },
      });
    }

    const sinceSeq = Number(pageToken);
    const matching = this.changesLog.filter((c) => c.seq > sinceSeq);

    const pageSize = Math.min(
      Number(url.searchParams.get("pageSize") ?? this.defaultPageSize),
      this.defaultPageSize,
    );

    const slice = matching.slice(0, pageSize);
    const hasMore = matching.length > slice.length;
    const lastSeqInSlice = slice.length > 0 ? slice[slice.length - 1].seq : sinceSeq;
    const nextPageToken = hasMore ? String(lastSeqInSlice) : undefined;
    const newStartPageToken = hasMore ? undefined : String(this.changeSeq);

    return this.jsonResponse(200, {
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(newStartPageToken ? { newStartPageToken } : {}),
      changes: slice.map((c) => {
        const item = this.items.get(c.fileId);
        return {
          fileId: c.fileId,
          removed: Boolean(c.removed),
          ...(item && !c.removed ? { file: this.toFileMetadata(item) } : {}),
        };
      }),
    });
  }

  private toMetadataDto(item: FakeDriveItem) {
    return this.toFileMetadata(item);
  }

  private toFileMetadata(item: FakeDriveItem) {
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      parents: item.parents,
      ...(item.md5Checksum ? { md5Checksum: item.md5Checksum } : {}),
      modifiedTime: item.modifiedTime,
      ...(item.trashed ? { trashed: true } : {}),
      ...(item.content ? { size: String(item.content.byteLength) } : {}),
    };
  }
  private handleCreateMetadata(params: HttpRequest): HttpResponse {
    const body = JSON.parse(typeof params.body === "string" ? params.body : "{}") as {
      name?: string;
      mimeType?: string;
      parents?: string[];
    };
    const id = `drive-item-${++this.itemCounter}`;
    const item: FakeDriveItem = {
      id,
      name: body.name ?? "untitled",
      mimeType: body.mimeType ?? GOOGLE_FOLDER_MIME,
      parents: body.parents ?? [],
      modifiedTime: new Date(this.nowFn()).toISOString(),
      trashed: false,
    };
    this.items.set(id, item);
    return this.jsonResponse(200, this.toMetadataDto(item));
  }

  private handlePatchMetadata(fileId: string, url: URL, params: HttpRequest): HttpResponse {
    const item = this.items.get(fileId);
    if (!item || item.trashed) {
      return this.jsonResponse(404, { error: { code: 404, message: "File not found" } });
    }
    const body = JSON.parse(typeof params.body === "string" ? params.body : "{}") as {
      name?: string;
      trashed?: boolean;
    };
    if (body.name !== undefined) {
      item.name = body.name;
    }
    if (body.trashed !== undefined) {
      item.trashed = body.trashed;
    }
    const removeParents = (url.searchParams.get("removeParents") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const addParents = (url.searchParams.get("addParents") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (removeParents.length > 0) {
      item.parents = item.parents.filter((p) => !removeParents.includes(p));
    }
    for (const p of addParents) {
      if (!item.parents.includes(p)) {
        item.parents.push(p);
      }
    }
    item.modifiedTime = new Date(this.nowFn()).toISOString();
    return this.jsonResponse(200, this.toMetadataDto(item));
  }

  private handleMultipartUpload(fileId: string | undefined, params: HttpRequest): HttpResponse {
    const contentType =
      params.headers?.["Content-Type"] ?? params.headers?.["content-type"] ?? "";
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/i);
    if (!boundaryMatch) {
      return this.jsonResponse(400, { error: { code: 400, message: "Missing multipart boundary" } });
    }
    const boundary = boundaryMatch[1];
    const rawBytes =
      params.body instanceof ArrayBuffer
        ? new Uint8Array(params.body)
        : new TextEncoder().encode(params.body ?? "");
    const { metadata, fileBytes } = this.parseMultipartRelated(rawBytes, boundary);
    this.multipartUploadCount += 1;
    return this.upsertUploadedFile(fileId, metadata, fileBytes);
  }

  private handleResumableInit(fileId: string | undefined, params: HttpRequest): HttpResponse {
    const metadata = JSON.parse(typeof params.body === "string" ? params.body : "{}") as {
      name?: string;
      mimeType?: string;
      parents?: string[];
    };
    const sessionId = `session-${++this.sessionCounter}`;
    this.resumableSessions.set(sessionId, {
      fileId,
      name: metadata.name,
      mimeType: metadata.mimeType,
      parents: metadata.parents,
    });
    return {
      status: 200,
      headers: {
        location: `https://www.googleapis.com/upload/drive/v3/sessions/${sessionId}`,
        "content-type": "application/json",
      },
      text: "",
      json: null,
      arrayBuffer: new ArrayBuffer(0),
    };
  }

  private handleResumablePut(sessionId: string, params: HttpRequest): HttpResponse {
    const session = this.resumableSessions.get(sessionId);
    if (!session) {
      return this.jsonResponse(404, { error: { code: 404, message: "Upload session not found" } });
    }
    this.resumableSessions.delete(sessionId);
    const fileBytes =
      params.body instanceof ArrayBuffer
        ? new Uint8Array(params.body.slice(0))
        : new TextEncoder().encode(params.body ?? "");
    this.resumableUploadCount += 1;
    return this.upsertUploadedFile(
      session.fileId,
      { name: session.name, mimeType: session.mimeType, parents: session.parents },
      fileBytes,
    );
  }

  private upsertUploadedFile(
    fileId: string | undefined,
    metadata: { name?: string; mimeType?: string; parents?: string[] },
    fileBytes: Uint8Array,
  ): HttpResponse {
    const modifiedTime = new Date(this.nowFn()).toISOString();
    const md5 = this.fakeMd5(fileBytes);
    if (fileId) {
      const existing = this.items.get(fileId);
      if (!existing || existing.trashed) {
        return this.jsonResponse(404, { error: { code: 404, message: "File not found" } });
      }
      if (metadata.name !== undefined) existing.name = metadata.name;
      existing.content = fileBytes.slice();
      existing.md5Checksum = md5;
      existing.modifiedTime = modifiedTime;
      return this.jsonResponse(200, this.toMetadataDto(existing));
    }

    const id = `drive-item-${++this.itemCounter}`;
    const item: FakeDriveItem = {
      id,
      name: metadata.name ?? "untitled",
      mimeType: metadata.mimeType ?? "application/octet-stream",
      parents: metadata.parents ?? [],
      content: fileBytes.slice(),
      md5Checksum: md5,
      modifiedTime,
      trashed: false,
    };
    this.items.set(id, item);
    return this.jsonResponse(200, this.toMetadataDto(item));
  }

  private fakeMd5(bytes: Uint8Array): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
      h1 ^= bytes[i];
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= bytes[i] + i;
      h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + bytes.length.toString(16).padStart(16, "0");
  }

  private parseMultipartRelated(
    raw: Uint8Array,
    boundary: string,
  ): { metadata: { name?: string; mimeType?: string; parents?: string[] }; fileBytes: Uint8Array } {
    const enc = new TextEncoder();
    const delim = enc.encode(`--${boundary}`);
    const crlfcrlf = enc.encode("\r\n\r\n");

    const findBytes = (haystack: Uint8Array, needle: Uint8Array, from = 0): number => {
      outer: for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    };

    const p1 = findBytes(raw, delim, 0);
    const p1HeaderEnd = findBytes(raw, crlfcrlf, p1 + delim.length);
    const p2 = findBytes(raw, delim, p1HeaderEnd + crlfcrlf.length);
    const metaBytes = raw.slice(p1HeaderEnd + crlfcrlf.length, p2 - 2); // strip trailing \r\n
    const metadata = JSON.parse(new TextDecoder().decode(metaBytes)) as {
      name?: string;
      mimeType?: string;
      parents?: string[];
    };

    const p2HeaderEnd = findBytes(raw, crlfcrlf, p2 + delim.length);
    const p3 = findBytes(raw, delim, p2HeaderEnd + crlfcrlf.length);
    const fileBytes = raw.slice(p2HeaderEnd + crlfcrlf.length, p3 - 2); // strip trailing \r\n
    return { metadata, fileBytes };
  }

  private jsonResponse(status: number, body: unknown): HttpResponse {
    const text = JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    return {
      status,
      headers: { "content-type": "application/json" },
      text,
      json: body,
      arrayBuffer: bytes.buffer,
    };
  }

  private binaryResponse(status: number, bytes: Uint8Array): HttpResponse {
    const copy = bytes.slice();
    return {
      status,
      headers: { "content-type": "application/octet-stream" },
      text: new TextDecoder().decode(copy),
      json: null,
      arrayBuffer: copy.buffer,
    };
  }
}
