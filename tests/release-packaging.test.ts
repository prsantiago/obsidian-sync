import { describe, expect, it } from "vitest";
// @ts-expect-error -- Node built-ins are used only in this Vitest test, not in plugin src/
import fs from "node:fs";
// @ts-expect-error -- Node built-ins are used only in this Vitest test, not in plugin src/
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function readJson<T>(relPath: string): T {
  const raw = fs.readFileSync(path.join(ROOT, relPath), "utf8");
  return JSON.parse(raw) as T;
}

describe("BRAT release packaging & security invariants", () => {
  it("keeps manifest.json, versions.json, and package.json versions in sync with isDesktopOnly: false", () => {
    const manifest = readJson<{
      id: string;
      version: string;
      minAppVersion: string;
      isDesktopOnly: boolean;
    }>("manifest.json");
    const pkg = readJson<{ version: string }>("package.json");
    const versions = readJson<Record<string, string>>("versions.json");

    expect(manifest.isDesktopOnly).toBe(false);
    expect(manifest.id).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe(manifest.version);
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });

  it("includes styles.css at repository root for BRAT release assets", () => {
    const stylesPath = path.join(ROOT, "styles.css");
    expect(fs.existsSync(stylesPath)).toBe(true);
    expect(fs.readFileSync(stylesPath, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("contains zero Node.js built-in imports in src/", () => {
    const srcDir = path.join(ROOT, "src");
    const files = fs.readdirSync(srcDir).filter((f: string) => f.endsWith(".ts"));
    const nodeBuiltinPattern =
      /from\s+["'](?:node:)?(?:fs|path|http|https|crypto|child_process|os|stream|buffer|util|net|tls|url|readline)(?:\/[^"']*)?["']/;

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf8");
      expect(content, `Unexpected Node.js built-in import in src/${file}`).not.toMatch(
        nodeBuiltinPattern,
      );
    }
  });

  it("excludes local credentials, OAuth tokens, config bundles, and build artifacts in .gitignore", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    const lines = gitignore
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0 && !l.startsWith("#"));

    const requiredPatterns = [
      "node_modules/",
      "main.js",
      "dist/",
      ".env",
      ".env.*",
      "oauth-credentials*.json",
      "client_secret*.json",
      "credentials*.json",
      "token*.json",
      "config-bundle*.json",
      "config-bundle*.txt",
      "data.json",
    ];

    for (const pattern of requiredPatterns) {
      expect(lines, `.gitignore missing pattern: ${pattern}`).toContain(pattern);
    }
  });

  it("defines CI and BRAT release GitHub Actions workflows", () => {
    const ciPath = path.join(ROOT, ".github/workflows/ci.yml");
    const releasePath = path.join(ROOT, ".github/workflows/release.yml");

    expect(fs.existsSync(ciPath)).toBe(true);
    expect(fs.existsSync(releasePath)).toBe(true);

    const ci = fs.readFileSync(ciPath, "utf8");
    expect(ci).toContain("pull_request");
    expect(ci).toContain("npm test");
    expect(ci).toContain("npm run build");

    const release = fs.readFileSync(releasePath, "utf8");
    expect(release).toContain("npm test");
    expect(release).toContain("npm run build");
    expect(release).toContain("main.js");
    expect(release).toContain("manifest.json");
    expect(release).toContain("styles.css");
  });

  it("provides concise user setup documentation in README.md", () => {
    const readmePath = path.join(ROOT, "README.md");
    expect(fs.existsSync(readmePath)).toBe(true);

    const readme = fs.readFileSync(readmePath, "utf8");
    expect(readme).toContain("Desktop app");
    expect(readme).toContain("In Production");
    expect(readme).toContain("npm run setup");
    expect(readme).toContain("BRAT");
    expect(readme).toContain("prsantiago/obsidian-sync");
    expect(readme).toContain("Configuration Bundle");
    expect(readme).toContain("gd-sb-chachin");
    expect(readme.toLowerCase()).toContain("throwaway");
  });
});
