#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ESLINT = join(ROOT, "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(
  process.execPath,
  [ESLINT, ".", "--no-warn-ignored"],
  { cwd: ROOT, stdio: "inherit" },
);

if (result.error) {
  console.error(`[lint] impossibile avviare ESLint: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
