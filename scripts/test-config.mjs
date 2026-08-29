#!/usr/bin/env node
// Offline startup validation. Each invalid configuration must fail before the
// server listens, without contacting Pi or a provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "superpi-config-home-"));
const cases = [
  ["SUPERPI_PORT", "not-a-port", "SUPERPI_PORT"],
  ["SUPERPI_PORT", "65536", "SUPERPI_PORT"],
  ["SUPERPI_MAX_CONVERSAZIONI", "1.5", "SUPERPI_MAX_CONVERSAZIONI"],
  ["SUPERPI_TASK_TIMEOUT_MS", "0", "SUPERPI_TASK_TIMEOUT_MS"],
  ["SUPERPI_AUTH_USER", "only-user", "auth"],
];

try {
  for (const [name, value, expected] of cases) {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      [name]: value,
    };
    const result = spawnSync(process.execPath, [join(ROOT, "src", "server.mjs")], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.notEqual(result.status, 0, `${name}=${value} deve fallire`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(expected), `${name} deve spiegare il motivo`);
    console.log(`  OK configurazione rifiutata: ${name}=${value}`);
  }
  console.log(`[config] PASS (${cases.length} configurazioni invalide rifiutate)`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
