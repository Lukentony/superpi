#!/usr/bin/env node
// Credential-free integration smoke. The server is a child process; no task
// is created, so no Pi child or provider is contacted.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(join(tmpdir(), "superpi-smoke-"));
const homeDir = mkdtempSync(join(tmpdir(), "superpi-smoke-home-"));
mkdirSync(join(homeDir, "hive"), { recursive: true });
const user = "smoke-user";
const password = "smoke-password";
const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`processo non terminato entro ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

const port = await freePort();
const env = {
  PATH: process.env.PATH ?? "",
  HOME: homeDir,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "C.UTF-8",
  CI: "1",
  NO_COLOR: "1",
  SUPERPI_PORT: String(port),
  SUPERPI_AUTH_USER: user,
  SUPERPI_AUTH_PASSWORD: password,
  SUPERPI_LAVORI_DIR: join(tempDir, "work"),
  SUPERPI_ROUTER_FAKE: "scout",
  SUPERPI_GATE_QUOTA_FAKE: "1",
};

const child = spawn(process.execPath, [join(ROOT, "src", "server.mjs")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

async function request(path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

async function waitForServer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await request("/", { headers: { Authorization: auth } });
      if (response.status === 200) return;
      await response.arrayBuffer();
    } catch {
      // The child may still be loading the application.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server non pronto\n${output}`);
}

let exitResult;
try {
  await waitForServer();

  const unauthorized = await request("/");
  assert.equal(unauthorized.status, 401, "GET / senza Basic auth deve fallire");
  assert.match(unauthorized.headers.get("www-authenticate") ?? "", /^Basic /);
  assert.equal(unauthorized.headers.get("x-content-type-options"), "nosniff");

  const page = await request("/", { headers: { Authorization: auth } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(html, /meta name="csrf-token" content="[0-9a-f]{64}"/);
  assert.doesNotMatch(html, /smoke-password/);

  const apiWithoutCsrf = await request("/conversazioni", { headers: { Authorization: auth } });
  assert.equal(apiWithoutCsrf.status, 401, "le API mutanti/di stato richiedono CSRF");

  const sseController = new AbortController();
  const sse = await request("/eventi-globali", {
    headers: { Authorization: auth },
    signal: sseController.signal,
  });
  assert.equal(sse.status, 200);
  assert.equal(sse.headers.get("content-type"), "text/event-stream");
  assert.equal(sse.headers.get("cache-control"), "no-store");
  sseController.abort();

  child.kill("SIGTERM");
  exitResult = await waitForExit(child, 5000);
  assert.equal(exitResult.signal, null, "shutdown deve terminare senza segnale");
  assert.equal(exitResult.code, 0, "shutdown SIGTERM deve uscire con codice 0");
  assert.doesNotMatch(output, /smoke-password/);
  console.log("[integration] server smoke: PASS (auth, headers, SSE, shutdown)");
} catch (error) {
  console.error(`[integration] server smoke: FAIL: ${error.stack ?? error.message}`);
  if (output) console.error(`[integration] output server:\n${output}`);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
}
