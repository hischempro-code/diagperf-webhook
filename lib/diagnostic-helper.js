// ====== Diagnostic Helper ======
// Détecte dans un message client :
//   - les codes défauts OBD-II (DTC : P0420, P242F, U0100, B0001…)
//   - le kilométrage ("150 000 km", "120k", "80000km")
//   - les symptômes courants (voyant moteur, fumée noire, perte puissance, ralenti, à-coups…)
// Et propose une prestation DiagPerf adaptée.
//
// Utilisé par le LLM (askLLM) pour pré-analyser le message et injecter un
// contexte structuré dans le system prompt → permet au modèle de répondre
// avec précision et de rediriger vers la bonne prestation.

"use strict";

// ====== 1) Codes défauts OBD-II (DTC) ======
// Format standard : 1 lettre (P/B/C/U) + 4 chiffres ou hexa (P0420, P242F).
// On capture aussi les variantes avec espaces/tirets (P 0420, P-0420).
const DTC_REGEX = /\b([PBCU])[\s-]?([0-9A-F]{4})\b/gi;

// Mapping famille DTC → prestation DiagPerf suggérée.
// Les codes les plus fréquents en garage sont listés explicitement.
// Pour les familles génériques, on fallback sur le préfixe (P00, P04, P24, P20EE…).
const DTC_KNOWN = {
  // === FAP / Filtre à particules ===
  P2002: { family: "FAP",    label: "Efficacité FAP insuffisante",                presta: "FAP" },
  P2003: { family: "FAP",    label: "Efficacité FAP insuffisante (banque 2)",     presta: "FAP" },
  P242F: { family: "FAP",    label: "FAP saturé / régénération impossible",       presta: "FAP" },
  P244A: { family: "FAP",    label: "Différentiel pression FAP trop bas",         presta: "FAP" },
  P244B: { family: "FAP",    label: "Différentiel pression FAP trop haut",        presta: "FAP" },
  P2452: { family: "FAP",    label: "Capteur pression FAP défectueux",            presta: "FAP" },
  P2453: { family: "FAP",    label: "Capteur pression FAP signal incohérent",     presta: "FAP" },
  P2454: { family: "FAP",    label: "Capteur pression FAP signal bas",            presta: "FAP" },
  P2455: { family: "FAP",    label: "Capteur pression FAP signal haut",           presta: "FAP" },
  P2458: { family: "FAP",    label: "Durée de régénération FAP dépassée",         presta: "FAP" },
  P2459: { family: "FAP",    label: "Fréquence régénération FAP trop élevée",     presta: "FAP" },

  // === EGR / Vanne EGR ===
  P0400: { family: "EGR",    label: "Débit EGR insuffisant",                      presta: "EGR" },
  P0401: { family: "EGR",    label: "Débit EGR insuffisant détecté",              presta: "EGR" },
  P0402: { family: "EGR",    label: "Débit EGR excessif",                         presta: "EGR" },
  P0403: { family: "EGR",    label: "Circuit commande EGR défaillant",            presta: "EGR" },
  P0404: { family: "EGR",    label: "Circuit EGR plage/performance",              presta: "EGR" },
  P0405: { family: "EGR",    label: "Capteur position EGR signal bas",            presta: "EGR" },
  P0406: { family: "EGR",    label: "Capteur position EGR signal haut",           presta: "EGR" },
  P0409: { family: "EGR",    label: "Capteur EGR défectueux",                     presta: "EGR" },
  P040D: { family: "EGR",    label: "EGR refroidisseur déficient",                presta: "EGR" },
  P040E: { family: "EGR",    label: "EGR débit excessif",                         presta: "EGR" },

  // === AdBlue / SCR / NOx ===
  P20EE: { family: "ADBLUE", label: "Efficacité SCR (AdBlue) insuffisante",       presta: "ADBLUE" },
  P204F: { family: "ADBLUE", label: "Système réducteur AdBlue défectueux",        presta: "ADBLUE" },
  P207F: { family: "ADBLUE", label: "Qualité AdBlue incorrecte",                  presta: "ADBLUE" },
  P208A: { family: "ADBLUE", label: "Pompe AdBlue défaillante",                   presta: "ADBLUE" },
  P208E: { family: "ADBLUE", label: "Capteur niveau AdBlue défectueux",           presta: "ADBLUE" },
  P22F0: { family: "ADBLUE", label: "Pression injecteur AdBlue trop basse",       presta: "ADBLUE" },
  P229F: { family: "ADBLUE", label: "Capteur NOx aval défectueux",                presta: "ADBLUE" },
  P2BAD: { family: "ADBLUE", label: "Concentration NOx trop élevée",              presta: "ADBLUE" },

  // === Mélange / Sondes lambda (souvent essence → reprog ou diag) ===
  P0171: { family: "LAMBDA", label: "Mélange trop pauvre (banque 1)",             presta: "DIAG" },
  P0172: { family: "LAMBDA", label: "Mélange trop riche (banque 1)",              presta: "DIAG" },
  P0174: { family: "LAMBDA", label: "Mélange trop pauvre (banque 2)",             presta: "DIAG" },
  P0175: { family: "LAMBDA", label: "Mélange trop riche (banque 2)",              presta: "DIAG" },

  // === Catalyseur (essence) ===
  P0420: { family: "CATA",   label: "Catalyseur efficacité insuffisante (b1)",    presta: "DIAG" },
  P0430: { family: "CATA",   label: "Catalyseur efficacité insuffisante (b2)",    presta: "DIAG" },

  // === Turbo / Suralimentation (souvent reprog/diag) ===
  P0234: { family: "TURBO",  label: "Surpression turbo",                          presta: "DIAG" },
  P0235: { family: "TURBO",  label: "Capteur pression suralimentation HS",        presta: "DIAG" },
  P0299: { family: "TURBO",  label: "Sous-pression turbo (mode dégradé)",         presta: "DIAG" },

  // === Injection (diag pré-reprog souvent nécessaire) ===
  P0087: { family: "INJ",    label: "Pression rampe carburant trop basse",        presta: "DIAG" },
  P0088: { family: "INJ",    label: "Pression rampe carburant trop haute",        presta: "DIAG" },
  P0093: { family: "INJ",    label: "Fuite circuit carburant importante",         presta: "DIAG" },

  // === Vannes / Papillon ===
  P0121: { family: "PAPILLON", label: "Capteur papillon plage/performance",       presta: "DIAG" },
  P0638: { family: "PAPILLON", label: "Commande papillon hors plage",             presta: "DIAG" },

  // === Boîte de vitesses (hors prestations DiagPerf → contact technicien) ===
  P0700: { family: "BVA",    label: "Défaut boîte automatique",                   presta: "AUTRES" },
  P0730: { family: "BVA",    label: "Rapport incorrect (BVA)",                    presta: "AUTRES" },
  P0731: { family: "BVA",    label: "Rapport 1 incorrect (BVA)",                  presta: "AUTRES" },
  P0732: { family: "BVA",    label: "Rapport 2 incorrect (BVA)",                  presta: "AUTRES" },
  P0741: { family: "BVA",    label: "Convertisseur de couple — solénoïde",        presta: "AUTRES" },

  // === Compléments FAP/EGR/AdBlue génériques ===
  // (P0420/P0430 déjà définis dans la section Catalyseur ci-dessus)
  P0471: { family: "FAP",    label: "Capteur pression échap. — plage",            presta: "FAP" },
  P0472: { family: "FAP",    label: "Capteur pression échap. — signal bas",       presta: "FAP" },
  P0473: { family: "FAP",    label: "Capteur pression échap. — signal haut",      presta: "FAP" },
  P046C: { family: "EGR",    label: "EGR capteur position plage/performance",     presta: "EGR" },
  P0490: { family: "EGR",    label: "Vanne EGR contrôle haut",                    presta: "EGR" },
  P0491: { family: "EGR",    label: "Système EGR débit insuffisant (b1)",         presta: "EGR" },
  P0492: { family: "EGR",    label: "Système EGR débit insuffisant (b2)",         presta: "EGR" },

  // === Compléments AdBlue/NOx ===
  P2201: { family: "ADBLUE", label: "Capteur NOx amont — plage",                  presta: "ADBLUE" },
  P2202: { family: "ADBLUE", label: "Capteur NOx amont — signal bas",             presta: "ADBLUE" },
  P2203: { family: "ADBLUE", label: "Capteur NOx amont — signal haut",            presta: "ADBLUE" },
  P220A: { family: "ADBLUE", label: "Système réducteur NOx (b1)",                 presta: "ADBLUE" },
  P220B: { family: "ADBLUE", label: "Capteur NOx aval — circuit",                 presta: "ADBLUE" },
  P2BA9: { family: "ADBLUE", label: "Limitation couple — NOx hors limite",        presta: "ADBLUE" },

  // ==========================================================
  // === Codes constructeur — VAG (VW / Audi / Skoda / Seat) ===
  // ==========================================================
  // P10xx-P11xx VAG = post-traitement / vannes
  P1093: { family: "INJ",    label: "VAG : pression carburant insuffisante (rail)", presta: "DIAG" },
  P10A6: { family: "FAP",    label: "VAG : capteur de suie aval FAP défectueux",  presta: "FAP" },
  P10A7: { family: "FAP",    label: "VAG : capteur de suie — plage incorrecte",   presta: "FAP" },
  P10AB: { family: "ADBLUE", label: "VAG : qualité AdBlue (qualimétrie)",         presta: "ADBLUE" },
  P10C6: { family: "ADBLUE", label: "VAG : système AdBlue — durée chauffage",     presta: "ADBLUE" },
  P11AB: { family: "FAP",    label: "VAG : régénération FAP perturbée",           presta: "FAP" },
  P11D9: { family: "ADBLUE", label: "VAG : démarrages restants AdBlue limités",   presta: "ADBLUE" },
  P11DA: { family: "ADBLUE", label: "VAG : limitation conduite AdBlue active",    presta: "ADBLUE" },
  P11DB: { family: "ADBLUE", label: "VAG : compte à rebours AdBlue actif",        presta: "ADBLUE" },
  P11E9: { family: "ADBLUE", label: "VAG : qualité AdBlue inférieure aux normes", presta: "ADBLUE" },
  P15B6: { family: "ADBLUE", label: "VAG : surveillance NOx — limite dépassée",   presta: "ADBLUE" },

  // ==========================================================
  // === Codes constructeur — BMW / MINI =====================
  // ==========================================================
  // BMW : codes hex-décimaux dans ISTA, mais OBD-II souvent en P-code
  P10E7: { family: "FAP",    label: "BMW : régénération FAP empêchée",            presta: "FAP" },
  P11CB: { family: "ADBLUE", label: "BMW : injecteur SCR AdBlue défectueux",      presta: "ADBLUE" },
  P11D2: { family: "ADBLUE", label: "BMW : système AdBlue — pression",            presta: "ADBLUE" },
  P11D3: { family: "ADBLUE", label: "BMW : pompe AdBlue blocage",                 presta: "ADBLUE" },
  P14CC: { family: "ADBLUE", label: "BMW : qualité AdBlue insuffisante",          presta: "ADBLUE" },
  // BMW Vanos / VVT (souvent diag)
  P0014: { family: "DISTRIB", label: "BMW/VAG : VANOS/VVT — calage admission",    presta: "DIAG" },
  P0015: { family: "DISTRIB", label: "BMW/VAG : VANOS/VVT — calage échappement",  presta: "DIAG" },
  P052B: { family: "DISTRIB", label: "BMW : VANOS — corrélation bas régime",      presta: "DIAG" },

  // ==========================================================
  // === Codes constructeur — PSA (Peugeot / Citroën / DS) ===
  // ==========================================================
  // PSA : "P1" codes spécifiques Bosch EDC
  P1336: { family: "INJ",    label: "PSA : apprentissage injecteurs requis",      presta: "DIAG" },
  P1351: { family: "ALLUMAGE", label: "PSA : préchauffage bougies (diesel)",      presta: "DIAG" },
  P1497: { family: "FAP",    label: "PSA : additif FAP (Eolys) niveau bas",       presta: "FAP" },
  P1448: { family: "FAP",    label: "PSA : additif FAP — circuit défaillant",     presta: "FAP" },
  P1471: { family: "FAP",    label: "PSA : encrassement FAP excessif",            presta: "FAP" },
  P1472: { family: "FAP",    label: "PSA : régénération FAP impossible",          presta: "FAP" },
  P1473: { family: "FAP",    label: "PSA : différentiel pression FAP anormal",    presta: "FAP" },
  P1340: { family: "DISTRIB", label: "PSA : capteur arbre à cames — corrélation", presta: "DIAG" },

  // ==========================================================
  // === Codes constructeur — Renault / Dacia ================
  // ==========================================================
  // DF codes Renault → souvent reportés en P-codes via OBD
  P1611: { family: "RESEAU", label: "Renault : antidémarrage — défaut clé",       presta: "AUTRES" },
  P1521: { family: "INJ",    label: "Renault : injecteur — surveillance",         presta: "DIAG" },
  P1170: { family: "FAP",    label: "Renault : différentiel pression FAP",        presta: "FAP" },

  // ==========================================================
  // === Codes constructeur — Mercedes-Benz ==================
  // ==========================================================
  // Codes Mercedes spécifiques NOx/AdBlue (BlueTec)
  P229E: { family: "ADBLUE", label: "Mercedes : capteur NOx aval — circuit",      presta: "ADBLUE" },
  P21AD: { family: "ADBLUE", label: "Mercedes : pompe AdBlue — débit",            presta: "ADBLUE" },
  P21AF: { family: "ADBLUE", label: "Mercedes : injecteur AdBlue colmaté",        presta: "ADBLUE" },

  // ==========================================================
  // === Codes constructeur — Ford ============================
  // ==========================================================
  P132B: { family: "TURBO",  label: "Ford : turbo — limite suralimentation",      presta: "DIAG" },
  P132F: { family: "TURBO",  label: "Ford : surveillance suralimentation",        presta: "DIAG" },
  P0670: { family: "ALLUMAGE", label: "Ford : module préchauffage défaillant",    presta: "DIAG" },

  // ==========================================================
  // === Codes constructeur — Fiat / Alfa / Stellantis ======
  // ==========================================================
  P1004: { family: "FAP",    label: "Fiat/Alfa : différentiel pression FAP",      presta: "FAP" },

  // ==========================================================
  // === Codes génériques courants supplémentaires ===========
  // ==========================================================
  // Ratés d'allumage
  P0300: { family: "ALLUMAGE", label: "Ratés d'allumage multiples détectés",      presta: "DIAG" },
  P0301: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 1",              presta: "DIAG" },
  P0302: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 2",              presta: "DIAG" },
  P0303: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 3",              presta: "DIAG" },
  P0304: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 4",              presta: "DIAG" },
  P0305: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 5",              presta: "DIAG" },
  P0306: { family: "ALLUMAGE", label: "Ratés d'allumage cylindre 6",              presta: "DIAG" },
  // Capteurs critiques moteur
  P0335: { family: "CAPTEUR", label: "Capteur vilebrequin — circuit",             presta: "DIAG" },
  P0340: { family: "CAPTEUR", label: "Capteur arbre à cames — circuit",           presta: "DIAG" },
  P0101: { family: "CAPTEUR", label: "Débitmètre d'air — plage/performance",      presta: "DIAG" },
  P0102: { family: "CAPTEUR", label: "Débitmètre d'air — signal bas",             presta: "DIAG" },
  P0103: { family: "CAPTEUR", label: "Débitmètre d'air — signal haut",            presta: "DIAG" },
  P0190: { family: "INJ",    label: "Capteur pression rampe carburant",           presta: "DIAG" },
  P0191: { family: "INJ",    label: "Capteur pression rampe — plage",             presta: "DIAG" },
};

