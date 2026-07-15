// ====== Intent detection ======
const INTENT_MAP = {
  // NB: phrases de GAIN uniquement — jamais "puissance" seul ("perte de puissance" = symptôme → DIAG/LLM)
  REPROG:  { code: "reprogrammation",      menu: "1", keywords: ["reprogrammation", "reprog", "stage 1", "stage 2", "stage 3", "stage 4", "stage1", "stage2", "stage3", "stage4", "remap", "remapping", "tuning", "optimisation moteur", "augmenter la puissance", "plus de puissance", "gagner en puissance", "gain de puissance", "plus de chevaux", "booster le moteur", "booster ma voiture"] },
  E85:     { code: "conversion_e85",       menu: "2", keywords: ["e85", "bioethanol", "ethanol", "flex fuel", "flexfuel", "biocarburant", "conversion ethanol", "rouler ethanol"] },
  FAP:     { code: "suppression_fap",      menu: "3", keywords: ["fap", "filtre a particules", "filtre particules", "dpf", "filtre particule"] },
  EGR:     { code: "suppression_egr",      menu: "4", keywords: ["egr", "vanne egr"] },
  ADBLUE:  { code: "suppression_adblue",   menu: "5", keywords: ["adblue", "ad blue", "adbleu", "ad-blue"] },
  DIAG:    { code: "diagnostic_complet",   menu: "6", keywords: ["diagnostic", "diag", "voyant moteur", "voyant allume", "temoin moteur", "check engine", "code defaut", "code erreur", "code obd"] },
  AUTRES:  { code: "autres",              menu: "7", keywords: ["autres", "autre prestation"] },
  SAV:     { code: null,                   menu: "8", keywords: ["sav", "reclamation", "ticket"] },
};

// Normalise : minuscules + suppression des accents (gère "éthanol" → "ethanol", etc.)
function normalizeForMatch(str) {
  return String(str || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// ====== SAV vs prospect ======
// SAV = client EXISTANT : réclamation ou problème lié à une prestation DÉJÀ réalisée
// par DiagPerf ("depuis la reprog", "suite à votre intervention", "ma conversion déconne").
// Un problème/voyant sur un véhicule jamais passé chez nous = prospect → DIAG ou LLM.
// (Avant : le simple mot "problème" suffisait → "j'ai un problème avec ma voiture,
//  voyant moteur allumé" ouvrait le menu SAV au lieu du diagnostic.)

// Réclamation explicite → SAV même sans référence à une prestation
const EXPLICIT_SAV_RE = /\b(reclamation|litige|remboursement|pas\s+satisfaite?s?|mecontente?s?)\b/;

// Mot exprimant un dysfonctionnement (texte déjà normalisé : minuscules, sans accents)
const COMPLAINT_RE = /\b(problemes?|soucis?|panne|defauts?|anomalie|dysfonctionn\w*|voyants?|ne\s+(?:marche|fonctionne|demarre)\s+(?:pas|plus)|deconne)\b/;

// Référence à une prestation DiagPerf déjà réalisée (lien temporel ou possessif)
const SAV_PRESTATION_LINK_RE = new RegExp(
  "\\b(?:depuis|apres|suite\\s+a)\\s+(?:la\\s+|le\\s+|l['’]\\s*|votre\\s+|ma\\s+|mon\\s+)?(?:reprog\\w*|prestation|intervention|conversion|cartographie|suppression|stage\\s*\\d|passage)" +
  "|\\b(?:ma|mon|votre)\\s+(?:reprog\\w*|conversion|cartographie)\\b" +
  "|\\b(?:avec|sur)\\s+(?:la\\s+|l['’]\\s*|votre\\s+)(?:reprog\\w*|prestation|intervention|conversion|cartographie)"
);

// Marqueurs de question (message ambigu → laisser le LLM répondre)
const QUESTION_PATTERNS = [
  /^(combien|quel|quelle|quels|quelles|comment|pourquoi|est[\s-]ce|c['']est quoi|qu['']est|c['']est quoi|ou\b|ou est|[cç]a\s+cout[eé]|[cç]a\s+vaut|[cç][ae]\s+marche)/,
  /\?$/,
  /^(le |la |les |un |une |des )?(prix|tarif|co[uû]t|dur[eé]e|garantie|horaire|adresse|compatib)/,
];

// Retourne TOUS les intents distincts mentionnés par mots-clés (hors questions).
// Base commune de detectIntent : permet de distinguer "1 seul intent" (sûr) de
// "plusieurs" (ambigu → ne PAS choisir arbitrairement le premier du map).
function matchedIntentsFromKeywords(t) {
  const found = [];
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (cfg.keywords.some((kw) => t.includes(kw))) found.push(intent);
  }
  return collapseReprogEthanol(found, t);
}

// "reprogrammer à l'éthanol", "reprog E85", "reprogrammation bioéthanol" : ici le mot
// générique "reprog(rammer)" DÉCRIT la conversion E85 elle-même, ce n'est PAS une demande
// de Stage 1 distincte. Sans numéro de stage explicite, on tranche pour E85. Évite le cas
// REPROG+E85 → null (ambigu) qui laissait le LLM répondre et halluciner la motorisation
// (ex: "la C1 est diesel" + FAP/EGR proposés sur un moteur essence — prod 15/07).
function collapseReprogEthanol(matched, t) {
  if (matched.length === 2 && matched.includes("REPROG") && matched.includes("E85")) {
    if (!/\bstage\s*[1-4]\b/.test(t)) return ["E85"];
  }
  return matched;
}

function detectIntent(text) {
  let t = normalizeForMatch(text);

  // Le nom du garage ne doit pas influencer la détection
  // (sinon "bonjour diagperf" matche le mot-clé "diag" → flow DIAG)
  t = t.replace(/\bdiag\s*perf\b/g, " ");

  // Toujours matcher les numéros de menu (1-8)
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t.trim() === cfg.menu) return intent;
  }

  // Si le message est une QUESTION → ne pas matcher par mots-clés
  // → laisser le RAG/LLM répondre intelligemment
  if (QUESTION_PATTERNS.some((re) => re.test(t))) return null;

  // "recherche de panne" = nom exact de la prestation Diagnostic niveau 3 (130€)
  // → DIAG, PAS une plainte SAV
  if (/recherche\s+de\s+panne/i.test(t)) return "DIAG";

  // SAV : réclamation explicite, OU dysfonctionnement rattaché à une prestation réalisée
  if (EXPLICIT_SAV_RE.test(t)) return "SAV";
  if (COMPLAINT_RE.test(t) && SAV_PRESTATION_LINK_RE.test(t)) return "SAV";

  // Mots-clés : si UN SEUL intent est mentionné → sûr. Si PLUSIEURS (ex: "pas EGR,
  // je veux AdBlue") → ambigu → null → le LLM tranche (avant : le 1er du map, EGR,
  // gagnait arbitrairement et le client restait bloqué sur la mauvaise prestation).
  const matched = matchedIntentsFromKeywords(t);
  return matched.length === 1 ? matched[0] : null;
}

