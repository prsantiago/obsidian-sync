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

export class FakeGoogleDriveHttp implements HttpTransport {
  private items = new Map<string, FakeDriveItem>();
  private validAccessTokens = new Map<string, number>(); // token -> expiresAt
  private tokenCounter = 0;
  private startPageToken = "100";
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
  }

  setStartPageToken(token: string): void {
    this.startPageToken = token;
  }

  async request(params: HttpRequest): Promise<HttpResponse> {
    if (params.url === GOOGLE_OAUTH_TOKEN_URL && params.method === "POST") {
      return this.handleTokenRefresh(params);
    }

    if (params.url.startsWith(GOOGLE_DRIVE_API_BASE)) {
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

      const url = new URL(params.url);
      if (url.pathname === "/drive/v3/files" && (params.method ?? "GET") === "GET") {
        return this.handleFilesList(url);
      }

      if (url.pathname === "/drive/v3/changes/startPageToken" && (params.method ?? "GET") === "GET") {
        return this.jsonResponse(200, { startPageToken: this.startPageToken });
      }

      const fileGetMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (fileGetMatch && (params.method ?? "GET") === "GET" && url.searchParams.get("alt") === "media") {
        const fileId = decodeURIComponent(fileGetMatch[1]);
        const item = this.items.get(fileId);
        if (!item || !item.content) {
          return this.jsonResponse(404, { error: { code: 404, message: "File not found" } });
        }
        return this.binaryResponse(200, item.content);
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
      files: slice.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        parents: item.parents,
        ...(item.md5Checksum ? { md5Checksum: item.md5Checksum } : {}),
        modifiedTime: item.modifiedTime,
        ...(item.content ? { size: String(item.content.byteLength) } : {}),
      })),
    });
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
