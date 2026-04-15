#!/usr/bin/env node
/**
 * test-rag.js — Test du pipeline RAG complet
 * Usage : node test-rag.js "Combien coute une reprog ?"
 */
const dotenv = require("dotenv");
dotenv.config();

const { createClient } = require("@supabase/supabase-js");
const { retrieveContext, formatContextForPrompt } = require("./rag");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function test() {
  const query = process.argv[2] || "Combien coute une reprog ?";
  console.log(`\n🔍 Question : "${query}"\n`);

  // 1. Test retrieval
  console.log("--- ÉTAPE 1 : Retrieval (embedding + pgvector) ---");
  try {
    const chunks = await retrieveContext(supabase, query, { matchCount: 5, matchThreshold: 0.3 });
    console.log(`✅ ${chunks.length} chunks trouvés\n`);
    for (const c of chunks) {
      console.log(`  [${c.filePath}] score=${c.similarity.toFixed(3)} intent=${c.intent || "-"}`);
      console.log(`  ${c.content.slice(0, 120).replace(/\n/g, " ")}...\n`);
    }

    // 2. Test formatting
    console.log("--- ÉTAPE 2 : Formatage du contexte ---");
    const ctx = formatContextForPrompt(chunks);
    console.log(`Contexte RAG : ${ctx.length} chars\n`);

    // 3. Test LLM
    console.log("--- ÉTAPE 3 : Appel Claude Haiku ---");
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-20250414";

    if (!ANTHROPIC_API_KEY) {
      console.error("❌ ANTHROPIC_API_KEY manquante");
      return;
    }

    const fetchFn = global.fetch || require("node-fetch");
    const systemPrompt = `Tu es l'assistant WhatsApp de DiagPerf, garage spécialisé en reprogrammation moteur et diagnostic automobile situé au 38 Rue Jean Pierre Plicque, 77124 Villenoy (près de Meaux).
Tu es professionnel, chaleureux et expert. Réponds de manière concise et commerciale.
Retourne UNIQUEMENT du JSON brut (pas de markdown, pas de backticks).

Cas 1 — Le client DEMANDE EXPLICITEMENT à démarrer une prestation (ex: "je veux faire une reprog", "lancer un diagnostic") :
{ "type": "intent", "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV", "message": "" }
UNIQUEMENT si le client veut LANCER/COMMANDER la prestation.

Cas 2 — Le client pose une QUESTION (prix, tarif, combien, durée, garantie, compatibilité, horaires, adresse...) :
{ "type": "answer", "message": "réponse max 800 chars, français, emojis" }
"Combien coûte X ?" = QUESTION (Cas 2), PAS un intent. Réponds avec le prix du contexte.

Cas 3 — Incompréhensible / hors sujet :
{ "type": "menu", "message": "" }

CONTEXTE PERTINENT :
${ctx}`;

    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        system: systemPrompt,
        messages: [{ role: "user", content: query }],
        temperature: 0.3,
        max_tokens: 400,
      }),
    });

    console.log(`HTTP status: ${resp.status}`);
    const json = await resp.json();

    if (!resp.ok) {
      console.error("❌ Erreur API:", JSON.stringify(json, null, 2));
      return;
    }

    let content = json.content?.[0]?.text;
    console.log(`\nRéponse brute Claude :\n${content}\n`);

    // Strip markdown code blocks
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    try {
      const parsed = JSON.parse(content);
      console.log("✅ JSON parsé :", JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.error("❌ JSON invalide :", e.message);
    }
  } catch (err) {
    console.error("❌ Erreur :", err.message);
    console.error(err.stack);
  }
}

test();
