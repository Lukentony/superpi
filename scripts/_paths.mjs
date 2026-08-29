// Percorsi condivisi dagli script di verifica (npm run verify).
// .test-run/ è locale al repo, in .gitignore: run usa e getta, non stato vero.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_RUN_DIR = join(ROOT, ".test-run");
export const SESSION_DIR = join(TEST_RUN_DIR, "sessioni");
export const NOTE_DIR = join(TEST_RUN_DIR, "note");
export const CWD_DIR = join(TEST_RUN_DIR, "cwd");
// Tutti i figli delle suite live usano Codex Luna: mai quota OpenCode Go.
export const TEST_PROVIDER = "openai-codex";
export const TEST_MODEL = "gpt-5.6-luna";
