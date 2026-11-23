const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0,
);

function wordToHexLE(w: number): string {
  let hex = "";
  for (let j = 0; j < 4; j++) {
    hex += ((w >>> (j * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Computes an RFC 1321 MD5 digest as a 32-character lowercase hexadecimal string
 * matching Google Drive's `md5Checksum`.
 * Pure TypeScript with zero Node.js built-ins for cross-platform Obsidian compatibility.
 */
export function computeMd5Hex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const byteLen = bytes.byteLength;
  const totalBlocks = ((byteLen + 8) >>> 6) + 1;
  const totalWords = totalBlocks * 16;
  const words = new Uint32Array(totalWords);

  for (let i = 0; i < byteLen; i++) {
    words[i >>> 2] |= bytes[i] << ((i & 3) * 8);
  }
  words[byteLen >>> 2] |= 0x80 << ((byteLen & 3) * 8);
  words[totalWords - 2] = (byteLen << 3) >>> 0;
  words[totalWords - 1] = (byteLen >>> 29) >>> 0;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < totalWords; offset += 16) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const temp = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_K[i] + words[offset + g]) | 0;
      const rotated = (sum << MD5_S[i]) | (sum >>> (32 - MD5_S[i]));
      b = (b + rotated) | 0;
      a = temp;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return wordToHexLE(a0) + wordToHexLE(b0) + wordToHexLE(c0) + wordToHexLE(d0);
}

/**
 * Computes the lowercase 32-char hex MD5 content hash matching Google Drive's `md5Checksum`.
 */
export function computeContentHash(data: ArrayBuffer | Uint8Array): string {
  return computeMd5Hex(data);
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