// Si un code n'est pas dans DTC_KNOWN, on tente une famille par préfixe.
const DTC_FAMILY_BY_PREFIX = [
  { prefix: /^P04/i,   family: "EGR",    label: "Code famille EGR / recyclage gaz",                presta: "EGR" },
  { prefix: /^P20[0-9A-F]/i, family: "FAP", label: "Code famille post-traitement (FAP/SCR)",       presta: "DIAG" },
  { prefix: /^P22/i,   family: "ADBLUE", label: "Code famille SCR / AdBlue",                       presta: "ADBLUE" },
  { prefix: /^P02/i,   family: "TURBO",  label: "Code famille suralimentation/turbo",              presta: "DIAG" },
  { prefix: /^P03/i,   family: "ALLUMAGE", label: "Code famille allumage / ratés",                 presta: "DIAG" },
  { prefix: /^P00/i,   family: "MELANGE", label: "Code famille mélange / sondes",                  presta: "DIAG" },
  { prefix: /^B/i,     family: "CARROSSERIE", label: "Code carrosserie / habitacle",               presta: "AUTRES" },
  { prefix: /^C/i,     family: "CHASSIS", label: "Code châssis / ABS / ESP",                       presta: "DIAG" },
  { prefix: /^U/i,     family: "RESEAU",  label: "Code réseau communication CAN",                  presta: "DIAG" },
];

