#!/usr/bin/env node
// Offline unit-test harness. Keep this list explicit: live/provider, real Herdr,
// tmux, Tailscale, and credential-dependent suites must never enter `npm test`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = [
  "test-fase4.mjs",      // cwd/quota/gate decisions with injected fixtures
  "test-config.mjs",     // invalid startup configuration fails closed
  "test-router.mjs",     // routing and local configuration decisions
  "test-operations.mjs", // logging modes, confined cleanup, and safe doctor output
  "test-sessioni-herdr.mjs", // fake Herdr/tmux adapter contract
  "test-scheda-vuota.mjs", // browser helper logic with a DOM stub
  "test-tre-bug.mjs",    // browser helper regressions with a DOM stub
];

// Do not forward provider credentials or personal tool configuration to unit
// suites. Node resolves the project dependency from cwd, so this small
// environment is sufficient and makes the offline contract explicit.
const home = mkdtempSync(join(tmpdir(), "superpi-unit-home-"));
mkdirSync(join(home, "hive", "appunti"), { recursive: true });
const env = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "C.UTF-8",
  CI: "1",
  NO_COLOR: "1",
};

try {
  for (const suite of SUITES) {
    console.log(`\n[unit] ${suite}`);
    const result = spawnSync(process.execPath, [join(ROOT, "scripts", suite)], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`[unit] impossibile avviare ${suite}: ${result.error.message}`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      console.error(`[unit] ${suite} fallito (exit ${result.status ?? "signal"})`);
      process.exitCode = result.status ?? 1;
      break;
    }
  }
  if (!process.exitCode) console.log(`\n[unit] PASS (${SUITES.length} suite offline)`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