// Tous les intents mentionnés (hors questions) — pour la correction mid-flow :
// "vous m'avez proposé EGR et moi je veux AdBlue" → ["EGR","ADBLUE"]. L'appelant
// retire l'intent courant pour identifier la prestation RÉELLEMENT voulue.
function detectIntentsAll(text) {
  let t = normalizeForMatch(text);
  t = t.replace(/\bdiag\s*perf\b/g, " ");
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t.trim() === cfg.menu) return [intent];
  }
  if (QUESTION_PATTERNS.some((re) => re.test(t))) return [];
  const found = new Set();
  if (EXPLICIT_SAV_RE.test(t)) found.add("SAV");
  for (const intent of matchedIntentsFromKeywords(t)) found.add(intent);
  return [...found];
}

// Détection "souple" : mots-clés SANS le filtre "question", à n'utiliser QUE comme
// dernier filet quand le LLM a échoué (réseau/parse). En temps normal une question doit
// aller au LLM ; mais si le LLM est indisponible, mieux vaut router "problème d'AdBlue ?"
// vers le flow AdBlue que de répondre "Je n'ai pas bien saisi".
function detectIntentLoose(text) {
  let t = normalizeForMatch(text);
  t = t.replace(/\bdiag\s*perf\b/g, " ");
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t.trim() === cfg.menu) return intent;
  }
  if (/recherche\s+de\s+panne/i.test(t)) return "DIAG";
  if (EXPLICIT_SAV_RE.test(t)) return "SAV";
  if (COMPLAINT_RE.test(t) && SAV_PRESTATION_LINK_RE.test(t)) return "SAV";
  // Idem detectIntent : plusieurs prestations → ambigu → null
  const matched = matchedIntentsFromKeywords(t);
  return matched.length === 1 ? matched[0] : null;
}

function intentToPrestationCode(intent) {
  return INTENT_MAP[intent]?.code || null;
}

function intentToLabel(intent) {
  const labels = {
    REPROG: "Reprogrammation moteur",
    E85: "Conversion E85",
    FAP: "Suppression FAP",
    EGR: "Suppression EGR",
    ADBLUE: "Suppression ADBlue",
    DIAG: "Diagnostic complet",
    AUTRES: "Autres prestations",
    SAV: "SAV / Réclamation",
  };
  return labels[intent] || intent;
}

module.exports = {
  INTENT_MAP,
  detectIntent,
  detectIntentLoose,
  detectIntentsAll,
  intentToPrestationCode,
  intentToLabel,
};