/**
 * Détecte tous les codes DTC dans un texte.
 * @param {string} text
 * @returns {Array<{code:string,family:string,label:string,presta:string}>}
 */
function detectDtcCodes(text) {
  const t = String(text || "").toUpperCase();
  const found = [];
  const seen = new Set();
  let m;
  // Reset lastIndex (regex /g)
  DTC_REGEX.lastIndex = 0;
  while ((m = DTC_REGEX.exec(t)) !== null) {
    const code = (m[1] + m[2]).toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);

    const known = DTC_KNOWN[code];
    if (known) {
      found.push({ code, ...known });
      continue;
    }
    // Fallback : famille par préfixe
    const fam = DTC_FAMILY_BY_PREFIX.find(f => f.prefix.test(code));
    if (fam) {
      found.push({ code, family: fam.family, label: fam.label, presta: fam.presta });
    } else {
      found.push({ code, family: "INCONNU", label: "Code défaut non répertorié", presta: "DIAG" });
    }
  }
  return found;
}

// ====== 2) Détection kilométrage ======
// On retire d'abord les codes DTC du texte (sinon "P0420" pourrait être lu comme 420 km),
// puis on cherche tous les nombres plausibles avec des heuristiques.
//
// Patterns supportés :
//   - "150 000 km", "150000 km", "150 000kms", "150 000 kilomètres"
//   - "120k", "120 k km", "80k km"
//   - "150 000" (suivi de "km" facultatif si l'unité est ailleurs dans la phrase)

