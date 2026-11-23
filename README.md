# Obsidian Google Drive Sync

Cross-platform (`isDesktopOnly: false`) Obsidian plugin that automatically syncs a local Obsidian vault (including **"On My iPhone"** on iOS) directly with a Google Drive folder using the Google Drive REST API v3—with zero subscription fees, zero third-party servers, and zero Node.js built-ins.

## How It Works

- **Hybrid macOS + iOS coexistence:** Keep opening `My Drive/gd-sb-chachin` on macOS via Google Drive for Desktop while iOS syncs its local vault directly against the same Google Drive folder ID.
- **Automatic two-way sync:** Local edits push ~500 ms after Obsidian writes them to disk (plus an immediate flush when switching apps or locking the screen via `visibilitychange`), and remote changes pull on app open, foreground resume, and every 30 seconds via Google Drive `changes.list`.
- **Safe data rules:** Edit-vs-edit collisions create conflict copies, deletions use Google Drive Trash (30-day recovery) with delete-beats-edit, and `.obsidian/` is excluded from sync.
- **Quiet UX:** Silent when healthy; native Obsidian `Notice` toasts and an in-settings error log appear only when errors occur.

---

## End-to-End Setup Guide (In Order)

Follow these steps from top to bottom. If you are installing from an already-published public release, skip **Step 0** and start at **Step 1**.

### Step 0: Repo & Release Prerequisites (Maintainers Only)

BRAT installs plugins on iOS by downloading `main.js`, `manifest.json`, and `styles.css` from a **public GitHub Release**. Before installing on iOS:

1. **Verify no secrets are tracked in git:**
   - Confirm `.gitignore` excludes `.env`, `.env.*`, `oauth-credentials*.json`, `*client_secret*.json`, `*credentials*.json`, `*token*.json`, `config-bundle*.json`, `config-bundle*.txt`, `data.json`, `*.pem`, `*.key`, `main.js`, and `dist/`.
   - Run `git status --ignored` and `git log --all --stat` to confirm no OAuth secrets, refresh tokens, or config bundles were ever committed.
2. **Verify tests and build pass:**
   ```bash
   npm install
   npm test
   npm run build
   ```
3. **Merge to `main` and make the repo public:**
   - Merge your feature branch into `main` and push (`git push origin main`).
   - Switch `prsantiago/obsidian-sync` to **Public** on GitHub so BRAT can access it.
4. **Publish the GitHub Release:**
   - Ensure `manifest.json`, `package.json`, and `versions.json` have matching version numbers, then push a version tag:
     ```bash
     git tag 0.1.0
     git push origin 0.1.0
     ```
   - Wait for `.github/workflows/release.yml` to finish and attach `main.js`, `manifest.json`, and `styles.css` to the release.

---

### Step 1: Create & Publish a Google Cloud OAuth "Desktop app" Client

1. **Create a project:** Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (e.g., `obsidian-gdrive-sync`).
2. **Enable the Drive API:** Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. **Configure the OAuth Consent Screen (Google Auth Platform):**
   - **Branding** (*Google Auth Platform → Branding*): Click **Get started** if prompted, enter an App name (e.g., `obsidian-gdrive-sync`), User support email, and Developer contact email, then **Save**.
   - **Data Access** (*Google Auth Platform → Data Access*): Click **Add or remove scopes**, add `https://www.googleapis.com/auth/drive` (needed to access existing folders like `gd-sb-chachin`), click **Update**, and **Save**.
   - **Audience** (*Google Auth Platform → Audience*): Confirm User type is **External**, then under *Publishing status* click **Publish app** and confirm so the status changes from *Testing* to **In production**.
     > **Why this matters:** Leaving the app in *Testing* causes `Error 403: access_denied` (unless you add test users) and expires refresh tokens every **7 days**. Personal "In production" apps do **not** require Google app verification.
4. **Create OAuth Credentials:**
   - Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Select Application type: **Desktop app**.
   - Copy your **Client ID** and **Client Secret**.

---

### Step 2: Install the Plugin on iOS via BRAT

1. In Obsidian on iOS, open **Settings → Community plugins → Browse**, install **BRAT** (*Beta Reviewers Auto-update Tester*), and enable it.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Enter `prsantiago/obsidian-sync` and tap **Add Plugin**.
4. Enable **Google Drive Sync** under **Settings → Community plugins**.

---

### Step 3: Test First with a Throwaway Drive Folder (`obsidian-sync-test`)

Before linking your real vault, verify end-to-end sync against a disposable folder:

1. **Create a test folder in Google Drive:** Create `obsidian-sync-test` in Google Drive with 1–2 test markdown files and 1 image attachment.
2. **Generate a test Configuration Bundle on your Mac:**
   ```bash
   npm run setup -- --client-id "<YOUR_CLIENT_ID>" --client-secret "<YOUR_CLIENT_SECRET>" --folder-name "obsidian-sync-test"
   ```
   > You can also pass `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` via environment variables or enter them at the interactive prompt.
   - Your browser will open to Google's OAuth screen via a local loopback redirect (`http://127.0.0.1:<port>/callback`).
   - If Google shows *"Google hasn't verified this app"* (expected for personal "In production" apps), click **Advanced → Go to obsidian-gdrive-sync (unsafe)** once to grant access.
   - The CLI exchanges the code for an offline `refresh_token`, resolves the Drive folder ID, and prints a JSON **Configuration Bundle** (never commit this to git).
3. **Connect a fresh local iOS vault ("On My iPhone"):**
   - Send the JSON bundle to your iPhone (e.g., Universal Clipboard / AirDrop / Apple Notes).
   - In Obsidian on iOS, open **Settings → Google Drive Sync**, paste the JSON into **Configuration Bundle**, and tap **Connect & Initial Sync**.
   - Verify the status card shows **Connected**, `obsidian-sync-test`, and the expected **Folder ID**.
4. **Run a quick smoke test:**
   - [ ] Initial pull downloads both markdown and binary image files cleanly.
   - [ ] Edit a note on iOS and immediately lock the screen / switch apps; confirm `visibilitychange` flushes the edit to Google Drive within seconds.
   - [ ] Edit a note on Google Drive / macOS and wait ~30 s (or background/foreground Obsidian on iOS) to confirm automatic delta pull.
   - [ ] Test a simultaneous offline edit on both sides to verify a conflict copy is created without data loss.
   - [ ] Delete a test note on iOS and confirm it moves to **Google Drive Trash** (recoverable for 30 days).

---

### Step 4: Link Your Real Vault (`gd-sb-chachin`)

Once the throwaway folder test passes:

1. On your Mac, run the setup helper without `--folder-name` (it defaults to `gd-sb-chachin`):
   ```bash
   npm run setup -- --client-id "<YOUR_CLIENT_ID>" --client-secret "<YOUR_CLIENT_SECRET>"
   ```
2. In Obsidian on iOS (against a fresh local vault for `gd-sb-chachin`), open **Settings → Google Drive Sync**, use **Re-import Configuration Bundle**, and paste the new JSON bundle.
3. Verify the status card shows **Connected** and your real `gd-sb-chachin` **Folder ID**.

---

## Releasing Future Versions (Maintainers)

1. Update `version` in `manifest.json` and `package.json`, and add the matching `"<version>": "<minAppVersion>"` entry to `versions.json`.
2. Commit and push to `main`.
3. Tag and push the release (e.g., `git tag 0.2.0 && git push origin 0.2.0`).
4. `.github/workflows/release.yml` runs typecheck, tests, and build, validates version consistency, and publishes `main.js`, `manifest.json`, and `styles.css` as GitHub Release assets for BRAT.
