#!/usr/bin/env node
/**
 * eval/run-eval.js — Harnais de non-régression anti-hallucination (live).
 *
 * Rejoue chaque cas de eval/cases.json à travers le VRAI askLLM de prod
 * (lib/llm-service.js : même prompt, même RAG, mêmes garde-fous), puis note la réponse :
 *   1) Détecteurs déterministes (eval/detectors.js) — attrapent les hallucinations non prévues.
 *   2) required / forbidden — vérité-terrain par cas (prix, faits).
 *   3) type_in — le bot répond (answer) vs lance un flow (intent/route) quand attendu.
 *
 * L'historique et l'état de conversation sont INJECTÉS par cas (stubs) → déterministe,
 * sans toucher à la vraie base. Le RAG et l'API Anthropic sont réels.
 *
 * Usage :
 *   node eval/run-eval.js                 # tous les cas
 *   node eval/run-eval.js --only RC01     # un cas (préfixe d'id)
 *   node eval/run-eval.js --limit 3
 *   VERBOSE=1 node eval/run-eval.js       # logs internes askLLM
 *
 * Sortie : exit 1 si au moins un cas ÉCHOUE (hallucination/fait faux). Les erreurs
 * réseau (LLM injoignable) sont signalées mais ne gate pas (infra, pas régression).
 */
"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const { runDetectors } = require("./detectors");
const { initLlmService, askLLM } = require("../lib/llm-service");

const fetchFn = global.fetch || require("node-fetch");
const VERBOSE = process.env.VERBOSE === "1";

const args = process.argv.slice(2);
function argVal(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const ONLY = argVal("--only");
const LIMIT = parseInt(argVal("--limit") || "0", 10);

// Logger : silencieux par défaut (VERBOSE=1 pour déboguer askLLM).
const noop = () => {};
const log = VERBOSE
  ? { info: (...a) => console.error("[llm]", ...a), warn: (...a) => console.error("[llm:warn]", ...a), error: (...a) => console.error("[llm:err]", ...a), debug: noop }
  : { info: noop, warn: noop, error: noop, debug: noop };

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("⏭️  ANTHROPIC_API_KEY absent — éval live ignorée (les détecteurs restent testés par npm test).");
    process.exit(0);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("⏭️  Supabase non configuré — éval live ignorée (le RAG est requis pour les cas prix).");
    process.exit(0);
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Contexte injecté par cas — les stubs le renvoient à askLLM.
  const ctx = { history: [], state: null };
  initLlmService({
    supabase,
    log,
    fetchFn,
    getRecentMessages: async () => ctx.history,   // {role, content}[]
    getConversationState: async () => ctx.state,  // {intent, data:{vehicle}} | null
  });

  const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, "cases.json"), "utf8"));
  let cases = dataset.cases || [];
  if (ONLY) cases = cases.filter(c => c.id.startsWith(ONLY));
  if (LIMIT > 0) cases = cases.slice(0, LIMIT);

  console.log(`\n🔬 Éval anti-hallucination — ${cases.length} cas | modèle : ${process.env.LLM_MODEL || "claude-haiku-4-5-20251001"}\n`);

  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let passed = 0, failed = 0, errored = 0;
  const failures = [];

  for (const c of cases) {
    ctx.history = (c.history || []).map(m => ({ role: m.role, content: m.content }));
    ctx.state = c.state || null;

    let res;
    try {
      res = await askLLM(c.message, `eval-${c.id}`);
    } catch (err) {
      errored++;
      console.log(`  ⚠️  ${c.id} — ERREUR appel LLM : ${String(err?.message || err)}`);
      continue;
    }

    if (!res) {
      errored++;
      console.log(`  ⚠️  ${c.id} — LLM a renvoyé null (réseau/parse/rate limit) — non concluant`);
      continue;
    }

    const expect = c.expect || {};
    const problems = [];

    // 1) type_in
    if (Array.isArray(expect.type_in) && expect.type_in.length && !expect.type_in.includes(res.type)) {
      problems.push(`type "${res.type}" hors de [${expect.type_in.join(", ")}]`);
    }

    // Les vérifs texte ne s'appliquent qu'aux réponses "answer" (intent/route = routage structuré).
    const msg = res.type === "answer" ? (res.message || "") : "";

    // 2) détecteurs d'hallucination
    if (res.type === "answer" && Array.isArray(expect.detectors_absent) && expect.detectors_absent.length) {
      const hits = runDetectors(msg, expect.detectors_absent);
      for (const h of hits) problems.push(`hallucination [${h.code}] → "${h.evidence}"`);
    }

    // 3) required / forbidden (sur answer)
    if (res.type === "answer") {
      const n = norm(msg);
      for (const r of (expect.required || [])) if (!n.includes(norm(r))) problems.push(`manque required "${r}"`);
      for (const f of (expect.forbidden || [])) if (n.includes(norm(f))) problems.push(`contient forbidden "${f}"`);
    } else if ((expect.required || []).length) {
      // Un cas qui attend un fait dans le texte mais reçoit un routage → signalé
      problems.push(`attendu answer avec required, reçu type "${res.type}"`);
    }

    if (problems.length === 0) {
      passed++;
      console.log(`  ✅ ${c.id} (${c.trap}) — type ${res.type}`);
    } else {
      failed++;
      failures.push({ id: c.id, trap: c.trap, problems, snippet: msg.slice(0, 160) });
      console.log(`  ❌ ${c.id} (${c.trap}) — ${problems.join(" | ")}`);
    }
  }

  console.log("\n════════════════════════════════════════");
  console.log(`Résultat : ${passed} ✅  ${failed} ❌  ${errored} ⚠️ (non concluant)`);
  if (failures.length) {
    console.log("\nDétails des échecs :");
    for (const f of failures) {
      console.log(`\n• ${f.id} (${f.trap})`);
      for (const p of f.problems) console.log(`    - ${p}`);
      if (f.snippet) console.log(`    réponse : « ${f.snippet}${f.snippet.length >= 160 ? "…" : ""} »`);
    }
  }
  console.log("");

  if (failed > 0) process.exit(1);
  if (errored > 0 && passed === 0) { console.log("⚠️  Aucun cas concluant (LLM injoignable) — vérifier la connexion.\n"); process.exit(0); }
  console.log("✨ Aucune hallucination détectée sur le jeu de cas.\n");
  process.exit(0);
}

main().catch(err => { console.error("Erreur fatale run-eval:", err); process.exit(2); });
