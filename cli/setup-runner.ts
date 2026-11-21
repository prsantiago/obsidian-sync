import {
  GOOGLE_DRIVE_API_BASE,
  GOOGLE_FOLDER_MIME,
  GOOGLE_OAUTH_TOKEN_URL,
  type ConfigBundle,
  type HttpTransport,
} from "../src/types";

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const DEFAULT_TARGET_FOLDER_NAME = "gd-sb-chachin";

export interface LoopbackCallbackResult {
  code?: string;
  state?: string;
  error?: string;
}

export interface LoopbackServerPort {
  start(): Promise<{ redirectUri: string }>;
  waitForCallback(): Promise<LoopbackCallbackResult>;
  close(): Promise<void>;
}

export interface SetupCliDependencies {
  http: HttpTransport;
  createLoopbackServer: () => LoopbackServerPort;
  openBrowser: (url: string) => Promise<void>;
  prompt: (question: string) => Promise<string>;
  log?: (line: string) => void;
  generateState?: () => string;
}

export interface SetupCliOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

export interface SetupCliResult {
  bundle: ConfigBundle;
  jsonBundle: string;
  base64Bundle: string;
}

export interface ParsedCliFlags {
  clientId?: string;
  clientSecret?: string;
  folderName?: string;
  help: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliFlags {
  const result: ParsedCliFlags = { help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--client-id" && i + 1 < argv.length) {
      result.clientId = argv[++i];
    } else if (arg.startsWith("--client-id=")) {
      result.clientId = arg.slice("--client-id=".length);
    } else if (arg === "--client-secret" && i + 1 < argv.length) {
      result.clientSecret = argv[++i];
    } else if (arg.startsWith("--client-secret=")) {
      result.clientSecret = arg.slice("--client-secret=".length);
    } else if ((arg === "--folder-name" || arg === "--folder") && i + 1 < argv.length) {
      result.folderName = argv[++i];
    } else if (arg.startsWith("--folder-name=")) {
      result.folderName = arg.slice("--folder-name=".length);
    } else if (arg.startsWith("--folder=")) {
      result.folderName = arg.slice("--folder=".length);
    }
  }

  return result;
}

