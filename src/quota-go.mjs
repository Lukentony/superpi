// quota-go.mjs — lettura della quota OpenCode Go (rolling 5h) per il gate
// (src/gate.mjs, guida §4.6 punto 3: "leggendo lo stesso meccanismo di
// hive/.pi/extensions/uso-go.ts, non duplicandolo").
//
// Verificato dal vivo il 2026-08-11: in uso-go.ts la lettura del dato sta tutta
// in funzioni pure (estraiDallaPagina/scarica — fetch di opencode.ai con il
// cookie auth, estrazione dal JS della pagina); il contesto Pi (ctx.ui) serve
// solo a mostrare il footer. Quindi il meccanismo è richiamabile da un processo
// Node standalone, e qui è copiato fedelmente con attribuzione: stessa pagina,
// stesso cookie, stesso parsing, stesso file di credenziali. Non è un secondo
// tracciamento della quota — è lo stesso dato, letto dalla stessa fonte.
//
// Non si importa il .ts dell'estensione direttamente (pure funzionerebbe, il
// type-stripping di Node 22 lo permette): legherebbe superPi al layout del
// vault (file che vive in un altro repo) e al supporto TS sperimentale di Node.
// La copia è pinnata dal test fixture in scripts/test-fase4.mjs: se il formato
// della pagina cambia, il test lo scopre.
//
// Credenziali (MAI stampate, MAI committate — stesse regole dell'estensione):
//   OPENCODE_GO_AUTH_COOKIE    cookie auth di opencode.ai
//   OPENCODE_GO_WORKSPACE_ID   workspace esplicito, obbligatorio
// da ambiente oppure dal file ~/.config/pi/uso-go.env (chmod 600, fuori da
// qualsiasi repo). Se il cookie è esposto: ruotarlo.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENV_FILE = join(homedir(), ".config", "pi", "uso-go.env");

const JS_OBJECT_RE =
  /(?:rollingUsage|weeklyUsage|monthlyUsage):\$R\[\d+\]=\s*(\{[^}]+\})/g;
const PAIR_RE =
  /(\w+)\s*:\s*("[^"]*"|'[^']*'|-?\d+\.?\d*|true|false|null|\w+)/g;

export function caricaEnvFile() {
  if (!existsSync(ENV_FILE)) return;
  try {
    for (const riga of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const r = riga.trim();
      if (!r || r.startsWith("#") || !r.includes("=")) continue;
      const [chiave, ...resto] = r.split("=");
      if (chiave && !process.env[chiave]) {
        process.env[chiave] = resto
          .join("=")
          .trim()
          .replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* file illeggibile: si prosegue senza */
  }
}

function parseValore(valore) {
  if (valore === "true") return true;
  if (valore === "false") return false;
  if (valore === "null") return null;
  if (
    (valore.startsWith('"') && valore.endsWith('"')) ||
    (valore.startsWith("'") && valore.endsWith("'"))
  ) {
    return valore.slice(1, -1);
  }
  if (/^-?\d+$/.test(valore)) return parseInt(valore, 10);
  if (/^-?\d+\.\d+$/.test(valore)) return parseFloat(valore);
  return valore;
}

function parseOggettoJs(testo) {
  const coppie = [...testo.matchAll(PAIR_RE)].map(
    (m) => [m[1], parseValore(m[2])],
  );
  return Object.fromEntries(coppie);
}

export function estraiDallaPagina(html) {
  const trovati = Object.fromEntries(
    [...html.matchAll(JS_OBJECT_RE)].map(
      (m) => [m[0].split(":")[0], parseOggettoJs(m[1])],
    ),
  );
  const voce = (chiave) => {
    const grezzo = trovati[chiave];
    if (!grezzo || typeof grezzo.usagePercent !== "number") return undefined;
    return {
      percentuale: Math.round(grezzo.usagePercent),
      reset_in: typeof grezzo.resetInSec === "number" ? grezzo.resetInSec : 0,
    };
  };
  return {
    rolling: voce("rollingUsage"),
    weekly: voce("weeklyUsage"),
    monthly: voce("monthlyUsage"),
    aggiornato: new Date().toISOString(),
  };
}

export async function ottieniQuotaGo() {
  caricaEnvFile();
  const cookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (!cookie) {
    throw new Error(
      "OPENCODE_GO_AUTH_COOKIE non impostato (né in ambiente né in ~/.config/pi/uso-go.env)",
    );
  }
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  if (!workspaceId) {
    throw new Error(
      "OPENCODE_GO_WORKSPACE_ID non impostato (né in ambiente né in ~/.config/pi/uso-go.env); quota Go non utilizzabile senza workspace esplicito",
    );
  }
  const risposta = await fetch(`https://opencode.ai/workspace/${workspaceId}/go`, {
    headers: { Cookie: `auth=${cookie}` },
    signal: AbortSignal.timeout(20000),
  });
  if (risposta.status === 401 || risposta.status === 403) {
    throw new Error(`HTTP ${risposta.status}: cookie auth scaduto o non valido`);
  }
  if (!risposta.ok) throw new Error(`HTTP ${risposta.status}`);
  return estraiDallaPagina(await risposta.text());
}
