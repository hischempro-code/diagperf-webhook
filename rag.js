/**
 * rag.js — Module de retrieval pour le bot WhatsApp DiagPerf
 *
 * Utilise l'API Google gemini-embedding-001 (384 dims) et Supabase pgvector
 * pour retrouver les chunks de la base de connaissances les plus pertinents.
 *
 * IMPORTANT : ingest.js doit utiliser ce même modèle (generateEmbedding) pour que les
 * espaces vectoriels soient alignés entre l'indexation et la recherche.
 */

const { GoogleGenAI } = require("@google/genai");
let _googleAI = null;

function getGoogleAI() {
  if (!_googleAI) _googleAI = new GoogleGenAI({
    apiKey: process.env.GOOGLE_AI_API_KEY,
    httpOptions: { apiVersion: "v1" },
  });
  return _googleAI;
}

// ====== Synonymes FR/EN pour améliorer le rappel vectoriel (Gemini est multilingue) ======
const QUERY_SYNONYMS = {
  // Prestations principales
  reprog: "reprogrammation engine tuning remap chip tuning stage performance puissance couple",
  reprogrammation: "reprog tuning remap stage performance puissance couple optimisation",
  stage1: "stage 1 reprog optimisation performance puissance",
  "stage 2": "stage 2 préparation performance modifications mécaniques",
  e85: "ethanol bioethanol flexfuel flex fuel superethanol essence conversion kit",
  ethanol: "e85 bioethanol flexfuel conversion essence carburant",
  bioéthanol: "e85 ethanol flexfuel conversion carburant vert",
  flexfuel: "e85 ethanol conversion essence biocarburant",
  fap: "filtre particules dpf diesel exhaust particulate filter suppression dépollution",
  "filtre particules": "fap dpf diesel suppression dépollution encrassé bouché",
  egr: "vanne egr recirculation exhaust gas recirculation diesel suppression",
  "vanne egr": "egr recirculation gaz encrassée bouché suppression",
  adblue: "scr uree urée diesel dépollution selective catalytic reduction suppression",
  // Diagnostic
  diagnostic: "diag obd code defaut panne voyant error fault analyse scan",
  diag: "diagnostic obd code defaut panne voyant analyse",
  voyant: "voyant moteur check engine code défaut panne MIL",
  "code defaut": "dtc obd p0 p1 p2 p3 u0 c0 panne voyant défaut",
  "mode degrade": "mode dégradé limp mode perte puissance bride sécurité",
  panne: "panne défaut problème voyant mode dégradé",
  // OBD codes fréquents
  p0420: "catalyseur dégradé essence sonde lambda diagnostic",
  p242f: "fap bouché saturation temperature filtre particules diesel",
  p20ee: "adblue scr réducteur urée diesel dépollution",
  p0401: "egr vanne recirculation gaz défaut diesel",
  p0300: "ratés allumage misfire bougies injection diagnostic",
  // Compatibilité et garantie
  compatible: "compatibilité fonctionne marche véhicule modèle marque moteur",
  garantie: "warranty garantie 2 ans assurance couverture intervention",
  fiable: "fiabilité abime casse moteur risque reliability confiance",
  fiabilité: "fiable abime casse risque moteur durable",
  legal: "légal légalité controle technique CT homologation carte grise assurance",
  ct: "controle technique légal homologation carte grise assurance législation",
  "controle technique": "ct legal legislation homologation carte grise",
  assurance: "légal assurance obligation déclarer signaler",
  // Infos pratiques
  prix: "tarif cout combien price cost devis budget euro estimation",
  tarif: "prix cout combien devis budget estimation",
  combien: "prix tarif cout devis budget estimation",
  duree: "durée temps délai long rapide heures minutes",
  rdv: "rendez-vous réservation prise en charge délai appointment",
  horaires: "ouverture fermeture heure quand disponible planning semaine",
  adresse: "localisation où aller accès parking gare villenoy meaux Seine-et-Marne 77",
  paiement: "payer cb carte espèces virement moyen paiement",
  // Options
  carplay: "android auto apple carplay multimedia écran retrofit connectivité",
  ceramique: "ceramic coating protection peinture hydrophobe nano",
  polissage: "polish correction peinture brillance rayures",
  alarme: "securite antivol protection système",
  gps: "traceur localisation tracking suivi véhicule",
  "virtual cockpit": "tableau bord digital écran compteur numérique affichage",
  // Marques fréquentes
  peugeot: "peugeot 208 308 3008 5008 2008 508 expert",
  renault: "renault clio megane scenic kadjar captur trafic",
  volkswagen: "vw volkswagen golf polo passat tiguan t-roc",
  bmw: "bmw serie1 serie3 serie5 116i 118i 320d",
  mercedes: "mercedes classe a classe c classe e sprinter",
  ford: "ford fiesta focus kuga transit",
  opel: "opel corsa astra insignia",
  citroen: "citroën c3 c4 c5 berlingo ds",
  dacia: "dacia duster logan sandero",
};

/**
 * Générer l'embedding d'un texte via Google gemini-embedding-001
 * @param {string} text — Le texte à encoder
 * @returns {number[]} — Vecteur de 384 dimensions
 */
async function generateEmbedding(text) {
  const ai = getGoogleAI();
  const result = await ai.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: { outputDimensionality: 384 },
  });
  return result.embeddings[0].values;
}

// ====== Query expansion ======

