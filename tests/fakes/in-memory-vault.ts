import type { VaultPort, VaultStat } from "../../src/types";

interface StoredFile {
  data: Uint8Array;
  mtime: number;
}

export class InMemoryVaultPort implements VaultPort {
  private files = new Map<string, StoredFile>();
  private folders = new Set<string>();
  private pluginData: unknown = null;
  private nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  private normalizePath(path: string): string {
    return path.replace(/^\/+|\/+$/g, "");
  }

  async exists(path: string): Promise<boolean> {
    const norm = this.normalizePath(path);
    if (!norm) return true;
    return this.files.has(norm) || this.folders.has(norm);
  }

  async mkdir(path: string): Promise<void> {
    const norm = this.normalizePath(path);
    if (!norm) return;
    const parts = norm.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.folders.add(current);
    }
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<VaultStat> {
    const norm = this.normalizePath(path);
    const parent = norm.includes("/") ? norm.slice(0, norm.lastIndexOf("/")) : "";
    if (parent) {
      await this.mkdir(parent);
    }
    const copy = new Uint8Array(data.slice(0));
    const mtime = this.nowFn();
    this.files.set(norm, { data: copy, mtime });
    return { type: "file", mtime, size: copy.byteLength };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const norm = this.normalizePath(path);
    const entry = this.files.get(norm);
    if (!entry) {
      throw new Error(`File not found in vault: ${norm}`);
    }
    return entry.data.slice().buffer;
  }

  async stat(path: string): Promise<VaultStat | null> {
    const norm = this.normalizePath(path);
    const file = this.files.get(norm);
    if (file) {
      return { type: "file", mtime: file.mtime, size: file.data.byteLength };
    }
    if (this.folders.has(norm)) {
      return { type: "folder", mtime: 0, size: 0 };
    }
    return null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const norm = this.normalizePath(path);
    const prefix = norm ? `${norm}/` : "";
    const files: string[] = [];
    const folders: string[] = [];

    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        if (!rest.includes("/")) {
          files.push(filePath);
        }
      }
    }

    for (const folderPath of this.folders) {
      if (folderPath.startsWith(prefix)) {
        const rest = folderPath.slice(prefix.length);
        if (rest && !rest.includes("/")) {
          folders.push(folderPath);
        }
      }
    }

    return { files: files.sort(), folders: folders.sort() };
  }

  async loadPluginData(): Promise<unknown> {
    if (this.pluginData === null || this.pluginData === undefined) {
      return null;
    }
    return JSON.parse(JSON.stringify(this.pluginData));
  }

  async savePluginData(data: unknown): Promise<void> {
    this.pluginData = JSON.parse(JSON.stringify(data));
  }

  // Test helper methods for inspecting vault state at the outer boundary
  readTextSync(path: string): string {
    const norm = this.normalizePath(path);
    const entry = this.files.get(norm);
    if (!entry) {
      throw new Error(`File not found in vault: ${norm}`);
    }
    return new TextDecoder().decode(entry.data);
  }

  readBytesSync(path: string): Uint8Array {
    const norm = this.normalizePath(path);
    const entry = this.files.get(norm);
    if (!entry) {
      throw new Error(`File not found in vault: ${norm}`);
    }
    return entry.data.slice();
  }

  listAllFilePaths(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  listAllFolderPaths(): string[] {
    return Array.from(this.folders).sort();
  }

  simulateRename(oldPath: string, newPath: string): void {
    const oldNorm = this.normalizePath(oldPath);
    const newNorm = this.normalizePath(newPath);

    const file = this.files.get(oldNorm);
    if (file) {
      this.files.delete(oldNorm);
      this.files.set(newNorm, file);
      return;
    }

    if (this.folders.has(oldNorm)) {
      this.folders.delete(oldNorm);
      this.folders.add(newNorm);
      const oldPrefix = `${oldNorm}/`;
      const newPrefix = `${newNorm}/`;
      for (const [k, v] of Array.from(this.files.entries())) {
        if (k.startsWith(oldPrefix)) {
          this.files.delete(k);
          this.files.set(newPrefix + k.slice(oldPrefix.length), v);
        }
      }
      for (const f of Array.from(this.folders)) {
        if (f.startsWith(oldPrefix)) {
          this.folders.delete(f);
          this.folders.add(newPrefix + f.slice(oldPrefix.length));
        }
      }
    }
  }
}
