#!/usr/bin/env node
/**
 * rejudge.js — Re-notation d'un run existant avec un juge plus fort (Opus 4.8 par défaut).
 *
 * Recharge benchmark/results/raw-*.json (générations déjà sauvegardées) et re-note
 * UNIQUEMENT chaque réponse stockée avec JUDGE_MODEL, sans rappeler Claude pour générer.
 * Latence / tokens / coût restent ceux du run d'origine ; seuls exactitude + hallucination
 * sont recalculés.
 *
 * Usage :
 *   node benchmark/rejudge.js                              # dernier raw-*.json, juge Opus 4.8
 *   node benchmark/rejudge.js results/raw-XXX.json         # fichier précis
 *   JUDGE_MODEL=claude-sonnet-4-6 node benchmark/rejudge.js
 */

const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const path = require("path");
const fetchFn = global.fetch || require("node-fetch");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-4-8";

// ── Localiser le fichier raw ──
const resultsDir = path.join(__dirname, "results");
let rawPath = process.argv[2];
if (rawPath && !path.isAbsolute(rawPath)) rawPath = path.join(__dirname, rawPath);
if (!rawPath) {
  const files = fs.readdirSync(resultsDir).filter(f => f.startsWith("raw-") && f.endsWith(".json")).sort();
  if (files.length === 0) { console.error("Aucun raw-*.json trouvé."); process.exit(1); }
  rawPath = path.join(resultsDir, files[files.length - 1]);
}

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8")).questions;
const qById = Object.fromEntries(questions.map(q => [q.id, q]));

async function callJudge(prompt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        system: "Tu es un évaluateur. Réponds uniquement en JSON brut.",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
      }),
    });
    if (resp.ok) {
      const json = await resp.json();
      let content = (json.content?.[0]?.text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      try { return JSON.parse(content); } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch {} }
      }
      return { score: null, hallucination: null, reason: "parse échoué" };
    }
    if (attempt < 3 && [429, 500, 503, 529].includes(resp.status)) { await new Promise(r => setTimeout(r, 1500 * attempt)); continue; }
    const body = await resp.text().catch(() => "");
    throw new Error(`Juge API ${resp.status}: ${body.slice(0, 150)}`);
  }
}

function judgePrompt(q, botMessage) {
  return `Tu es un évaluateur rigoureux. Tu compares la réponse d'un assistant à une vérité-terrain.

QUESTION CLIENT : ${q.question}
${q.history ? `CONTEXTE (tours précédents) : ${JSON.stringify(q.history)}\n` : ""}VÉRITÉ-TERRAIN : ${q.ground_truth}
CRITÈRE D'ÉVALUATION : ${q.criterion}

RÉPONSE DE L'ASSISTANT À ÉVALUER :
"""${botMessage || "(aucune réponse — l'assistant a lancé un flow au lieu de répondre)"}"""

Évalue et retourne UNIQUEMENT du JSON brut (pas de backticks) :
{
  "score": 1 | 0.5 | 0,
  "hallucination": true | false,
  "reason": "justification courte en français"
}`;
}

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error("❌ ANTHROPIC_API_KEY manquante"); process.exit(1); }
  const data = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  console.log(`\n🔁 Re-notation de ${path.basename(rawPath)} avec juge ${JUDGE_MODEL}\n`);

  for (const rec of data.records) {
    if (rec.error) continue;
    const q = qById[rec.id];
    if (!q) continue;
    try {
      const j = await callJudge(judgePrompt(q, rec.botMessage));
      rec.judge_score = j.score;
      rec.judge_hallucination = j.hallucination;
      rec.judge_reason = j.reason;
      const halluc = j.hallucination ? " ⚠️HALLUC" : "";
      process.stdout.write(`  [${rec.condition.padEnd(7)}] ${rec.id} score=${j.score}${halluc}\n`);
    } catch (e) {
      process.stdout.write(`  [${rec.condition.padEnd(7)}] ${rec.id} JUDGE ERROR ${String(e.message)}\n`);
    }
  }

  // ── Ré-agrégation (judge-based) ──
  const conds = [...new Set(data.records.map(r => r.condition))];
  console.log("\n══════════════════ RÉSUMÉ (juge " + JUDGE_MODEL + ") ══════════════════\n");
  const summary = [];
  for (const c of conds) {
    const rs = data.records.filter(r => r.condition === c && !r.error);
    const n = rs.length;
    const scores = rs.map(r => r.judge_score).filter(s => typeof s === "number");
    const exactMean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const halluc = rs.filter(r => r.judge_hallucination === true).length;
    const detPass = rs.filter(r => r.det_pass).length;
    const answered = rs.filter(r => r.answered).length;
    const lat = rs.map(r => r.latencyMs).sort((a, b) => a - b);
    const row = {
      condition: c, label: (data.summary.find(s => s.condition === c) || {}).label || "",
      n, answeredPct: ((answered / n) * 100).toFixed(0), detPassPct: ((detPass / n) * 100).toFixed(0),
      exactMean: exactMean !== null ? exactMean.toFixed(2) : "-", hallucinations: halluc,
      latP50: lat[Math.floor(lat.length / 2)], latMean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length),
    };
    summary.push(row);
    console.log(`▸ ${c} — ${row.label}`);
    console.log(`    Exactitude juge : ${row.exactMean}  |  Hallucinations : ${halluc}/${n}  |  Déterministe : ${row.detPassPct}%  |  Répond : ${row.answeredPct}%  |  Latence p50 ${row.latP50}ms\n`);
  }

  // ── Écriture ──
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  data.meta.rejudged_with = JUDGE_MODEL;
  data.meta.rejudged_at = new Date().toISOString();
  data.summary_rejudge = summary;
  const outRaw = path.join(resultsDir, `raw-rejudged-${JUDGE_MODEL.replace(/[^a-z0-9]/gi, "")}-${stamp}.json`);
  fs.writeFileSync(outRaw, JSON.stringify(data, null, 2));
  const csvHead = "condition,label,n,answeredPct,detPassPct,exactMean,hallucinations,latP50ms,latMeanMs";
  const csvRows = summary.map(r => [r.condition, `"${r.label}"`, r.n, r.answeredPct, r.detPassPct, r.exactMean, r.hallucinations, r.latP50, r.latMean].join(","));
  fs.writeFileSync(path.join(resultsDir, `summary-rejudged-${stamp}.csv`), [csvHead, ...csvRows].join("\n"));
  console.log(`📂 ${outRaw}`);
}

main().catch(e => { console.error("❌ Re-notation échouée :", e); process.exit(1); });
