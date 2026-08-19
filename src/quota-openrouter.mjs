// Riserva OpenRouter (2026-08-18): quando la quota OpenCode Go è esaurita (o
// non determinabile), il gate prova OpenRouter prima di rifiutare. OpenCode Go
// resta il provider primario — questo modulo entra in gioco solo quando il
// primario dice di no.
//
// Bridging del nome della credenziale (verificato dal vivo il 2026-08-18):
// il secret nel vault si chiama "openrouter" e il comando `secret env openrouter`
// produce `export OPENROUTER_API_TOKEN=<valore>`; pi e OpenRouter riconoscono le
// credenziali SOLO come OPENROUTER_API_KEY. Il valore transita SOLO in memoria
// (subprocesso del comando `secret env`, mai la variante che riverserebbe il
// valore su stdout o su disco) e non deve MAI comparire in log, broadcast,
// risposte HTTP, commit o report.
//
// Segnale di saldo (verificato dal vivo e nella documentazione ufficiale):
// GET https://openrouter.ai/api/v1/credits ("Get remaining credits") ritorna
// { data: { total_credits, total_usage } } — saldo residuo = totale - usato.
// Non è una percentuale come OpenCode Go, ma è un valore reale.
import { execFileSync } from "node:child_process";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const SOGLIA_SALDO_MINIMO = 0.5; // in crediti; sotto questa la riserva è esaurita
// Nome GIUSTO per pi/OpenRouter (bridging: nel vault è OPENROUTER_API_TOKEN).
export const OPENROUTER_VARIABILE = "OPENROUTER_API_KEY";
export const OPENROUTER_MODELLO = "deepseek/deepseek-v4-flash";

// Legge il valore dal vault in memoria. Ritorna { valore } — il NOME da usare
// è OPENROUTER_VARIABILE (bridging), mai quello del vault.
export function leggiCredenzialeOpenRouter({ esegui = execFileSync } = {}) {
  const out = esegui("secret", ["env", "openrouter"], { encoding: "utf8", timeout: 10000 });
  const m = out.match(/^export\s+[A-Z0-9_]+\s*=\s*(.*)$/m);
  if (!m) throw new Error("secret openrouter non leggibile (formato inatteso)");
  return { valore: m[1] };
}

// Verifica di disponibilità della riserva: credenziale leggibile + saldo
// residuo sopra la soglia. Ritorna { ok: true, saldoResiduo } oppure
// { ok: false, motivo } — il motivo non contiene MAI il valore del secret.
// Timeout esterno su tutta la chiamata di rete (mai bloccare il gate a tempo
// indefinito). Iniettabile per i test (stesso pattern di ottieniQuota).
export async function verificaOpenRouter({
  ottieniCredenziale = leggiCredenzialeOpenRouter,
  url = CREDITS_URL,
  timeoutMs = 15000,
  sogliaMinima = SOGLIA_SALDO_MINIMO,
} = {}) {
  let cred;
  try {
    cred = ottieniCredenziale();
  } catch (e) {
    return { ok: false, motivo: `OpenRouter: credenziale non leggibile (${e instanceof Error ? e.message : String(e)})` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${cred.valore}` }, signal: controller.signal });
    if (!r.ok) return { ok: false, motivo: `OpenRouter: verifica HTTP ${r.status}` };
    const data = await r.json();
    const totali = Number(data?.data?.total_credits);
    const usati = Number(data?.data?.total_usage);
    if (!Number.isFinite(totali) || !Number.isFinite(usati)) {
      return { ok: false, motivo: "OpenRouter: saldo non determinabile (total_credits/total_usage mancanti)" };
    }
    const residuo = totali - usati;
    if (residuo <= sogliaMinima) {
      return { ok: false, motivo: `OpenRouter: saldo residuo ${residuo.toFixed(2)} crediti sotto la soglia ${sogliaMinima}` };
    }
    return { ok: true, saldoResiduo: residuo };
  } catch (e) {
    return { ok: false, motivo: `OpenRouter: verifica fallita (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    clearTimeout(timer);
  }
}
