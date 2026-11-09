import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [chrome, root, mode] = process.argv.slice(2);
if (!chrome || !root) throw new Error("Usage: node probe.mjs CHROME_BIN SCRATCH [github-linux]");
const githubLinux = mode === "github-linux";
if (mode !== undefined && (!githubLinux || process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true")) {
  throw new Error("The CI launch mode requires a disposable GitHub-hosted Linux runner");
}

const html = `<!doctype html><meta charset="utf-8"><title>WebMCP fixture</title>
<script type="module">
window.fixture = {
  secure: isSecureContext,
  document: typeof document.modelContext,
  navigator: typeof navigator.modelContext,
  registered: false,
};
try {
  if (typeof document.modelContext?.registerTool === "function") {
    await document.modelContext.registerTool({
      name: "webmcp_fixture_ping",
      description: "Return a fixture response",
      inputSchema: {type: "object", properties: {}},
      execute: async () => ({ ok: true }),
    });
    window.fixture.registered = true;
  }
} catch (error) {
  window.fixture.registrationError = String(error);
} finally {
  window.fixture.done = true;
}
</script>`;
const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;

async function waitFor(fn, description, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(60);
  }
  throw new Error(`Timed out: ${description}`);
}

async function run(name, enabled) {
  const profile = await mkdtemp(path.join(root, `${name}-`));
  const home = path.join(profile, "home");
  const data = path.join(profile, "data");
  const crashes = path.join(profile, "crashes");
  await mkdir(home);
  await mkdir(data);
  await mkdir(crashes);
  const chromeArgs = [
    "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-default-apps", "--disable-sync",
    "--password-store=basic", "--use-mock-keychain", "--metrics-recording-only",
    // Match Agent Browser's existing Chrome launch in CI, not on a user's host.
    ...(githubLinux ? ["--no-sandbox", "--enable-unsafe-swiftshader"] : []),
    `--user-data-dir=${data}`,
    `--enable-features=${["NetworkService", "NetworkServiceInProcess", ...enabled].join(",")}`,
    "about:blank",
  ];
  const child = spawn(chrome, chromeArgs, {
    env: { HOME: home, TMPDIR: root, BREAKPAD_DUMP_LOCATION: crashes, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const ended = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => resolve({ error: error.message }));
  });
  let browserErrors = "";
  child.stderr.setEncoding("utf8").on("data", chunk => {
    browserErrors = (browserErrors + chunk).slice(-2000);
  });
  let ws;
  try {
    const port = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Chrome exited before CDP was ready: ${JSON.stringify(await ended)}`);
      }
      try {
        const raw = await readFile(path.join(data, "DevToolsActivePort"), "utf8");
        return Number(raw.split("\n")[0]) || null;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return null;
      }
    }, "DevToolsActivePort");
    const target = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
        return (await res.json()).find(row => row.type === "page" && row.webSocketDebuggerUrl);
      } catch {
        return null;
      }
    }, "page target");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    const events = [];
    let id = 0;
    ws.addEventListener("message", ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) pending.get(msg.id)?.(msg);
      else if (msg.method?.startsWith("WebMCP.")) events.push(msg.method);
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP websocket open timeout")), 3500);
      ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP websocket error")); }, { once: true });
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const callId = ++id;
        const timeout = setTimeout(() => {
          pending.delete(callId);
          reject(new Error(`CDP timeout: ${method}`));
        }, 4000);
        pending.set(callId, msg => { clearTimeout(timeout); pending.delete(callId); resolve(msg); });
        ws.send(JSON.stringify({ id: callId, method, params }));
      });
    }
    const browser = (await send("Browser.getVersion")).result?.product;
    const domain = await send("WebMCP.enable");
    const nav = await send("Page.navigate", { url });
    if (nav.error || nav.result?.errorText) throw new Error("Local fixture navigation failed");
    const fixture = await waitFor(async () => {
      const out = await send("Runtime.evaluate", {
        expression: "window.fixture?.done ? window.fixture : null",
        returnByValue: true,
      });
      return out.result?.result?.value;
    }, "fixture execution");
    await delay(250);
    return { name, browser, enabled, domain: domain.error ? domain.error.message : "available", fixture, events };
  } catch (error) {
    return { name, enabled, error: error.message, browserErrors: browserErrors.split("\n").slice(-8).join("\n") };
  } finally {
    ws?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const stop = await Promise.race([ended.then(() => true), delay(2500).then(() => false)]);
    if (!stop) child.kill("SIGKILL");
  }
}

try {
  const rows = [];
  for (const [name, features] of [
    ["control", []],
    ["agent-browser", ["WebMCPTesting", "DevToolsWebMCPSupport"]],
    ["add-webmcp", ["WebMCPTesting", "DevToolsWebMCPSupport", "WebMCP"]],
    ["webmcp-only", ["WebMCP", "DevToolsWebMCPSupport"]],
  ]) {
    const row = await run(name, features);
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  if (rows.some(row => row.error)) process.exitCode = 1;
} finally {
  server.close();
}