// Pour éviter les faux positifs (ex: "150 000 €"), on exige toujours un
// indicateur de kilométrage à proximité : suffixe "km"/"kilomètres" OU
// présence du mot-clé "km"/"compteur" dans la phrase.
const KM_WITH_UNIT_RE  = /\b(\d{1,3})[\s.\u202f](\d{3})\s*(?:km|kms|kilom[èe]tres?)\b/gi;   // "150 000 km"
const KM_PLAIN_RE      = /\b(\d{4,7})\s*(?:km|kms|kilom[èe]tres?)\b/gi;                    // "80000 km"
const KM_SUFFIX_K_RE   = /\b(\d{2,3})\s*k\b(?!\w)/gi;                                       // "120k"
// Fallback : "150 000" sans unité, mais SEULEMENT si le mot "km" / "compteur" / "kilomètres" apparaît ailleurs dans la phrase.
const KM_LOOSE_RE      = /\b(\d{1,3})[\s.\u202f](\d{3})\b/g;
const KM_CONTEXT_RE    = /\b(km|kms|kilom[èe]tres?|compteur|au\s*compteur)\b/i;

/**
 * Détecte le kilométrage dans un texte.
 * @param {string} text
 * @returns {number|null} kilométrage en km, ou null si non détecté
 */
function detectMileage(text) {
  let t = String(text || "");
  // Retirer les codes DTC pour éviter qu'ils soient lus comme des km
  t = t.replace(DTC_REGEX, " ");

  const candidates = [];
  let m;

  // Pattern "150 000 km" (avec unité collée)
  KM_WITH_UNIT_RE.lastIndex = 0;
  while ((m = KM_WITH_UNIT_RE.exec(t)) !== null) {
    const km = parseInt(m[1] + m[2], 10);
    if (km >= 1000 && km <= 1500000) candidates.push(km);
  }

  // Pattern "80000 km"
  KM_PLAIN_RE.lastIndex = 0;
  while ((m = KM_PLAIN_RE.exec(t)) !== null) {
    const km = parseInt(m[1], 10);
    if (km >= 1000 && km <= 1500000) candidates.push(km);
  }

  // Pattern "120k"
  KM_SUFFIX_K_RE.lastIndex = 0;
  while ((m = KM_SUFFIX_K_RE.exec(t)) !== null) {
    const km = parseInt(m[1], 10) * 1000;
    if (km >= 1000 && km <= 1500000) candidates.push(km);
  }

  // Pattern "150 000" sans unité — uniquement si la phrase parle de km/compteur
  if (candidates.length === 0 && KM_CONTEXT_RE.test(t)) {
    KM_LOOSE_RE.lastIndex = 0;
    while ((m = KM_LOOSE_RE.exec(t)) !== null) {
      const km = parseInt(m[1] + m[2], 10);
      if (km >= 1000 && km <= 1500000) candidates.push(km);
    }
  }

  if (candidates.length === 0) return null;
  // En cas de plusieurs candidats, on prend le plus grand (souvent le kilométrage)
  return Math.max(...candidates);
}

