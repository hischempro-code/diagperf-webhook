/**
 * re-embed-kb.js — Regénère tous les embeddings KB avec Google gemini-embedding-001
 * Usage: node scripts/re-embed-kb.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenAI } = require("@google/genai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY, httpOptions: { apiVersion: "v1" } });

async function embed(text) {
  const result = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: { outputDimensionality: 384 },
  });
  return result.embeddings[0].values;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { data: chunks, error } = await supabase
    .from("kb_chunks")
    .select("id, content")
    .order("id");

  if (error) { console.error("Erreur lecture KB:", error.message); process.exit(1); }
  console.log(`${chunks.length} chunks à re-embedder...`);

  for (let i = 0; i < chunks.length; i++) {
    const { id, content } = chunks[i];
    try {
      const embedding = await embed(content);
      const { error: upErr } = await supabase
        .from("kb_chunks")
        .update({ embedding })
        .eq("id", id);
      if (upErr) throw upErr;
      process.stdout.write(`\r${i + 1}/${chunks.length} (id=${id})`);
      await sleep(100); // éviter rate limit Google
    } catch (err) {
      console.error(`\nErreur chunk ${id}:`, err.message);
    }
  }
  console.log("\n✅ Re-embedding terminé.");
}

main();
