#!/usr/bin/env node
/**
 * ingest.js — Pipeline d'ingestion de la base de connaissances DiagPerf
 *
 * Lit tous les fichiers Markdown de knowledge_base/,
 * les découpe en chunks, génère les embeddings locaux (all-MiniLM-L6-v2),
 * et les stocke dans la table kb_chunks de Supabase (pgvector).
 *
 * Usage : node ingest.js
 * Idempotent : peut être relancé à volonté (supprime les anciens chunks par fichier).
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const KB_DIR = path.join(__dirname, "knowledge_base");
const CHUNK_MAX_TOKENS = 400; // ~400 tokens max par chunk
const CHUNK_OVERLAP_LINES = 2; // lignes de chevauchement entre chunks

// ====== Markdown frontmatter parser (simple, sans dépendance) ======
function parseFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content };

  const rawMeta = fmMatch[1];
  const body = fmMatch[2];
  const meta = {};

  for (const line of rawMeta.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    // Parse simple YAML arrays: [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
    }

    meta[key] = val;
  }

  return { meta, body };
}

// ====== Chunking par sections Markdown ======
function chunkMarkdown(body, maxTokens = CHUNK_MAX_TOKENS) {
  // Estimation grossière : 1 token ≈ 4 caractères en français
  const maxChars = maxTokens * 4;

  // Découper par sections (## ou #)
  const sections = [];
  let currentSection = "";
  let currentHeader = "";

  for (const line of body.split("\n")) {
    if (/^#{1,3}\s/.test(line)) {
      if (currentSection.trim()) {
        sections.push({ header: currentHeader, text: currentSection.trim() });
      }
      currentHeader = line;
      currentSection = line + "\n";
    } else {
      currentSection += line + "\n";
    }
  }
  if (currentSection.trim()) {
    sections.push({ header: currentHeader, text: currentSection.trim() });
  }

  // Si une section est trop longue, la re-découper par paragraphes
  const chunks = [];
  for (const section of sections) {
    if (section.text.length <= maxChars) {
      chunks.push(section.text);
    } else {
      // Découper par double saut de ligne (paragraphes)
      const paragraphs = section.text.split(/\n\n+/);
      let current = "";
      for (const para of paragraphs) {
        if ((current + "\n\n" + para).length > maxChars && current.length > 0) {
          chunks.push(current.trim());
          // Overlap : garder le header
          current = section.header ? section.header + "\n" + para : para;
        } else {
          current = current ? current + "\n\n" + para : para;
        }
      }
      if (current.trim()) chunks.push(current.trim());
    }
  }

  // Fusionner les chunks trop petits (< 100 chars)
  const merged = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && merged[merged.length - 1].length < 100) {
      merged[merged.length - 1] += "\n\n" + chunk;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

// ====== Estimer le nombre de tokens ======
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ====== Trouver tous les fichiers .md récursivement ======
function findMarkdownFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ====== Main ======
async function main() {
  console.log("🔍 Recherche des fichiers Markdown...");
  const files = findMarkdownFiles(KB_DIR);
  console.log(`📄 ${files.length} fichiers trouvés\n`);

  if (files.length === 0) {
    console.error("❌ Aucun fichier .md trouvé dans knowledge_base/");
    process.exit(1);
  }

  // Charger le modèle d'embeddings local
  console.log("🧠 Chargement du modèle d'embeddings (paraphrase-multilingual-MiniLM-L12-v2)...");
  console.log("   (Premier lancement : téléchargement ~400MB, ensuite en cache)\n");

  const { pipeline } = await import("@xenova/transformers");
  const embedder = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");

  let totalChunks = 0;
  let totalTokens = 0;

  for (const filePath of files) {
    const relativePath = path.relative(KB_DIR, filePath).replace(/\\/g, "/");
    console.log(`📝 ${relativePath}`);

    const raw = fs.readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw);
    const chunks = chunkMarkdown(body);

    // Supprimer les anciens chunks de ce fichier (idempotent)
    const { error: delErr } = await supabase
      .from("kb_chunks")
      .delete()
      .eq("file_path", relativePath);

    if (delErr) {
      console.error(`   ❌ Erreur suppression anciens chunks: ${delErr.message}`);
      continue;
    }

    // Générer les embeddings et insérer
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const tokenCount = estimateTokens(chunk);

      // Générer l'embedding
      const output = await embedder(chunk, { pooling: "mean", normalize: true });
      const embedding = Array.from(output.data);

      const { error: insErr } = await supabase.from("kb_chunks").insert({
        file_path: relativePath,
        category: meta.category || null,
        tags: Array.isArray(meta.tags) ? meta.tags : null,
        intent: meta.intent || null,
        chunk_index: i,
        content: chunk,
        token_count: tokenCount,
        embedding: embedding,
      });

      if (insErr) {
        console.error(`   ❌ Erreur insertion chunk ${i}: ${insErr.message}`);
      } else {
        console.log(`   ✅ Chunk ${i + 1}/${chunks.length} (${tokenCount} tokens)`);
      }

      totalChunks++;
      totalTokens += tokenCount;
    }
  }

  // Reconstruire l'index ivfflat (nécessaire car créé sur table vide initialement)
  console.log("\n🔄 Reconstruction de l'index vectoriel...");
  try {
    const { error: dropErr } = await supabase.rpc("exec_sql", {
      query: "DROP INDEX IF EXISTS kb_chunks_embedding_idx; CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);"
    });
    if (dropErr) {
      console.warn("⚠️  Impossible de reconstruire l'index via RPC (normal si la fonction exec_sql n'existe pas).");
      console.warn("   Exécutez manuellement dans Supabase SQL Editor :");
      console.warn("   DROP INDEX IF EXISTS kb_chunks_embedding_idx;");
      console.warn("   CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);");
    } else {
      console.log("✅ Index vectoriel reconstruit");
    }
  } catch {
    console.warn("⚠️  Reconstruisez l'index manuellement (voir ci-dessus)");
  }

  console.log(`\n✅ Ingestion terminée : ${totalChunks} chunks, ~${totalTokens} tokens total`);
  console.log("🎉 La base de connaissances est prête !");
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
