#!/usr/bin/env node
/**
 * run-benchmark.js — Mini-benchmark V1 vs V2 (RAG) pour le mémoire DiagPerf
 *
 * Passe chaque question de benchmark/questions.json dans 4 conditions et mesure :
 *   - Exactitude (juge LLM + contrôle déterministe required/forbidden)
 *   - Hallucinations (prix / compatibilité / code) — flag du juge
 *   - Latence (ms par appel Claude)
 *   - Coût / tokens (usage Claude + tarif Haiku 4.5)
 *
 * Conditions (cf. benchmark/prompts.js) :
 *   A-V1     : prompt historique (git 9ebe5a8) — savoir baké, SANS RAG
 *   A-V2     : prompt actuel complet — savoir baké + RAG
 *   B-noRAG  : prompt dépouillé — SANS RAG          (contrôle d'ablation)
 *   B-RAG    : prompt dépouillé — AVEC RAG          (traitement d'ablation)
 *
 * Usage :
 *   node benchmark/run-benchmark.js                  # toutes les conditions
 *   node benchmark/run-benchmark.js --only A-V1,A-V2 # sous-ensemble
 *   node benchmark/run-benchmark.js --no-judge       # sans juge LLM (déterministe seul)
 *   node benchmark/run-benchmark.js --limit 5        # 5 premières questions (dry-run)
 *
 * Prérequis .env : ANTHROPIC_API_KEY, GOOGLE_AI_API_KEY, SUPABASE_URL,
 *                  SUPABASE_SERVICE_ROLE_KEY. KB doit être indexée dans Supabase
 *                  (sinon les conditions RAG retournent un contexte vide → préflight).
 */

const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { retrieveContext, formatContextForPrompt } = require("../rag");
const { PROMPT_V1, PROMPT_V2, PROMPT_B_STRIPPED } = require("./prompts");

const fetchFn = global.fetch || require("node-fetch");

// ────────────────────────────── Config ──────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-5";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-haiku-4-5"; // mettre claude-opus-4-8 pour un juge plus strict

// Tarif Claude Haiku 4.5 (USD / million de tokens) — source : claude-api skill
const PRICE = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.10, cacheWrite: 1.25 },
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.50, cacheWrite: 6.25 },
};

// Définition des 4 conditions : { prompt, useRag }
const CONDITIONS = {
  "A-V1": { prompt: PROMPT_V1, useRag: false, label: "V1 historique (prompt baké, sans RAG)" },
  "A-V2": { prompt: PROMPT_V2, useRag: true, label: "V2 livré (prompt baké + RAG)" },
  "B-noRAG": { prompt: PROMPT_B_STRIPPED, useRag: false, label: "Ablation : prompt dépouillé, sans RAG" },
  "B-RAG": { prompt: PROMPT_B_STRIPPED, useRag: true, label: "Ablation : prompt dépouillé + RAG" },
};

// ────────────────────────────── CLI args ──────────────────────────────
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const ONLY = argVal("--only") ? argVal("--only").split(",").map(s => s.trim()) : Object.keys(CONDITIONS);
const NO_JUDGE = args.includes("--no-judge");
const LIMIT = argVal("--limit") ? parseInt(argVal("--limit"), 10) : Infinity;

// ────────────────────────────── Helpers ──────────────────────────────
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Appel Claude générique → { text, latencyMs, usage } */
async function callClaude({ system, messages, model, maxTokens = 900, temperature = 0.2 }) {
  const systemBlocks = Array.isArray(system) ? system : [{ type: "text", text: system }];
  const t0 = Date.now();
  let resp, json;
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, system: systemBlocks, messages, temperature, max_tokens: maxTokens }),
    });
    if (resp.ok) break;
    if (attempt < 3 && [429, 500, 503, 529].includes(resp.status)) {
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }
    const body = await resp.text().catch(() => "");
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }
  const latencyMs = Date.now() - t0;
  json = await resp.json();
  const text = json.content?.[0]?.text || "";
  return { text, latencyMs, usage: json.usage || {} };
}

/** Parse la sortie JSON du bot → { type, message } */
function parseBotOutput(text) {
  let content = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed = null;
  try { parsed = JSON.parse(content); } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
  }
  if (!parsed) return { type: "unparseable", message: content };
  return { type: parsed.type || "unknown", message: parsed.message || "" };
}

/** Contrôle déterministe : required tous présents, forbidden aucun présent. */
function deterministicCheck(message, q) {
  const n = norm(message);
  const required = (q.required || []).every(r => n.includes(norm(r)));
  const forbidden = (q.forbidden || []).every(f => !n.includes(norm(f)));
  return { required, forbidden, pass: required && forbidden && message.length > 0 };
}