export function encodeConfigBundleBase64(bundle: ConfigBundle): string {
  const json = JSON.stringify(bundle);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function defaultState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function resolveInputs(
  options: SetupCliOptions,
  prompt: (question: string) => Promise<string>,
): Promise<{ clientId: string; clientSecret: string; folderName: string }> {
  const flags = parseCliArgs(options.argv ?? []);
  const env = options.env ?? {};

  let clientId = (flags.clientId ?? env.GOOGLE_CLIENT_ID ?? "").trim();
  if (!clientId) {
    clientId = (await prompt("Google Cloud OAuth Client ID: ")).trim();
  }
  if (!clientId) {
    throw new Error("Google Cloud OAuth clientId is required.");
  }

  let clientSecret = (flags.clientSecret ?? env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientSecret) {
    clientSecret = (await prompt("Google Cloud OAuth Client Secret: ")).trim();
  }
  if (!clientSecret) {
    throw new Error("Google Cloud OAuth clientSecret is required.");
  }

  const folderName = (
    flags.folderName ??
    env.GOOGLE_DRIVE_FOLDER_NAME ??
    env.OBSIDIAN_SYNC_FOLDER_NAME ??
    DEFAULT_TARGET_FOLDER_NAME
  ).trim();

  if (!folderName) {
    throw new Error("Target Google Drive folder name cannot be empty.");
  }

  return { clientId, clientSecret, folderName };
}

export function buildOAuthAuthorizationUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_OAUTH_AUTH_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_DRIVE_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function exchangeAuthCode(
  http: HttpTransport,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
  }).toString();

  const res = await http.request({
    url: GOOGLE_OAUTH_TOKEN_URL,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    throw: false,
  });

  if (res.status !== 200) {
    const errPayload = res.json as { error?: string; error_description?: string } | null;
    const detail = errPayload?.error_description ?? errPayload?.error ?? res.text;
    throw new Error(`OAuth token exchange failed (${res.status}): ${detail}`);
  }

  const data = res.json as { access_token?: string; refresh_token?: string } | null;
  if (!data?.access_token) {
    throw new Error("OAuth token response missing access_token.");
  }
  if (!data.refresh_token) {
    throw new Error(
      "OAuth token response missing refresh_token. Ensure prompt=consent and revoke prior app access in Google Account permissions if retrying.",
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

interface DriveFolderCandidate {
  id: string;
  name: string;
  parents?: string[];
}

async function resolveTargetFolder(
  http: HttpTransport,
  accessToken: string,
  folderName: string,
  prompt: (question: string) => Promise<string>,
  log: (line: string) => void,
): Promise<{ id: string; name: string }> {
  const escaped = escapeDriveQueryValue(folderName);
  const query = `mimeType = '${GOOGLE_FOLDER_MIME}' and name = '${escaped}' and trashed = false`;
  const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
  url.searchParams.set("q", query);
  url.searchParams.set("fields", "files(id,name,parents)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const res = await http.request({
    url: url.toString(),
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    throw: false,
  });

  if (res.status !== 200) {
    throw new Error(`Google Drive folder search failed (${res.status}): ${res.text}`);
  }

  const payload = res.json as { files?: DriveFolderCandidate[] } | null;
  const matches = payload?.files ?? [];

  if (matches.length === 0) {
    throw new Error(
      `Target folder "${folderName}" was not found in Google Drive (non-trashed).`,
    );
  }

  if (matches.length === 1) {
    return { id: matches[0].id, name: matches[0].name };
  }

  log(`Multiple folders named "${folderName}" found in Google Drive:`);
  matches.forEach((folder, idx) => {
    const parentInfo = folder.parents?.length ? ` (parents: ${folder.parents.join(", ")})` : "";
    log(`  [${idx + 1}] id=${folder.id}${parentInfo}`);
  });

  const answer = (
    await prompt(`Select folder number (1-${matches.length}): `)
  ).trim();
  const choice = Number.parseInt(answer, 10);
  if (!Number.isInteger(choice) || choice < 1 || choice > matches.length) {
    throw new Error(`Invalid folder selection "${answer}". Expected 1-${matches.length}.`);
  }

  const selected = matches[choice - 1];
  return { id: selected.id, name: selected.name };
}

/**
 * Runs the Mac one-time OAuth setup flow using injected ports for
 * loopback HTTP callback, browser launch, interactive prompt, and HTTP transport.
 */
export async function runOAuthSetup(
  options: SetupCliOptions,
  deps: SetupCliDependencies,
): Promise<SetupCliResult> {
  const log = deps.log ?? (() => {});
  const { clientId, clientSecret, folderName } = await resolveInputs(options, deps.prompt);

  const loopback = deps.createLoopbackServer();
  const { redirectUri } = await loopback.start();

  let code: string;
  try {
    const expectedState = (deps.generateState ?? defaultState)();
    const authUrl = buildOAuthAuthorizationUrl({
      clientId,
      redirectUri,
      state: expectedState,
    });

    log(`Opening browser for Google OAuth authorization...`);
    await deps.openBrowser(authUrl);

    const callback = await loopback.waitForCallback();
    if (callback.error) {
      throw new Error(`Google OAuth returned error: ${callback.error}`);
    }
    if (callback.state !== expectedState) {
      throw new Error("OAuth state mismatch on loopback callback.");
    }
    if (!callback.code) {
      throw new Error("OAuth callback did not include an authorization code.");
    }
    code = callback.code;
  } finally {
    await loopback.close();
  }

  const tokens = await exchangeAuthCode(deps.http, {
    code,
    clientId,
    clientSecret,
    redirectUri,
  });

  const folder = await resolveTargetFolder(
    deps.http,
    tokens.accessToken,
    folderName,
    deps.prompt,
    log,
  );

  const bundle: ConfigBundle = {
    clientId,
    clientSecret,
    refreshToken: tokens.refreshToken,
    rootFolderId: folder.id,
    rootFolderName: folder.name,
  };

  const jsonBundle = JSON.stringify(bundle);
  const base64Bundle = encodeConfigBundleBase64(bundle);

  log("\nSetup complete! Copy-paste this configuration bundle into the Obsidian plugin Settings:\n");
  log(base64Bundle);
  log("\n(Or JSON format):");
  log(jsonBundle);

  return {
    bundle,
    jsonBundle,
    base64Bundle,
  };
}
