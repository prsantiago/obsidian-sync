import type { ConfigBundle } from "./types";

const REQUIRED_FIELDS: ReadonlyArray<keyof ConfigBundle> = [
  "clientId",
  "clientSecret",
  "refreshToken",
  "rootFolderId",
  "rootFolderName",
];

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function decodeBase64Utf8(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Parses and validates a JSON or base64-encoded configuration bundle
 * produced by the Mac OAuth setup helper.
 */
export function parseConfigBundle(raw: string): ConfigBundle {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigValidationError("Invalid configuration bundle: input is empty.");
  }

  let jsonText = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      jsonText = decodeBase64Utf8(trimmed);
    } catch {
      throw new ConfigValidationError(
        "Invalid configuration bundle: expected JSON or base64-encoded JSON.",
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ConfigValidationError(
      "Invalid configuration bundle: malformed JSON payload.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigValidationError(
      "Invalid configuration bundle: payload must be a JSON object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const missing: string[] = [];

  for (const field of REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new ConfigValidationError(
      `Invalid configuration bundle: missing or empty required fields (${missing.join(", ")}).`,
    );
  }

  return {
    clientId: (record.clientId as string).trim(),
    clientSecret: (record.clientSecret as string).trim(),
    refreshToken: (record.refreshToken as string).trim(),
    rootFolderId: (record.rootFolderId as string).trim(),
    rootFolderName: (record.rootFolderName as string).trim(),
  };
}

/**
 * Masks a credential string for safe read-only display in Settings.
 */
export function maskCredential(value: string): string {
  if (value.length <= 8) {
    return "****";
  }
  return `${value.slice(0, 4)}...${value.slice(-3)}`;
}