/** Juge LLM : score exactitude (0/0.5/1) + flag hallucination. */
async function judge(q, botMessage) {
  const judgePrompt = `Tu es un évaluateur rigoureux. Tu compares la réponse d'un assistant à une vérité-terrain.

QUESTION CLIENT : ${q.question}
${q.history ? `CONTEXTE (tours précédents) : ${JSON.stringify(q.history)}\n` : ""}VÉRITÉ-TERRAIN : ${q.ground_truth}
CRITÈRE D'ÉVALUATION : ${q.criterion}

RÉPONSE DE L'ASSISTANT À ÉVALUER :
"""${botMessage || "(aucune réponse — l'assistant a lancé un flow au lieu de répondre)"}"""

Évalue et retourne UNIQUEMENT du JSON brut (pas de backticks) :
{
  "score": 1 | 0.5 | 0,           // 1 = exact et complet, 0.5 = partiellement correct, 0 = faux ou hors-sujet
  "hallucination": true | false,  // true si l'assistant affirme un fait FAUX (prix erroné, compatibilité inversée, code mal interprété, info inventée)
  "reason": "justification courte en français"
}`;
  const { text } = await callClaude({
    system: "Tu es un évaluateur. Réponds uniquement en JSON brut.",
    messages: [{ role: "user", content: judgePrompt }],
    model: JUDGE_MODEL,
    maxTokens: 300,
    temperature: 0,
  });
  let content = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try { return JSON.parse(content); } catch {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
  }
  return { score: null, hallucination: null, reason: "juge: parse échoué" };
}

/** Construit les blocs système d'une condition pour une question donnée. */
async function buildSystem(supabase, cond, q) {
  const blocks = [
    { type: "text", text: cond.prompt, cache_control: { type: "ephemeral" } },
  ];
  let ragMeta = { used: cond.useRag, chunks: 0, chars: 0, topScore: null };
  if (cond.useRag) {
    try {
      const chunks = await retrieveContext(supabase, q.question, {
        matchCount: 8, matchThreshold: 0.45, keywordWeight: 0.3,
      });
      const ragContext = formatContextForPrompt(chunks, 4800);
      ragMeta = { used: true, chunks: chunks.length, chars: ragContext.length, topScore: chunks[0]?.combinedScore ?? null };
      if (ragContext) {
        blocks.push({
          type: "text",
          text: `CONTEXTE RÉCUPÉRÉ DE LA BASE DE CONNAISSANCES (utilise ces infos en priorité, elles sont fiables et à jour) :\n${ragContext}`,
        });
      }
    } catch (e) {
      ragMeta.error = String(e?.message || e);
    }
  }
  return { blocks, ragMeta };
}

function costUsd(model, usage) {
  const p = PRICE[model] || PRICE["claude-haiku-4-5"];
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  return (inTok * p.input + outTok * p.output + cr * p.cacheRead + cw * p.cacheWrite) / 1e6;
}

