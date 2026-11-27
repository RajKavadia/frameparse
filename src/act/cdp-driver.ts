import { LIVE_DOM_EXTRACTOR_SCRIPT } from "../browser-adapter.js";
import type { LiveDomSnapshot } from "../types.js";
import { FRAMEPARSE_PAGE_RUNTIME } from "./runtime.js";

export interface BrowserDriver {
  status(): { connected: boolean; url?: string; title?: string; browserURL?: string };
  connect(opts?: { browserURL?: string; wsEndpoint?: string }): Promise<void>;
  launch(opts?: { headless?: boolean; executablePath?: string }): Promise<void>;
  disconnect(): Promise<void>;
  navigate(url: string): Promise<void>;
  runCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>>;
  extractSnapshot(): Promise<LiveDomSnapshot>;
  contentHtml(): Promise<{ url: string; html: string; title: string }>;
}

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
};

/**
 * Minimal CDP driver (no Puppeteer). Connects to Chrome remote debugging
 * via browserURL (http://127.0.0.1:9222) or wsEndpoint.
 */
export class CdpBrowserDriver implements BrowserDriver {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private sessionId: string | null = null;
  private browserURL?: string;
  private lastUrl?: string;
  private lastTitle?: string;

  status() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      url: this.lastUrl,
      title: this.lastTitle,
      browserURL: this.browserURL,
    };
  }

  async connect(opts: { browserURL?: string; wsEndpoint?: string } = {}): Promise<void> {
    await this.disconnect();
    let wsUrl = opts.wsEndpoint;
    this.browserURL = opts.browserURL;

    if (!wsUrl && opts.browserURL) {
      const base = opts.browserURL.replace(/\/$/, "");
      const version = (await (await fetch(`${base}/json/version`)).json()) as {
        webSocketDebuggerUrl?: string;
      };
      wsUrl = version.webSocketDebuggerUrl;
      if (!wsUrl) {
        const pages = (await (await fetch(`${base}/json/list`)).json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
        wsUrl = page?.webSocketDebuggerUrl;
      }
    }

    if (!wsUrl) {
      throw new Error(
        "Provide browserURL (e.g. http://127.0.0.1:9222) or wsEndpoint. Start Chrome with --remote-debugging-port=9222.",
      );
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl!);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`CDP WebSocket failed: ${wsUrl}`));
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
      ws.onclose = () => {
        this.ws = null;
        this.sessionId = null;
      };
    });

    // Prefer attaching to an existing page target
    const targets = (await this.send("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    };
    const page =
      targets.targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://")) ||
      targets.targetInfos.find((t) => t.type === "page") ||
      targets.targetInfos.find(
        (t) =>
          (t.type === "other" || t.type === "tab") &&
          (t.url.startsWith("http") || t.url === "about:blank"),
      );
    if (!page) throw new Error("No page target found in Chrome");

    const attached = (await this.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    this.lastUrl = page.url;
    this.lastTitle = page.title;
  }

  async launch(opts: { headless?: boolean; executablePath?: string } = {}): Promise<void> {
    // Zero-dep launch: spawn Chrome with a dedicated debugging port + profile
    const { spawn } = await import("node:child_process");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const port = Number(process.env.FRAMEPARSE_CDP_PORT || 9333);
    const exe =
      opts.executablePath ||
      process.env.CHROME_PATH ||
      (process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : process.platform === "darwin"
          ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
          : "google-chrome");

    const userDataDir = mkdtempSync(path.join(tmpdir(), "frameparse-chrome-"));
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      opts.headless === false ? "" : "--headless=new",
      "about:blank",
    ].filter(Boolean);

    spawn(exe, args, { detached: true, stdio: "ignore" }).unref();

    const browserURL = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connect({ browserURL });
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error(`Failed to launch/connect Chrome at ${browserURL}: ${lastErr}`);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
    this.sessionId = null;
    for (const [, p] of this.pending) p.reject(new Error("CDP disconnected"));
    this.pending.clear();
  }

  async navigate(url: string): Promise<void> {
    this.ensureConnected();
    await this.send("Page.navigate", { url });
    await this.waitForLoad();
    const info = (await this.evaluate(`({ url: location.href, title: document.title })`)) as {
      url: string;
      title: string;
    };
    this.lastUrl = info.url;
    this.lastTitle = info.title;
  }

  async runCommand(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureConnected();
    if (cmd.op === "wait") {
      const ms = Number(cmd.timeoutMs || 0);
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      return { ok: true, op: "wait", waitedMs: ms };
    }
    if (cmd.op === "press" && cmd.key && !cmd.selector) {
      // Prefer CDP input for bare key presses
      const key = String(cmd.key);
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      return { ok: true, op: "press", key };
    }

    const result = (await this.send("Runtime.evaluate", {
      expression: `(${FRAMEPARSE_PAGE_RUNTIME})(${JSON.stringify(cmd)})`,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value?: Record<string, unknown>; exceptionDetails?: unknown } };

    if (result.result.exceptionDetails) {
      throw new Error(`Page runtime error for op=${cmd.op}`);
    }
    const value = result.result.value || { ok: false, error: "empty_result" };
    if (cmd.op === "navigate" && value.ok) {
      await this.waitForLoad();
    }
    const info = (await this.evaluate(`({ url: location.href, title: document.title })`)) as {
      url: string;
      title: string;
    };
    this.lastUrl = info.url;
    this.lastTitle = info.title;
    return value;
  }

  async extractSnapshot(): Promise<LiveDomSnapshot> {
    this.ensureConnected();
    const result = (await this.send("Runtime.evaluate", {
      expression: LIVE_DOM_EXTRACTOR_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value?: LiveDomSnapshot } };
    const snap = result.result.value;
    if (!snap || !snap.root) throw new Error("Failed to extract LiveDomSnapshot");
    this.lastUrl = snap.url;
    this.lastTitle = snap.title;
    return snap;
  }

  async contentHtml(): Promise<{ url: string; html: string; title: string }> {
    const data = (await this.evaluate(
      `({ url: location.href, title: document.title, html: document.documentElement.outerHTML })`,
    )) as { url: string; title: string; html: string };
    this.lastUrl = data.url;
    this.lastTitle = data.title;
    return data;
  }

  private ensureConnected() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Browser not connected. Call frame_browser({ action: \"connect\" | \"launch\" }) first.");
    }
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result: { value?: unknown; exceptionDetails?: unknown } };
    if (result.result.exceptionDetails) throw new Error("Runtime.evaluate failed");
    return result.result.value;
  }

  private async waitForLoad(): Promise<void> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const ready = (await this.evaluate("document.readyState")) as string;
      if (ready === "interactive" || ready === "complete") return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private onMessage(raw: string) {
    let msg: CdpResponse & { method?: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.ensureConnected();
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

/** Shared singleton used by MCP server. */
let sharedDriver: CdpBrowserDriver | null = null;

export function getSharedDriver(): CdpBrowserDriver {
  if (!sharedDriver) sharedDriver = new CdpBrowserDriver();
  return sharedDriver;
}
