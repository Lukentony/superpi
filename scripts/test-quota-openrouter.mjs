// Test deterministico per la lettura della credenziale OpenRouter
// (src/quota-openrouter.mjs, leggiCredenzialeOpenRouter). Aggiunto dopo
// l'audit hive 2026-08-20 punto 4: il fallback OpenRouter dipendeva SOLO da
// `secret env openrouter` (helper opzionale non incluso nel repo). Ora
// process.env.OPENROUTER_API_KEY è la prima sorgente valida; l'helper `secret env
// openrouter` resta come fallback retrocompatibile solo quando l'env manca.
// Nessuna rete, nessuna credenziale reale: `esegui` è sempre iniettato come
// mock e process.env.OPENROUTER_API_KEY è ripristinato al valore originale
// in ogni percorso di uscita.
import { leggiCredenzialeOpenRouter, verificaOpenRouter, OPENROUTER_VARIABILE } from "../src/quota-openrouter.mjs";

let nPass = 0;
let nFail = 0;
function check(nome, cond, dettaglio = "") {
  if (cond) { nPass++; console.log(`  OK ${nome}`); }
  else { nFail++; console.error(`  FAIL ${nome} ${dettaglio}`); }
}

const envOriginale = process.env[OPENROUTER_VARIABILE];
function ripristinaEnv() {
  if (envOriginale === undefined) delete process.env[OPENROUTER_VARIABILE];
  else process.env[OPENROUTER_VARIABILE] = envOriginale;
}

try {
  console.log("[quota-openrouter] === leggiCredenzialeOpenRouter ===");

  // Caso 1: env standard presente -> usato subito, secret MAI invocato.
  process.env[OPENROUTER_VARIABILE] = "sk-test-env-0001";
  let chiamateSecret = 0;
  const esegoiSpia = () => {
    chiamateSecret++;
    throw new Error("secret non deve essere invocato quando l'env è presente");
  };
  let r = leggiCredenzialeOpenRouter({ esegui: esegoiSpia });
  check("1: env presente -> valore letto dall'env", r.valore === "sk-test-env-0001", JSON.stringify(r));
  check("1: env presente -> secret env openrouter MAI invocato", chiamateSecret === 0, `chiamate=${chiamateSecret}`);

  // Caso 2: env assente -> fallback su secret, valido.
  delete process.env[OPENROUTER_VARIABILE];
  const esegoiOk = () => "export OPENROUTER_API_TOKEN=sk-test-secret-0002\n";
  r = leggiCredenzialeOpenRouter({ esegui: esegoiOk });
  check("2: env assente -> fallback su secret valido", r.valore === "sk-test-secret-0002", JSON.stringify(r));

  // Caso 3: entrambi assenti/in errore -> eccezione esplicita, fail-closed invariato.
  delete process.env[OPENROUTER_VARIABILE];
  const esegoiKo = () => {
    throw new Error("comando 'secret' non trovato (mock)");
  };
  let errore = null;
  try {
    leggiCredenzialeOpenRouter({ esegui: esegoiKo });
  } catch (e) {
    errore = e;
  }
  check("3: entrambi assenti -> lancia eccezione (non silenzioso)", errore instanceof Error, String(errore));
  check(
    "3: motivo dell'errore secret propagato senza modifiche",
    errore != null && errore.message.includes("secret"),
    errore?.message ?? "",
  );

  // Caso 3b: env assente, secret risponde ma con formato inatteso -> stesso fail-closed di prima.
  const esegoiMalformato = () => "output inatteso senza export\n";
  errore = null;
  try {
    leggiCredenzialeOpenRouter({ esegui: esegoiMalformato });
  } catch (e) {
    errore = e;
  }
  check(
    "3b: output secret malformato -> eccezione esplicita invariata",
    errore instanceof Error && errore.message.includes("non leggibile"),
    errore?.message ?? "",
  );

  console.log("[quota-openrouter] === verificaOpenRouter: credenziale KO -> fail-closed, mai rete ===");

  // Caso 4: a valle, con credenziale non leggibile (env assente + secret KO), verificaOpenRouter
  // deve restituire { ok:false, motivo } esplicito e NON deve mai arrivare a chiamare fetch.
  const fetchOriginale = globalThis.fetch;
  let fetchChiamato = false;
  globalThis.fetch = () => {
    fetchChiamato = true;
    throw new Error("fetch non deve essere chiamato quando la credenziale è KO");
  };
  try {
    const esito = await verificaOpenRouter({
      ottieniCredenziale: () => {
        throw new Error("credenziale non leggibile (mock)");
      },
    });
    check("4: credenziale KO -> ok:false (fail-closed invariato)", esito.ok === false, JSON.stringify(esito));
    check(
      "4: motivo esplicito, mai un rifiuto silenzioso",
      typeof esito.motivo === "string" && esito.motivo.includes("credenziale non leggibile"),
      esito.motivo ?? "",
    );
    check("4: nessun valore di credenziale nel motivo riportato", !esito.motivo.includes("sk-test"), esito.motivo ?? "");
    check("4: nessuna chiamata di rete quando la credenziale è KO", fetchChiamato === false, "");
  } finally {
    globalThis.fetch = fetchOriginale;
  }
} finally {
  ripristinaEnv();
}

console.log(`\nRISULTATO QUOTA-OPENROUTER: ${nFail === 0 ? "PASS" : "FAIL"} (${nPass} ok, ${nFail} fail)`);
process.exit(nFail === 0 ? 0 : 1);
