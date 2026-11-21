import { describe, expect, it } from "vitest";
import { parseConfigBundle } from "../src/config-bundle";
import { GOOGLE_FOLDER_MIME } from "../src/types";
import { FakeGoogleDriveHttp } from "./fakes/fake-drive-http";
import {
  encodeConfigBundleBase64,
  runOAuthSetup,
  type LoopbackCallbackResult,
  type LoopbackServerPort,
} from "../cli/setup-runner";

class FakeLoopbackServer implements LoopbackServerPort {
  public started = false;
  public closed = false;
  public redirectUri = "http://127.0.0.1:49152/callback";
  private nextResult: LoopbackCallbackResult | ((authUrl: string) => LoopbackCallbackResult);

  constructor(
    nextResult: LoopbackCallbackResult | ((authUrl: string) => LoopbackCallbackResult),
  ) {
    this.nextResult = nextResult;
  }

  public capturedAuthUrl: string | null = null;

  async start(): Promise<{ redirectUri: string }> {
    this.started = true;
    return { redirectUri: this.redirectUri };
  }

  async waitForCallback(): Promise<LoopbackCallbackResult> {
    if (typeof this.nextResult === "function") {
      return this.nextResult(this.capturedAuthUrl ?? "");
    }
    return this.nextResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("Mac OAuth Setup CLI (Secondary Seam)", () => {
  it("completes loopback OAuth, exchanges code for refresh_token, resolves gd-sb-chachin folder ID, and emits a bundle accepted by parseConfigBundle", async () => {
    const fakeHttp = new FakeGoogleDriveHttp();
    fakeHttp.validAuthCode = "auth-code-123";
    fakeHttp.seedFolder("folder-gd-sb", "gd-sb-chachin", "root");
    fakeHttp.seedFolder("folder-other", "Other Folder", "root");

    const loopback = new FakeLoopbackServer((authUrl) => {
      const parsed = new URL(authUrl);
      return {
        code: "auth-code-123",
        state: parsed.searchParams.get("state") ?? undefined,
      };
    });

    const openedUrls: string[] = [];
    const logs: string[] = [];

    const result = await runOAuthSetup(
      {
        argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"],
        env: {},
      },
      {
        http: fakeHttp,
        createLoopbackServer: () => loopback,
        openBrowser: async (url) => {
          loopback.capturedAuthUrl = url;
          openedUrls.push(url);
        },
        prompt: async () => {
          throw new Error("Should not prompt when flags and single folder match are present");
        },
        log: (line) => logs.push(line),
      },
    );

    expect(loopback.started).toBe(true);
    expect(loopback.closed).toBe(true);
    expect(openedUrls).toHaveLength(1);

    const authUrl = new URL(openedUrls[0]);
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe("test-client-id");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:49152/callback");
    expect(authUrl.searchParams.get("response_type")).toBe("code");
    expect(authUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("state")).toBeTruthy();

    expect(result.bundle).toEqual({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "test-refresh-token",
      rootFolderId: "folder-gd-sb",
      rootFolderName: "gd-sb-chachin",
    });

    // Round-trip check against plugin's Settings importer
    const parsedFromJson = parseConfigBundle(JSON.stringify(result.bundle));
    expect(parsedFromJson).toEqual(result.bundle);

    const base64Bundle = encodeConfigBundleBase64(result.bundle);
    const parsedFromBase64 = parseConfigBundle(base64Bundle);
    expect(parsedFromBase64).toEqual(result.bundle);

    expect(result.base64Bundle).toBe(base64Bundle);
    expect(GOOGLE_FOLDER_MIME).toBe("application/vnd.google-apps.folder");
  });

  it("supports environment variables and interactive prompts for missing credentials and custom folder name", async () => {
    const fakeHttp = new FakeGoogleDriveHttp();
    fakeHttp.validClientId = "env-client-id";
    fakeHttp.validClientSecret = "prompted-secret";
    fakeHttp.validAuthCode = "code-456";
    fakeHttp.seedFolder("folder-custom", "my-custom-vault", "root");

    const loopback = new FakeLoopbackServer((authUrl) => ({
      code: "code-456",
      state: new URL(authUrl).searchParams.get("state") ?? undefined,
    }));

    const prompts: string[] = [];
    const result = await runOAuthSetup(
      {
        argv: [],
        env: {
          GOOGLE_CLIENT_ID: "env-client-id",
          GOOGLE_DRIVE_FOLDER_NAME: "my-custom-vault",
        },
      },
      {
        http: fakeHttp,
        createLoopbackServer: () => loopback,
        openBrowser: async (url) => {
          loopback.capturedAuthUrl = url;
        },
        prompt: async (question) => {
          prompts.push(question);
          return "prompted-secret";
        },
      },
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Client Secret");
    expect(result.bundle.rootFolderId).toBe("folder-custom");
    expect(result.bundle.rootFolderName).toBe("my-custom-vault");
    expect(parseConfigBundle(result.jsonBundle)).toEqual(result.bundle);
  });

  it("throws a clear error when target folder is not found (or only trashed)", async () => {
    const fakeHttp = new FakeGoogleDriveHttp();
    fakeHttp.validAuthCode = "auth-code-123";
    fakeHttp.seedFolder("folder-trashed", "gd-sb-chachin", "root", "2026-01-01T00:00:00.000Z", true);

    const loopback = new FakeLoopbackServer((authUrl) => ({
      code: "auth-code-123",
      state: new URL(authUrl).searchParams.get("state") ?? undefined,
    }));

    await expect(
      runOAuthSetup(
        { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
        {
          http: fakeHttp,
          createLoopbackServer: () => loopback,
          openBrowser: async (url) => {
            loopback.capturedAuthUrl = url;
          },
          prompt: async () => "",
        },
      ),
    ).rejects.toThrow(/not found/i);
    expect(loopback.closed).toBe(true);
  });

  it("disambiguates when multiple folders match by name and rejects invalid selection", async () => {
    const fakeHttp = new FakeGoogleDriveHttp();
    fakeHttp.validAuthCode = "auth-code-123";
    fakeHttp.seedFolder("folder-1", "gd-sb-chachin", "parent-a");
    fakeHttp.seedFolder("folder-2", "gd-sb-chachin", "parent-b");

    const loopback1 = new FakeLoopbackServer((authUrl) => ({
      code: "auth-code-123",
      state: new URL(authUrl).searchParams.get("state") ?? undefined,
    }));
    const logs: string[] = [];

    const result = await runOAuthSetup(
      { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
      {
        http: fakeHttp,
        createLoopbackServer: () => loopback1,
        openBrowser: async (url) => {
          loopback1.capturedAuthUrl = url;
        },
        prompt: async () => "2",
        log: (line) => logs.push(line),
      },
    );

    expect(result.bundle.rootFolderId).toBe("folder-2");
    expect(logs.some((line) => line.includes("folder-1") && line.includes("parent-a"))).toBe(true);
    expect(logs.some((line) => line.includes("folder-2") && line.includes("parent-b"))).toBe(true);

    const loopback2 = new FakeLoopbackServer((authUrl) => ({
      code: "auth-code-123",
      state: new URL(authUrl).searchParams.get("state") ?? undefined,
    }));

    await expect(
      runOAuthSetup(
        { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
        {
          http: fakeHttp,
          createLoopbackServer: () => loopback2,
          openBrowser: async (url) => {
            loopback2.capturedAuthUrl = url;
          },
          prompt: async () => "99",
        },
      ),
    ).rejects.toThrow(/Invalid folder selection/i);
  });

  it("fails clearly on OAuth callback error, state mismatch, or missing refresh_token and always closes loopback server", async () => {
    const fakeHttp = new FakeGoogleDriveHttp();
    fakeHttp.validAuthCode = "auth-code-123";
    fakeHttp.seedFolder("folder-gd-sb", "gd-sb-chachin", "root");

    const deniedLoopback = new FakeLoopbackServer({ error: "access_denied" });
    await expect(
      runOAuthSetup(
        { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
        {
          http: fakeHttp,
          createLoopbackServer: () => deniedLoopback,
          openBrowser: async () => {},
          prompt: async () => "",
        },
      ),
    ).rejects.toThrow(/access_denied/);
    expect(deniedLoopback.closed).toBe(true);

    const mismatchLoopback = new FakeLoopbackServer({
      code: "auth-code-123",
      state: "wrong-state",
    });
    await expect(
      runOAuthSetup(
        { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
        {
          http: fakeHttp,
          createLoopbackServer: () => mismatchLoopback,
          openBrowser: async () => {},
          prompt: async () => "",
          generateState: () => "expected-state",
        },
      ),
    ).rejects.toThrow(/state mismatch/i);
    expect(mismatchLoopback.closed).toBe(true);

    fakeHttp.omitRefreshTokenOnCodeExchange = true;
    const noRefreshLoopback = new FakeLoopbackServer((authUrl) => ({
      code: "auth-code-123",
      state: new URL(authUrl).searchParams.get("state") ?? undefined,
    }));
    await expect(
      runOAuthSetup(
        { argv: ["--client-id", "test-client-id", "--client-secret", "test-client-secret"] },
        {
          http: fakeHttp,
          createLoopbackServer: () => noRefreshLoopback,
          openBrowser: async (url) => {
            noRefreshLoopback.capturedAuthUrl = url;
          },
          prompt: async () => "",
        },
      ),
    ).rejects.toThrow(/missing refresh_token/i);
  });
});