/**
 * Enrichir la requête utilisateur avec des synonymes pour améliorer le rappel.
 * Gemini est multilingue, mais l'expansion aide à couvrir les abréviations techniques.
 * @param {string} query — Message brut du client
 * @returns {string} — Requête enrichie pour l'embedding
 */
function expandQuery(query) {
  const lower = query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const expansions = [];

  for (const [key, synonyms] of Object.entries(QUERY_SYNONYMS)) {
    const normalizedKey = key.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (lower.includes(normalizedKey)) {
      expansions.push(synonyms);
    }
  }

  if (expansions.length === 0) return query;
  return `${query} ${expansions.join(" ")}`.slice(0, 512);
}

// ====== Recherche hybride ======

/**
 * Rechercher les chunks les plus pertinents via recherche hybride
 * (vecteur cosinus + full-text PostgreSQL)
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase — Client Supabase
 * @param {string} userQuery — Le message du client
 * @param {object} options — Options de recherche
 * @param {number} [options.matchCount=8] — Nombre max de résultats
 * @param {number} [options.matchThreshold=0.2] — Score minimum de similarité vectorielle
 * @param {string} [options.category] — Filtrer par catégorie (services, faq, infos, tarifs)
 * @param {string} [options.intentHint] — Intent courant pour booster les chunks liés
 * @param {number} [options.keywordWeight=0.3] — Poids du keyword search (0-1)
 * @returns {Promise<Array<{content: string, similarity: number, keywordRank: number, combinedScore: number, filePath: string, category: string, intent: string}>>}
 */
async function retrieveContext(supabase, userQuery, options = {}) {
  const {
    matchCount = 8,
    matchThreshold = 0.2,
    category = null,
    intentHint = null,
    keywordWeight = 0.3,
  } = options;

  // 1. Expansion de la requête pour améliorer le rappel vectoriel
  const expandedQuery = expandQuery(userQuery);

  // 2. Générer l'embedding de la requête enrichie
  const queryEmbedding = await generateEmbedding(expandedQuery);

  // 3. Recherche hybride (vector + full-text)
  let data, error;
  try {
    const result = await supabase.rpc("match_kb_chunks_hybrid", {
      query_embedding: queryEmbedding,
      query_text: userQuery,
      match_threshold: matchThreshold,
      match_count: matchCount * 2, // over-fetch pour reranking
      keyword_weight: keywordWeight,
    });
    data = result.data;
    error = result.error;
  } catch (hybridErr) {
    // Fallback : la fonction hybride n'existe pas encore → utiliser l'ancienne
    console.warn("[rag] match_kb_chunks_hybrid failed, falling back to match_kb_chunks:", String(hybridErr?.message || hybridErr));
    const result = await supabase.rpc("match_kb_chunks", {
      query_embedding: queryEmbedding,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });
    data = result.data;
    error = result.error;
  }

  if (error) {
    console.error("❌ Erreur retrieval KB:", error.message);
    return [];
  }

  if (!data || data.length === 0) return [];

  // 4. Mapper + enrichir les résultats
  let results = data.map((r) => ({
    content: r.content,
    similarity: r.similarity || 0,
    keywordRank: r.keyword_rank || 0,
    combinedScore: r.combined_score || r.similarity || 0,
    filePath: r.file_path,
    category: r.category,
    intent: r.intent,
  }));

  // 5. Filtrer par catégorie si demandé
  if (category) {
    results = results.filter((r) => r.category === category);
  }

  // 6. Boost par intent hint (si le chatbot connaît l'intent courant)
  if (intentHint) {
    results = results.map((r) => ({
      ...r,
      combinedScore: r.intent === intentHint
        ? r.combinedScore * 1.25
        : r.combinedScore,
    }));
  }

  // 7. Dédupliquer par contenu (chunks très similaires de fichiers différents)
  const seen = new Set();
  results = results.filter((r) => {
    const key = r.content.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 8. Re-trier par score combiné et limiter
  results.sort((a, b) => b.combinedScore - a.combinedScore);
  results = results.slice(0, matchCount);

  return results;
}

// ====== Formatage du contexte pour le prompt ======

/**
 * Formater les chunks récupérés pour injection dans le prompt Claude.
 * Inclut les métadonnées (catégorie, intent, score) pour aider le LLM.
 *
 * @param {Array} chunks — Résultats de retrieveContext()
 * @param {number} [maxChars=4800] — Nombre max de caractères (~1200 tokens)
 * @returns {string} — Texte formaté à injecter dans le prompt
 */
function formatContextForPrompt(chunks, maxChars = 4800) {
  if (!chunks || chunks.length === 0) return "";

  let formatted = "";
  for (const chunk of chunks) {
    const catLabel = chunk.category ? `cat:${chunk.category}` : "";
    const intentLabel = chunk.intent ? `intent:${chunk.intent}` : "";
    const score = (chunk.combinedScore || chunk.similarity || 0).toFixed(2);
    const meta = [catLabel, intentLabel, `score:${score}`].filter(Boolean).join(" | ");

    const entry = `--- [${meta}] ---\n${chunk.content}\n\n`;
    if ((formatted + entry).length > maxChars) break;
    formatted += entry;
  }

  return formatted.trim();
}

/**
 * No-op kept for backward compatibility — embedding is now handled via Google API at call time.
 */
async function preloadEmbedder() {}

module.exports = {
  generateEmbedding,
  expandQuery,
  retrieveContext,
  formatContextForPrompt,
  preloadEmbedder,
};
