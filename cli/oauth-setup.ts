import { execFile } from "node:child_process";
import http from "node:http";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/types";
import {
  DEFAULT_TARGET_FOLDER_NAME,
  parseCliArgs,
  runOAuthSetup,
  type LoopbackCallbackResult,
  type LoopbackServerPort,
} from "./setup-runner";

function printHelp(): void {
  console.log(`Obsidian Google Drive Sync — Mac One-Time OAuth Setup

Usage:
  npm run setup -- [options]

Options:
  --client-id <id>          Google Cloud OAuth Desktop client ID (or GOOGLE_CLIENT_ID env)
  --client-secret <secret>  Google Cloud OAuth Desktop client secret (or GOOGLE_CLIENT_SECRET env)
  --folder-name <name>      Target Google Drive folder name (default: ${DEFAULT_TARGET_FOLDER_NAME})
  -h, --help                Show this help message
`);
}

function createFetchHttpTransport(): HttpTransport {
  return {
    async request(params: HttpRequest): Promise<HttpResponse> {
      const response = await fetch(params.url, {
        method: params.method ?? "GET",
        headers: params.headers,
        body: params.body,
      });

      const arrayBuffer = await response.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuffer);
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      if (params.throw !== false && !response.ok) {
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return {
        status: response.status,
        headers,
        text,
        json,
        arrayBuffer,
      };
    },
  };
}

function createNodeLoopbackServer(): LoopbackServerPort {
  let server: http.Server | null = null;
  let resolveCallback: ((result: LoopbackCallbackResult) => void) | null = null;
  let rejectCallback: ((err: Error) => void) | null = null;
  const callbackPromise = new Promise<LoopbackCallbackResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  return {
    async start(): Promise<{ redirectUri: string }> {
      server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }

        const code = reqUrl.searchParams.get("code") ?? undefined;
        const state = reqUrl.searchParams.get("state") ?? undefined;
        const error = reqUrl.searchParams.get("error") ?? undefined;

        res.writeHead(error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          error
            ? `<h1>Authorization failed</h1><p>Error: ${error}</p><p>You may close this tab.</p>`
            : `<h1>Authorization received</h1><p>You may close this tab and return to your terminal.</p>`,
        );

        resolveCallback?.({ code, state, error });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => resolve());
      });

      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Failed to bind 127.0.0.1 loopback server.");
      }
      return { redirectUri: `http://127.0.0.1:${addr.port}/callback` };
    },

    async waitForCallback(): Promise<LoopbackCallbackResult> {
      return callbackPromise;
    },

    async close(): Promise<void> {
      if (!server) return;
      const toClose = server;
      server = null;
      await new Promise<void>((resolve) => {
        toClose.close(() => resolve());
      });
      rejectCallback?.(new Error("Loopback server closed before callback was received."));
    },
  };
}

async function openMacBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [url], (err) => {
      if (err) {
        console.log(`Could not auto-open browser. Open this URL manually:\n${url}`);
      }
      resolve();
    });
  });
}

async function promptTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (parseCliArgs(argv).help) {
    printHelp();
    return;
  }

  await runOAuthSetup(
    { argv, env: process.env },
    {
      http: createFetchHttpTransport(),
      createLoopbackServer: createNodeLoopbackServer,
      openBrowser: openMacBrowser,
      prompt: promptTerminal,
      log: (line) => console.log(line),
    },
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
