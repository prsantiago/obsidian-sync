import { Plugin, TFolder } from "obsidian";
import {
  ObsidianHttpTransport,
  ObsidianNoticeSink,
  ObsidianVaultAdapter,
} from "./obsidian-adapters";
import { GoogleDriveSyncSettingTab } from "./settings-tab";
import { SyncPluginCore } from "./sync-plugin-core";

export default class GoogleDriveSyncPlugin extends Plugin {
  private core!: SyncPluginCore;

  async onload(): Promise<void> {
    this.core = new SyncPluginCore({
      vault: new ObsidianVaultAdapter(this),
      http: new ObsidianHttpTransport(),
      notice: new ObsidianNoticeSink(),
    });

    await this.core.load();
    this.addSettingTab(new GoogleDriveSyncSettingTab(this.app, this, this.core));

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.core.syncNow();
      },
    });

    if (typeof document !== "undefined") {
      this.registerDomEvent(document, "visibilitychange", () => {
        void this.core.handleVisibilityChange(document.visibilityState === "visible");
      });
    }

    if (typeof window !== "undefined") {
      this.registerDomEvent(window, "online", () => {
        void this.core.handleOnline();
      });
    }

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          this.core.onVaultCreate(file.path, file instanceof TFolder ? "folder" : "file");
        }),
      );
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          this.core.onVaultModify(file.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          this.core.onVaultRename(oldPath, file.path, file instanceof TFolder ? "folder" : "file");
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          this.core.onVaultDelete(file.path);
        }),
      );
    });
  }

  onunload(): void {
    this.core?.unload();
  }
}