/**
 * Conseil basé sur le kilométrage (utile pour suggérer FAP/EGR/diag).
 * @param {number} km
 * @returns {{suggestion:string, presta:string}|null}
 */
function getMileageAdvice(km) {
  if (!km || typeof km !== "number") return null;
  if (km >= 200000) return {
    suggestion: "Kilométrage élevé → un diagnostic complet est recommandé avant toute intervention pour vérifier l'état moteur.",
    presta: "DIAG",
  };
  if (km >= 150000) return {
    suggestion: "À ce kilométrage, le FAP est souvent encrassé sur les diesels — possible candidat pour suppression FAP ou diagnostic.",
    presta: "FAP",
  };
  if (km >= 100000) return {
    suggestion: "Kilométrage moyen — un Stage 1 ou un diagnostic préventif peut être pertinent selon l'état du véhicule.",
    presta: "DIAG",
  };
  if (km >= 30000) return {
    suggestion: "Kilométrage idéal pour un Stage 1 (moteur rodé, marges mécaniques optimales).",
    presta: "REPROG",
  };
  return null;
}

// ====== 3) Détection de symptômes ======
// Mots-clés courants → famille + prestation suggérée
const SYMPTOMS = [
  // FAP
  { re: /\b(voyant\s+fap|fap\s+(boucher|bouch[ée]|saturer|satur[ée]|colmat[ée])|filtre\s+(à|a)?\s*particules)\b/i,
    label: "Symptôme FAP", presta: "FAP" },
  { re: /\b(fum[ée]e\s+noire|fum[ée]e\s+grasse)\b/i,
    label: "Fumée noire (souvent FAP/EGR/injection)", presta: "DIAG" },
  { re: /\b(r[ée]g[ée]n[ée]ration\s+(impossible|rat[ée]e|en\s+cours))\b/i,
    label: "Problème de régénération FAP", presta: "FAP" },

  // EGR
  { re: /\b(vanne\s+egr|egr\s+(boucher|bouch[ée]|encrass[ée]|d[ée]fectueuse?))\b/i,
    label: "Symptôme EGR", presta: "EGR" },

  // AdBlue
  { re: /\b(adblue|ad\s*blue|message\s+adblue|d[ée]marrage\s+impossible\s+(dans|sous)\s+\d+\s*km|scr|nox)\b/i,
    label: "Symptôme AdBlue/SCR", presta: "ADBLUE" },

  // Voyant moteur / mode dégradé
  { re: /\b(voyant\s+(moteur|orange|jaune|d[ée]faut)|check\s+engine|mode\s+d[ée]grad[ée])\b/i,
    label: "Voyant moteur ou mode dégradé", presta: "DIAG" },

  // Perte de puissance (souvent reprog/diag)
  { re: /\b(perte\s+de\s+puissance|manque\s+de\s+puissance|moteur\s+bride|bride|gros\s+ralenti)\b/i,
    label: "Perte de puissance", presta: "DIAG" },

  // À-coups / ratés
  { re: /\b(à[\s-]coups|a[\s-]coups|saccade|rat[ée]s?\s+(d'?allumage|moteur)|broute)\b/i,
    label: "À-coups / ratés moteur", presta: "DIAG" },

  // Démarrage difficile
  { re: /\b(d[ée]marrage\s+(difficile|long|impossible)|ne\s+d[ée]marre\s+pas|pr[ée]chauffage)\b/i,
    label: "Problème de démarrage", presta: "DIAG" },

  // Surconsommation / fumée
  { re: /\b(surconsommation|consomme\s+trop|fum[ée]e\s+blanche|fum[ée]e\s+bleue)\b/i,
    label: "Surconsommation ou fumée anormale", presta: "DIAG" },

  // Performance / gain de puissance
  { re: /\b(gain\s+de\s+puissance|plus\s+de\s+puissance|optimisation|cartographie|stage\s*[1234])\b/i,
    label: "Demande de gain de puissance", presta: "REPROG" },

  // Économie / E85
  { re: /\b(consommation|[ée]conomie\s+(de\s+)?carburant|[ée]thanol|e85|flexfuel|bio[ée]thanol)\b/i,
    label: "Recherche d'économie carburant", presta: "E85" },
];

/**
 * Détecte les symptômes mentionnés dans le texte.
 * @param {string} text
 * @returns {Array<{label:string, presta:string}>}
 */
function detectSymptoms(text) {
  const t = String(text || "");
  const found = [];
  const seen = new Set();
  for (const s of SYMPTOMS) {
    if (s.re.test(t)) {
      if (seen.has(s.label)) continue;
      seen.add(s.label);
      found.push({ label: s.label, presta: s.presta });
    }
  }
  return found;
}

// ====== 4) Construction du contexte structuré pour le LLM ======
/**
 * Construit un bloc texte à injecter dans le system prompt du LLM si quelque
 * chose d'intéressant a été détecté (DTC, km, symptôme).
 * Retourne "" si rien à signaler.
 *
 * @param {string} text - Message du client
 * @param {object} [vehicle] - Optionnel : véhicule si déjà connu
 * @returns {string}
 */
function buildDiagnosticContext(text, vehicle) {
  const dtcs = detectDtcCodes(text);
  const km = detectMileage(text);
  const symptoms = detectSymptoms(text);

  if (dtcs.length === 0 && km === null && symptoms.length === 0) return "";

  const parts = [];
  parts.push("DIAGNOSTIC PRÉ-ANALYSÉ DU MESSAGE CLIENT (utilise ces infos pour orienter ta réponse) :");

  if (dtcs.length > 0) {
    parts.push("• Codes défauts détectés :");
    for (const d of dtcs) {
      parts.push(`  - ${d.code} (${d.family}) — ${d.label} → suggérer prestation ${d.presta}`);
    }
  }

  if (km !== null) {
    const advice = getMileageAdvice(km);
    parts.push(`• Kilométrage mentionné : ${km.toLocaleString("fr-FR")} km`);
    if (advice) {
      parts.push(`  → ${advice.suggestion} (prestation ${advice.presta})`);
    }
  }

  if (symptoms.length > 0) {
    parts.push("• Symptômes mentionnés :");
    for (const s of symptoms) {
      parts.push(`  - ${s.label} → suggérer prestation ${s.presta}`);
    }
  }

  if (vehicle && (vehicle.make || vehicle.model || vehicle.year || vehicle.fuel)) {
    const v = [vehicle.make, vehicle.model, vehicle.year, vehicle.fuel].filter(Boolean).join(" ");
    parts.push(`• Véhicule connu : ${v}`);
  }

  parts.push("");
  parts.push("INSTRUCTIONS SPÉCIFIQUES :");
  parts.push("- Si plusieurs codes/symptômes pointent vers la même prestation → propose-la directement.");
  parts.push("- Si codes mixtes ou ambigus → propose un Diagnostic complet (DIAG).");
  parts.push("- Explique brièvement (1-2 phrases) ce que signifie le code/symptôme avant de proposer l'action.");
  parts.push("- Termine par une question d'engagement type \"Tu veux qu'on lance le devis pour [prestation] ?\"");
  parts.push("- Si tu retournes type=\"intent\", choisis la prestation la plus directement liée aux codes/symptômes.");

  return parts.join("\n");
}

module.exports = {
  detectDtcCodes,
  detectMileage,
  getMileageAdvice,
  detectSymptoms,
  buildDiagnosticContext,
  // Exposé pour les tests / extensibilité
  DTC_KNOWN,
  DTC_FAMILY_BY_PREFIX,
  SYMPTOMS,
};
