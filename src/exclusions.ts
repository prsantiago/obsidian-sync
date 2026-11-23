import { GOOGLE_APPS_MIME_PREFIX, GOOGLE_FOLDER_MIME } from "./types";

const EXCLUDED_ROOT_DIRS = new Set([".obsidian", ".trash"]);

/**
 * Returns true if a vault-relative path must be excluded from sync:
 * - `.obsidian` or anything under `.obsidian/`
 * - `.trash` or anything under `.trash/`
 * - `.DS_Store` at root or in any nested folder
 */
export function isExcludedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+|\/+$/g, "");
  if (!normalized) return false;

  const segments = normalized.split("/");
  if (EXCLUDED_ROOT_DIRS.has(segments[0])) {
    return true;
  }

  return segments.some((segment) => segment === ".DS_Store");
}

/**
 * Returns true for non-syncable Google Workspace native files (Docs, Sheets, Slides, etc.),
 * while returning false for Google Drive folders.
 */
export function isGoogleWorkspaceNativeMime(mimeType: string): boolean {
  if (mimeType === GOOGLE_FOLDER_MIME) {
    return false;
  }
  return mimeType.startsWith(GOOGLE_APPS_MIME_PREFIX);
}