// ────────────────────────────── Main ──────────────────────────────
async function main() {
  if (!ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY manquante"); process.exit(1); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const qFile = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
  let questions = qFile.questions.slice(0, LIMIT);

  console.log(`\n🧪 Mini-benchmark V1 vs V2 — ${questions.length} questions × ${ONLY.length} conditions`);
  console.log(`   Modèle : ${LLM_MODEL} | Juge : ${NO_JUDGE ? "désactivé" : JUDGE_MODEL}\n`);

  // Préflight RAG : vérifie que la KB répond
  try {
    const probe = await retrieveContext(supabase, "prix reprogrammation stage 1", { matchCount: 3, matchThreshold: 0.3 });
    if (!probe || probe.length === 0) {
      console.warn("⚠️  Préflight RAG : 0 chunk récupéré. La KB est-elle indexée dans Supabase (node ingest.js) ? Les conditions RAG seront vides.\n");
    } else {
      console.log(`✅ Préflight RAG : ${probe.length} chunks (top score ${probe[0].combinedScore?.toFixed(2)})\n`);
    }
  } catch (e) {
    console.warn(`⚠️  Préflight RAG échoué : ${String(e?.message || e)}\n`);
  }

  const records = [];
  for (const q of questions) {
    for (const condName of ONLY) {
      const cond = CONDITIONS[condName];
      if (!cond) { console.warn(`Condition inconnue: ${condName}`); continue; }

      const { blocks, ragMeta } = await buildSystem(supabase, cond, q);
      const messages = [];
      for (const h of (q.history || [])) messages.push({ role: h.role, content: h.content });
      messages.push({ role: "user", content: q.question });

      let rec = { id: q.id, category: q.category, trap: q.trap, condition: condName, question: q.question };
      try {
        const { text, latencyMs, usage } = await callClaude({ system: blocks, messages, model: LLM_MODEL });
        const bot = parseBotOutput(text);
        const det = deterministicCheck(bot.message, q);
        const j = NO_JUDGE ? { score: null, hallucination: null, reason: "juge désactivé" } : await judge(q, bot.message);

        rec = {
          ...rec,
          botType: bot.type,
          answered: bot.type === "answer" && bot.message.length > 0,
          botMessage: bot.message,
          det_pass: det.pass, det_required: det.required, det_forbidden: det.forbidden,
          judge_score: j.score, judge_hallucination: j.hallucination, judge_reason: j.reason,
          latencyMs,
          tokens: {
            input: usage.input_tokens || 0, output: usage.output_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0,
          },
          costUsd: costUsd(LLM_MODEL, usage),
          rag: ragMeta,
        };
        const mark = det.pass ? "✓" : "✗";
        const halluc = j.hallucination ? " ⚠️HALLUC" : "";
        process.stdout.write(`  [${condName.padEnd(7)}] ${q.id} ${mark} score=${j.score ?? "-"}${halluc} ${latencyMs}ms\n`);
      } catch (e) {
        rec.error = String(e?.message || e);
        process.stdout.write(`  [${condName.padEnd(7)}] ${q.id} ERROR ${rec.error}\n`);
      }
      records.push(rec);
    }
  }

  // ── Agrégation par condition ──
  console.log("\n══════════════════ RÉSUMÉ PAR CONDITION ══════════════════\n");
  const summary = [];
  for (const condName of ONLY) {
    const rs = records.filter(r => r.condition === condName && !r.error);
    if (rs.length === 0) continue;
    const n = rs.length;
    const answered = rs.filter(r => r.answered).length;
    const detPass = rs.filter(r => r.det_pass).length;
    const scores = rs.map(r => r.judge_score).filter(s => typeof s === "number");
    const exactMean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const halluc = rs.filter(r => r.judge_hallucination === true).length;
    const latencies = rs.map(r => r.latencyMs).sort((a, b) => a - b);
    const latP50 = latencies[Math.floor(latencies.length / 2)];
    const latMean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const totCost = rs.reduce((a, r) => a + (r.costUsd || 0), 0);
    const totIn = rs.reduce((a, r) => a + r.tokens.input, 0);
    const totOut = rs.reduce((a, r) => a + r.tokens.output, 0);

    const row = {
      condition: condName,
      label: CONDITIONS[condName].label,
      n,
      answeredPct: ((answered / n) * 100).toFixed(0),
      detPassPct: ((detPass / n) * 100).toFixed(0),
      exactMean: exactMean !== null ? exactMean.toFixed(2) : "-",
      hallucinations: halluc,
      latP50, latMean,
      tokensIn: totIn, tokensOut: totOut,
      costUsdTotal: totCost.toFixed(4),
      costUsdPerQ: (totCost / n).toFixed(5),
    };
    summary.push(row);

    console.log(`▸ ${condName} — ${row.label}`);
    console.log(`    Répond (vs lance flow) : ${row.answeredPct}%  |  Déterministe OK : ${row.detPassPct}%  |  Exactitude juge : ${row.exactMean}`);
    console.log(`    Hallucinations : ${halluc}/${n}  |  Latence p50 ${latP50}ms / moy ${latMean}ms`);
    console.log(`    Tokens in/out : ${totIn}/${totOut}  |  Coût total $${row.costUsdTotal} ($${row.costUsdPerQ}/question)\n`);
  }

  // ── Écriture des résultats ──
  const outDir = path.join(__dirname, "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rawPath = path.join(outDir, `raw-${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify({ meta: { model: LLM_MODEL, judge: NO_JUDGE ? null : JUDGE_MODEL, date: new Date().toISOString() }, summary, records }, null, 2));

  // CSV résumé
  const csvHead = "condition,label,n,answeredPct,detPassPct,exactMean,hallucinations,latP50ms,latMeanMs,tokensIn,tokensOut,costUsdTotal,costUsdPerQ";
  const csvRows = summary.map(r => [r.condition, `"${r.label}"`, r.n, r.answeredPct, r.detPassPct, r.exactMean, r.hallucinations, r.latP50, r.latMean, r.tokensIn, r.tokensOut, r.costUsdTotal, r.costUsdPerQ].join(","));
  fs.writeFileSync(path.join(outDir, `summary-${stamp}.csv`), [csvHead, ...csvRows].join("\n"));

  console.log(`📂 Résultats détaillés : ${rawPath}`);
  console.log(`📂 Résumé CSV          : ${path.join(outDir, `summary-${stamp}.csv`)}\n`);
}

main().catch(e => { console.error("❌ Benchmark échoué :", e); process.exit(1); });
