/**
 * Computes a deterministic 64-bit FNV-1a content hash hex string for binary or text payloads.
 * Pure TypeScript with zero Node.js built-ins for cross-platform Obsidian compatibility.
 */
export function computeContentHash(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i];
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= bytes[i] + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0") +
    h2.toString(16).padStart(8, "0") +
    bytes.length.toString(16).padStart(8, "0")
  );
}

/**
 * Compares two binary payloads byte-for-byte.
 */
export function bytesEqual(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const va = a instanceof Uint8Array ? a : new Uint8Array(a);
  const vb = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (va.byteLength !== vb.byteLength) {
    return false;
  }
  for (let i = 0; i < va.byteLength; i++) {
    if (va[i] !== vb[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Formats a millisecond timestamp as `YYYY-MM-DD HH-MM` in UTC for conflict filenames.
 */
export function formatConflictTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}`;
}

/**
 * Builds a conflict copy path beside `originalPath`:
 * `<basename> (conflict YYYY-MM-DD HH-MM)<ext>`, with ` (<attempt>)` when `attempt >= 2`.
 */
export function buildConflictCandidatePath(
  originalPath: string,
  timestampStr: string,
  attempt = 1,
): string {
  const slashIdx = originalPath.lastIndexOf("/");
  const dir = slashIdx >= 0 ? originalPath.slice(0, slashIdx + 1) : "";
  const filename = slashIdx >= 0 ? originalPath.slice(slashIdx + 1) : originalPath;
  const dotIdx = filename.lastIndexOf(".");
  const hasExt = dotIdx > 0;
  const basename = hasExt ? filename.slice(0, dotIdx) : filename;
  const ext = hasExt ? filename.slice(dotIdx) : "";
  const suffix = attempt > 1 ? ` (${attempt})` : "";
  return `${dir}${basename} (conflict ${timestampStr})${suffix}${ext}`;
}
