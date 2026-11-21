# Obsidian Google Drive Sync

Cross-platform (`isDesktopOnly: false`) Obsidian plugin that automatically syncs a local Obsidian vault (including **"On My iPhone"** on iOS) directly with a Google Drive folder using the Google Drive REST API v3—with zero subscription fees, zero third-party servers, and zero Node.js built-ins.

## How It Works

- **Hybrid macOS + iOS coexistence:** Keep opening `My Drive/gd-sb-chachin` on macOS via Google Drive for Desktop while iOS syncs its local vault directly against the same Google Drive folder ID.
- **Automatic two-way sync:** Local edits push ~500 ms after Obsidian writes them to disk (plus an immediate flush when switching apps or locking the screen via `visibilitychange`), and remote changes pull on app open, foreground resume, and every 30 seconds via Google Drive `changes.list`.
- **Safe data rules:** Edit-vs-edit collisions create conflict copies, deletions use Google Drive Trash (30-day recovery) with delete-beats-edit, and `.obsidian/` is excluded from sync.
- **Quiet UX:** Silent when healthy; native Obsidian `Notice` toasts and an in-settings error log appear only when errors occur.

---

## One-Time Setup Guide

### 1. Create a Free Google Cloud OAuth "Desktop app" Client

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (e.g., `obsidian-gdrive-sync`).
2. Enable the **Google Drive API** (*APIs & Services → Library → Google Drive API → Enable*).
3. Configure the **OAuth consent screen**:
   - Choose **External** user type.
   - Fill in the required app name and email fields, and add the `https://www.googleapis.com/auth/drive` scope (or `drive.file` if restricting, though full `drive` is needed to access existing folders like `gd-sb-chachin`).
   - **Important — Switch Publishing Status to "In Production":** On the *Audience* / *OAuth consent screen* page, click **Publish App** so the status is **In Production** (free, no Google app verification needed for personal use). Leaving the app in *Testing* mode causes refresh tokens to expire every **7 days**.
4. Create OAuth credentials:
   - Go to *APIs & Services → Credentials → Create Credentials → OAuth client ID*.
   - Select Application type: **Desktop app**.
   - Copy your **Client ID** and **Client Secret**.

### 2. Run the Mac One-Time OAuth Setup CLI Helper

On your Mac, clone this repository, install dependencies, and run the setup helper:

```bash
npm install
npm run setup -- --client-id "<YOUR_CLIENT_ID>" --client-secret "<YOUR_CLIENT_SECRET>" --folder-name "obsidian-sync-test"
```

> **Tip:** Omit `--folder-name` when ready to link your real vault—it defaults to `gd-sb-chachin`. You can also pass `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` via environment variables or enter them at the interactive prompt.

What the helper does:
1. Opens your browser to Google's OAuth consent screen using a local loopback redirect (`http://127.0.0.1:<port>/callback`).
2. If Google shows an *"App isn't verified"* warning (expected for personal "In Production" apps), click **Advanced → Go to \<app\> (unsafe)** once to grant access.
3. Exchanges the authorization code for an offline `refresh_token`.
4. Resolves the exact Google Drive Folder ID for the target folder name.
5. Prints a single JSON **Configuration Bundle** (and optional base64) to copy to your iPhone (e.g., via Universal Clipboard / AirDrop / Apple Notes). Never commit this bundle to git.

### 3. Install & Auto-Update on iOS via BRAT

Once `prsantiago/obsidian-sync` is public, install the plugin for free on iOS using **BRAT** (*Beta Reviewers Auto-update Tester*):

1. In Obsidian on iOS, open **Settings → Community plugins → Browse**, install **BRAT**, and enable it.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Enter `prsantiago/obsidian-sync` and tap **Add Plugin**.
4. Enable **Google Drive Sync** under **Settings → Community plugins**.

BRAT downloads `main.js`, `manifest.json`, and `styles.css` directly from GitHub Releases and checks for updates automatically.

### 4. Paste the Configuration Bundle in iOS Settings

1. In Obsidian on iOS, open **Settings → Google Drive Sync**.
2. Paste the JSON (or base64) output from the Mac setup helper into **Configuration Bundle**.
3. Tap **Connect & Initial Sync**.
4. Verify the status card shows **Connected**, the expected **Linked Folder** name, and **Folder ID**.

---

## Pre-Release Throwaway Drive Folder Checklist (iOS)

Before linking your real `gd-sb-chachin` vault, verify end-to-end iOS behavior against a throwaway Google Drive folder (e.g., `obsidian-sync-test`):

1. [ ] Create an empty `obsidian-sync-test` folder in Google Drive with 1–2 test markdown files and 1 image attachment.
2. [ ] Run `npm run setup -- --folder-name "obsidian-sync-test"` on Mac and paste the bundle into a fresh local iOS vault ("On My iPhone").
3. [ ] Confirm initial pull downloads both markdown and binary image files cleanly via iOS `WKWebView` `requestUrl`.
4. [ ] Edit a note on iOS and immediately lock the screen / switch apps; confirm `visibilitychange` flushes the edit to Google Drive within seconds.
5. [ ] Edit a note on Google Drive / macOS and wait ~30 s (or background/foreground Obsidian on iOS) to confirm automatic delta pull.
6. [ ] Test a simultaneous offline edit on both sides to verify a conflict copy is created without data loss.
7. [ ] Delete a test note on iOS and confirm it moves to **Google Drive Trash** (recoverable for 30 days).
8. [ ] Once verified, re-run `npm run setup` (defaulting to `gd-sb-chachin`) and use **Re-import Configuration Bundle** in iOS Settings against a fresh local vault for `gd-sb-chachin`.

---

## Public-Repo Transition Security Checklist

Before switching `prsantiago/obsidian-sync` from private to public for BRAT:

- [ ] Verify `.gitignore` excludes `.env`, `.env.*`, `oauth-credentials*.json`, `*client_secret*.json`, `*credentials*.json`, `*token*.json`, `config-bundle*.json`, `config-bundle*.txt`, `data.json`, `*.pem`, `*.key`, `main.js`, and `dist/`.
- [ ] Run `git status --ignored` and `git log --all --stat` to confirm no OAuth client secrets, refresh tokens, or config bundles were ever committed.
- [ ] Confirm `npm test` and `npm run build` pass cleanly.

---

## Releasing a New Version (Maintainers)

1. Update `version` in `manifest.json` and `package.json`, and add the matching `"<version>": "<minAppVersion>"` entry to `versions.json`.
2. Commit and push to `main`.
3. Tag and push the release (e.g., `git tag 0.1.0 && git push origin 0.1.0`).
4. The `.github/workflows/release.yml` workflow runs tests, builds `main.js`, validates `manifest.json` / `versions.json` / `package.json` consistency, and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub Release assets for BRAT.
