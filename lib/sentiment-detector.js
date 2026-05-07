// ====== Sentiment / Frustration Detector ======
// Détecte la frustration, la colère, l'urgence ou les demandes explicites
// d'escalade vers un humain dans les messages WhatsApp du client.
//
// Retourne un score et un "signal" structuré pour décider :
//   - continuer avec le bot
//   - proposer une escalade humaine (bouton)
//   - escalade automatique immédiate (cas critiques)
//
// Usage :
//   const { detectSentiment } = require("./lib/sentiment-detector");
//   const s = detectSentiment(userMessage, { repeatCount, lastStates });
//   if (s.shouldEscalate) { ...notifyGarage... }

"use strict";

// ====== Patterns de frustration / colère ======
// Chaque règle : re = regex, severity = 1..3, reason (FR)
const FRUSTRATION_PATTERNS = [
  // Insultes / grossièretés (fort)
  { re: /\b(putain|merde|bordel|connard|con(?:ne)?|salope|enculé|nique|ntm|fdp|ta\s*gueule|ferme\s*la)\b/i,
    severity: 3, reason: "Vocabulaire grossier / insultes" },

  // Colère explicite
  { re: /\b(nul|pourri|catastrophe|honteux|scandaleux|inadmissible|inacceptable|arnaque|voleur|escroc)\b/i,
    severity: 3, reason: "Colère / accusation forte" },

  // Menaces / actions légales ou publiques
  { re: /\b(avocat|tribunal|procès|porter\s*plainte|d[ée]nonc[ée]r|google\s*avis|mauvais\s*avis|signalement|60\s*millions|que\s*choisir)\b/i,
    severity: 3, reason: "Menace légale / avis négatif" },

  // Frustration modérée
  { re: /\b(marre|ras\s*le\s*bol|en\s*ai\s*marre|en\s*ai\s*assez|j'abandonne|laisse\s*tomber|jamais\s*content)\b/i,
    severity: 2, reason: "Frustration exprimée" },

  // Problème récurrent / bot qui ne comprend pas
  { re: /\b(comprends?\s*(pas|rien)|comprend\s*(pas|rien)|r[ée]ponds?\s*pas|bot\s*(nul|pourri|debile|d[ée]bile)|r[ée]p[ée]te|redit|pour\s*la\s*(\d+|[a-z]+)\s*fois|(fait|depuis)\s*\d+\s*fois\s*que)\b/i,
    severity: 2, reason: "Le bot ne répond pas / boucle" },

  // Demande explicite d'humain → severity 3 (déclenche seule l'escalade)
  { re: /\b(parler\s*[aà]\s*(un|quelqu|une\s*personne)|un\s*agent|op[ée]rateur|vrai(e)?\s*(personne|humain|gens)|\bhumain\b|conseiller|t[ée]l[ée]phone|rappel(ez|er|[ée]|le)(\s*moi)?|\bt[ée]l\b)\b/i,
    severity: 3, reason: "Demande explicite d'un humain" },

  // Urgence
  { re: /\b(urgent|urgence|vite|rapidement|tout\s*de\s*suite|imm[ée]diatement|asap|en\s*panne|bloqu[ée]?\s*sur\s*(la\s*)?route|d[ée]panne)\b/i,
    severity: 2, reason: "Urgence / panne" },

  // Mécontentement léger
  { re: /\b(d[ée]çu|pas\s*content|pas\s*satisfait|probl[èe]me|souci|qualit[ée]\s*m[ée]diocre)\b/i,
    severity: 1, reason: "Mécontentement léger" },
];

// Signaux d'urgence → escalade immédiate (même seuil 1 suffit)
const CRITICAL_PATTERNS = [
  /\b(en\s*panne|bloqu[ée]?\s*sur\s*(la\s*)?route|ne\s*d[ée]marre\s*plus|accident|feu|fum[ée]e\s*(sous\s*)?capot|voyant\s*rouge)\b/i,
];

/**
 * Analyse un message et retourne un signal de sentiment.
 *
 * @param {string} text - Message utilisateur
 * @param {object} [ctx] - Contexte optionnel
 * @param {number} [ctx.repeatCount] - Nb de fois que le bot a re-proposé les mêmes boutons récemment
 * @param {boolean} [ctx.hasStateLoop] - Vrai si le client tourne en rond dans un même état
 * @returns {{
 *   score: number,
 *   level: 'ok'|'mild'|'frustrated'|'angry',
 *   reasons: string[],
 *   critical: boolean,
 *   shouldEscalate: boolean,
 *   suggestion: string|null,
 * }}
 */
function detectSentiment(text, ctx = {}) {
  const t = String(text || "");
  if (t.length < 2) {
    return { score: 0, level: "ok", reasons: [], critical: false, shouldEscalate: false, suggestion: null };
  }

  let score = 0;
  const reasons = [];
  let critical = false;

  for (const p of FRUSTRATION_PATTERNS) {
    if (p.re.test(t)) {
      score += p.severity;
      reasons.push(p.reason);
    }
  }

  // Bonus si MAJUSCULES (>60% de lettres en majuscules sur texte >10 chars)
  const letters = t.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
  if (letters.length >= 10) {
    const upper = letters.replace(/[^A-ZÀ-ÖØ-Þ]/g, "").length;
    if (upper / letters.length > 0.6) {
      score += 1;
      reasons.push("Écriture en majuscules (cris)");
    }
  }

  // Bonus si ponctuation excessive "!!!" / "???"
  if (/[!?]{3,}/.test(t)) {
    score += 1;
    reasons.push("Ponctuation excessive (!!! / ???)");
  }

  // Bonus si bot qui re-propose les mêmes boutons
  if (typeof ctx.repeatCount === "number" && ctx.repeatCount >= 3) {
    score += 2;
    reasons.push(`Client bloqué dans le même état (${ctx.repeatCount} répétitions)`);
  } else if (ctx.hasStateLoop) {
    score += 1;
    reasons.push("Client en boucle sur le même état");
  }

  // Détection cas critique (panne, urgence)
  if (CRITICAL_PATTERNS.some((re) => re.test(t))) {
    critical = true;
    reasons.push("Situation critique détectée");
  }

  // Niveau global
  let level = "ok";
  if (score >= 5) level = "angry";
  else if (score >= 3) level = "frustrated";
  else if (score >= 1) level = "mild";

  // Décision escalade
  //  - Tout score >= 3 → escalade recommandée (bouton parler à un humain)
  //  - critical = true → escalade immédiate
  //  - "parler à un humain" explicite (severity 2 dans pattern humain) + 1 autre signal → escalade
  const shouldEscalate = score >= 3 || critical;

  let suggestion = null;
  if (shouldEscalate) {
    if (critical) {
      suggestion = "Proposer IMMÉDIATEMENT le contact garage (panne/urgence détectée).";
    } else if (level === "angry") {
      suggestion = "Apaiser + proposer un contact humain direct (le client est en colère).";
    } else {
      suggestion = "Proposer un contact humain (le client semble frustré ou demande un agent).";
    }
  }

  return { score, level, reasons, critical, shouldEscalate, suggestion };
}

module.exports = {
  detectSentiment,
  FRUSTRATION_PATTERNS,
  CRITICAL_PATTERNS,
};
