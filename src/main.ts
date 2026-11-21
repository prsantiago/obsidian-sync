import { Plugin } from "obsidian";
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

    if (typeof document !== "undefined") {
      this.registerDomEvent(document, "visibilitychange", () => {
        void this.core.handleVisibilityChange(document.visibilityState === "visible");
      });
    }
  }

  onunload(): void {
    this.core?.unload();
  }
}
