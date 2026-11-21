import {
  GOOGLE_OAUTH_TOKEN_URL,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type NoticeSink,
  type OAuthCredentials,
} from "./types";

const EXPIRY_BUFFER_MS = 60_000;

export class TerminalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalAuthError";
  }
}

export class OAuthTokenManager {
  private readonly http: HttpTransport;
  private readonly notice: NoticeSink;
  private readonly clock: Clock;
  private readonly getCredentials: () => OAuthCredentials | null;
  private readonly onTokenUpdated: (creds: OAuthCredentials) => Promise<void>;
  private inflightRefresh: Promise<string> | null = null;

  constructor(opts: {
    http: HttpTransport;
    notice: NoticeSink;
    clock: Clock;
    getCredentials: () => OAuthCredentials | null;
    onTokenUpdated: (creds: OAuthCredentials) => Promise<void>;
  }) {
    this.http = opts.http;
    this.notice = opts.notice;
    this.clock = opts.clock;
    this.getCredentials = opts.getCredentials;
    this.onTokenUpdated = opts.onTokenUpdated;
  }

  /**
   * Returns a valid access token, proactively refreshing if missing or near expiry.
   */
  async getValidAccessToken(forceRefresh = false): Promise<string> {
    const creds = this.getCredentials();
    if (!creds) {
      throw new TerminalAuthError("Google Drive is not connected.");
    }

    const hasValidToken =
      !forceRefresh &&
      typeof creds.accessToken === "string" &&
      creds.accessToken.length > 0 &&
      typeof creds.expiresAt === "number" &&
      this.clock.now() + EXPIRY_BUFFER_MS < creds.expiresAt;

    if (hasValidToken && creds.accessToken) {
      return creds.accessToken;
    }

    if (!this.inflightRefresh) {
      this.inflightRefresh = this.refreshAccessToken(creds).finally(() => {
        this.inflightRefresh = null;
      });
    }

    return this.inflightRefresh;
  }

  /**
   * Executes an HTTP request with Bearer auth and reactively retries once on HTTP 401.
   */
  async authorizedRequest(req: HttpRequest): Promise<HttpResponse> {
    const token = await this.getValidAccessToken(false);
    const firstResponse = await this.http.request({
      ...req,
      throw: false,
      headers: {
        ...req.headers,
        Authorization: `Bearer ${token}`,
      },
    });

    if (firstResponse.status !== 401) {
      return firstResponse;
    }

    const refreshedToken = await this.getValidAccessToken(true);
    return this.http.request({
      ...req,
      throw: false,
      headers: {
        ...req.headers,
        Authorization: `Bearer ${refreshedToken}`,
      },
    });
  }

  private async refreshAccessToken(creds: OAuthCredentials): Promise<string> {
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }).toString();

    const response = await this.http.request({
      url: GOOGLE_OAUTH_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      throw: false,
    });

    if (response.status >= 200 && response.status < 300) {
      const payload = response.json as {
        access_token?: string;
        expires_in?: number;
      };
      if (!payload?.access_token) {
        throw new Error("OAuth token refresh response did not include access_token.");
      }
      const expiresInSec = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
      const updated: OAuthCredentials = {
        ...creds,
        accessToken: payload.access_token,
        expiresAt: this.clock.now() + expiresInSec * 1000,
      };
      await this.onTokenUpdated(updated);
      return payload.access_token;
    }

    const errPayload = (response.json ?? {}) as { error?: string; error_description?: string };
    if (errPayload.error === "invalid_grant" || response.status === 401) {
      const msg =
        "Google Drive authentication expired or was revoked (invalid_grant). Please re-import your configuration bundle in Settings.";
      this.notice.show(msg, 0);
      throw new TerminalAuthError(msg);
    }

    throw new Error(
      `OAuth token refresh failed with HTTP ${response.status}: ${errPayload.error ?? response.text}`,
    );
  }
}
