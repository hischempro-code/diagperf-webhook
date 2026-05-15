// ====== Intent detection ======
const INTENT_MAP = {
  REPROG:  { code: "reprogrammation",      menu: "1", keywords: ["reprogrammation", "reprog", "stage 1", "stage 2", "stage 3", "stage 4", "stage1", "stage2", "stage3", "stage4"] },
  E85:     { code: "conversion_e85",       menu: "2", keywords: ["e85", "bioéthanol", "bioethanol", "ethanol"] },
  FAP:     { code: "suppression_fap",      menu: "3", keywords: ["fap", "filtre à particules", "filtre particules"] },
  EGR:     { code: "suppression_egr",      menu: "4", keywords: ["egr", "vanne egr"] },
  ADBLUE:  { code: "suppression_adblue",   menu: "5", keywords: ["adblue", "ad blue", "adbleu"] },
  DIAG:    { code: "diagnostic_complet",   menu: "6", keywords: ["diagnostic", "diag"] },
  AUTRES:  { code: "autres",              menu: "7", keywords: ["autres", "autre prestation"] },
  SAV:     { code: null,                   menu: "8", keywords: ["sav", "réclamation", "reclamation", "ticket"] },
};

function detectIntent(text) {
  const t = String(text || "").trim().toLowerCase();

  // Toujours matcher les numéros de menu (1-8)
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t === cfg.menu) return intent;
  }

  // Si le message est une QUESTION → ne pas matcher par mots-clés
  // → laisser le RAG/LLM répondre intelligemment
  const questionPatterns = [
    /^(combien|quel|quelle|quels|quelles|comment|pourquoi|est[\s-]ce|c'est quoi|qu'est|quoi|o|ou est|a coute|ca coute)/,
    /\?$/,
    /^(le |la |les |un |une |des )?(prix|tarif|coût|cout|durée|duree|garantie|horaire|adresse|compatib)/,
  ];
  if (questionPatterns.some((re) => re.test(t))) return null;

  // Contexte SAV/plainte prioritaire sur les mots-clés de prestation
  // ex: "j'ai un problème avec ma reprog" → SAV, pas REPROG
  const SAV_COMPLAINT_RE = /\b(probl[eè]mes?|soucis?|panne|dysfonctionn\w*|r[eé]clam\w*|pas\s+satisfait|m[eé]content|anomalie|d[eé]faut|ne?\s+(?:marche|fonctionne)\s+(?:pas|plus)|d[eé]conn[ea]|depuis\s+(?:la|le|l[''\s])?(?:reprog|prestation|intervention|conversion)|suite\s+[àa]\s+(?:la|le|l[''\s])?(?:reprog|prestation|intervention|conversion))\b/i;
  if (SAV_COMPLAINT_RE.test(t)) return "SAV";

  // Sinon, matcher par mots-clés
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (cfg.keywords.some((kw) => t.includes(kw))) return intent;
  }
  return null;
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
  intentToPrestationCode,
  intentToLabel,
};
