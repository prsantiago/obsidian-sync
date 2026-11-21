import { Notice, type Plugin, requestUrl } from "obsidian";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  NoticeSink,
  VaultPort,
  VaultStat,
} from "./types";

/**
 * Wraps Obsidian's Vault DataAdapter and Plugin private data storage.
 */
export class ObsidianVaultAdapter implements VaultPort {
  private readonly plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  private get adapter() {
    return this.plugin.app.vault.adapter;
  }

  async exists(path: string): Promise<boolean> {
    return this.adapter.exists(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.adapter.mkdir(path);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<VaultStat> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent && !(await this.adapter.exists(parent))) {
      await this.adapter.mkdir(parent);
    }
    await this.adapter.writeBinary(path, data);
    const st = await this.adapter.stat(path);
    return {
      type: "file",
      mtime: st?.mtime ?? Date.now(),
      size: st?.size ?? data.byteLength,
    };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(path);
  }

  async stat(path: string): Promise<VaultStat | null> {
    const st = await this.adapter.stat(path);
    if (!st) return null;
    return {
      type: st.type,
      mtime: st.mtime,
      size: st.size,
    };
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(path);
  }

  async loadPluginData(): Promise<unknown> {
    return this.plugin.loadData();
  }

  async savePluginData(data: unknown): Promise<void> {
    await this.plugin.saveData(data);
  }
}

/**
 * Wraps Obsidian's cross-platform requestUrl (works on iOS WKWebView & desktop).
 */
export class ObsidianHttpTransport implements HttpTransport {
  async request(params: HttpRequest): Promise<HttpResponse> {
    const res = await requestUrl({
      url: params.url,
      method: params.method ?? "GET",
      headers: params.headers,
      body: params.body,
      throw: false,
    });

    let parsedJson: unknown = null;
    try {
      parsedJson = res.json;
    } catch {
      parsedJson = null;
    }

    return {
      status: res.status,
      headers: res.headers,
      text: res.text,
      json: parsedJson,
      arrayBuffer: res.arrayBuffer,
    };
  }
}

/**
 * Wraps Obsidian's native Notice toast.
 */
export class ObsidianNoticeSink implements NoticeSink {
  show(message: string, durationMs?: number): void {
    new Notice(message, durationMs);
  }
}
