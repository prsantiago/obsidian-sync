export interface ConfigBundle {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId: string;
  rootFolderName: string;
}

export interface OAuthCredentials extends ConfigBundle {
  accessToken?: string;
  expiresAt?: number;
}

export interface SyncIndexEntry {
  path: string;
  driveId: string;
  parentId: string;
  md5Checksum: string | null;
  localMtime: number;
  remoteModifiedTime: string;
  type: "file" | "folder";
}

export interface PluginData {
  credentials: OAuthCredentials | null;
  syncIndex: Record<string, SyncIndexEntry>;
  startPageToken: string | null;
}

export interface ConnectionInfo {
  connected: boolean;
  rootFolderName: string | null;
  rootFolderId: string | null;
  maskedClientId: string | null;
  credentialStatus: "connected" | "disconnected";
}

export interface VaultStat {
  type: "file" | "folder";
  mtime: number;
  size: number;
}

export interface VaultPort {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<VaultStat>;
  readBinary(path: string): Promise<ArrayBuffer>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string, recursive: boolean): Promise<void>;
  stat(path: string): Promise<VaultStat | null>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  loadPluginData(): Promise<unknown>;
  savePluginData(data: unknown): Promise<void>;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export interface HttpTransport {
  request(params: HttpRequest): Promise<HttpResponse>;
}

export interface NoticeSink {
  show(message: string, durationMs?: number): void;
}

export interface Clock {
  now(): number;
}

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
export const GOOGLE_APPS_MIME_PREFIX = "application/vnd.google-apps.";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
