#!/usr/bin/env node
// Integration gate: real HTTP and process boundaries, but no child Pi,
// provider, Herdr, tmux, Tailscale, or credentials.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "C.UTF-8",
  CI: "1",
  NO_COLOR: "1",
};

const result = spawnSync(
  process.execPath,
  [join(ROOT, "scripts", "test-server-smoke.mjs")],
  { cwd: ROOT, env, stdio: "inherit" },
);
if (result.error) {
  console.error(`[integration] impossibile avviare smoke: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
