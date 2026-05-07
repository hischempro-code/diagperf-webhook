/**
 * plate-extractor.js — Extraction intelligente de plaques d'immatriculation
 *
 * Détecte les plaques françaises (format SIV AA-123-AA) dans du texte libre,
 * même quand elles sont intégrées dans des phrases complètes.
 */

const log = {
  info: (...a) => console.log("[plate]", ...a),
  debug: (...a) => console.debug("[plate]", ...a),
};

// Pattern pour détecter une plaque dans du texte
// Format SIV: AA-123-AA ou variations avec espaces/tirets
const PLATE_PATTERNS = [
  // Format standard avec tirets: AA-123-AA
  /\b([A-Z]{2})[-\s]?([0-9]{1,3})[-\s]?([A-Z]{2})\b/gi,
  // Format collé: AA123AA
  /\b([A-Z]{2})([0-9]{3})([A-Z]{2})\b/gi,
  // Format avec espaces: AA 123 AA
  /\b([A-Z]{2})\s+([0-9]{1,3})\s+([A-Z]{2})\b/gi,
  // Format après ponctuation: : AA123AA ou ; AB-123-CD
  /[:;]\s*([A-Z]{2})([0-9]{3})([A-Z]{2})\b/gi,
  /[:;]\s*([A-Z]{2})[-\s]?([0-9]{1,3})[-\s]?([A-Z]{2})\b/gi,
];

// Pattern pour nettoyer et normaliser
const CLEAN_PATTERN = /[^A-Z0-9]/gi;

// Pattern pour nettoyer le texte avant extraction (retirer ponctuation qui bloque)
const PUNCTUATION_CLEAN_PATTERN = /[:;,]/g;

// Anciennes plaques (format FNI: 123 ABC 45 ou 1234 AB 67)
const OLD_PLATE_PATTERN = /\b(\d{1,4})\s*([A-Z]{1,3})\s*(\d{2})\b/gi;

/**
 * Normalise une plaque au format standard AA-123-AA
 */
function normalizePlate(raw) {
  if (!raw) return null;
  const cleaned = String(raw).toUpperCase().replace(CLEAN_PATTERN, "");
  if (cleaned.length !== 7) return null; // SIV = 2 lettres + 3 chiffres + 2 lettres
  return `${cleaned.slice(0, 2)}-${cleaned.slice(2, 5)}-${cleaned.slice(5, 7)}`;
}

/**
 * Vérifie si une plaque normalisée est valide (format SIV)
 */
function isValidPlate(normalized) {
  if (!normalized) return false;
  // Format AA-123-AA
  const sivFormat = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
  return sivFormat.test(normalized);
}

/**
 * Extrait toutes les plaques potentielles d'un texte
 * @param {string} text - Texte à analyser
 * @returns {Array<{raw: string, normalized: string, valid: boolean, index: number}>}
 */
function extractPlates(text) {
  if (!text || typeof text !== "string") return [];

  const results = [];
  const seen = new Set(); // Éviter les doublons

  // Pré-traitement: remplacer la ponctuation par des espaces pour faciliter la détection
  // Mais garder le texte original pour l'index
  const cleanedText = text.replace(PUNCTUATION_CLEAN_PATTERN, " ");

  for (const pattern of PLATE_PATTERNS) {
    pattern.lastIndex = 0; // Reset regex
    let match;

    while ((match = pattern.exec(cleanedText)) !== null) {
      // Reconstituer la plaque brute depuis le texte nettoyé
      const raw = match[0].trim();
      const normalized = normalizePlate(raw);

      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      // Trouver l'index dans le texte original
      const originalIndex = text.toUpperCase().indexOf(normalized.replace(/-/g, ""));

      results.push({
        raw,
        normalized,
        valid: isValidPlate(normalized),
        index: originalIndex >= 0 ? originalIndex : match.index,
      });
    }
  }

  return results;
}

/**
 * Extrait la première plaque valide trouvée dans le texte
 * @param {string} text - Texte à analyser
 * @returns {{plate: string, index: number}|null}
 */
function extractFirstPlate(text) {
  const plates = extractPlates(text);

  // Priorité aux plaques valides
  const validPlate = plates.find((p) => p.valid);
  if (validPlate) {
    log.debug("Plate extracted", { plate: validPlate.normalized, raw: validPlate.raw });
    return { plate: validPlate.normalized, index: validPlate.index };
  }

  // Sinon prendre la première potentielle (même si invalide)
  if (plates.length > 0) {
    log.debug("Plate extracted (invalid format)", { plate: plates[0].normalized, raw: plates[0].raw });
    return { plate: plates[0].normalized, index: plates[0].index };
  }

  return null;
}

/**
 * Détecte si le texte contient une mention de plaque
 * Utile pour savoir si l'utilisateur parle de sa plaque
 */
function hasPlateMention(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const indicators = [
    /ma\s+plaque\s+(?:est|c'est|:-)\s*/i,
    /plaque\s+(?:d['']?immat|immatriculation)/i,
    /num[eé]ro\s+d['']?immat/i,
    /immat\s*[:-]\s*/i,
    /plaque\s*[:-]\s*/i,
  ];
  return indicators.some((pattern) => pattern.test(t));
}

/**
 * Extrait le contexte autour de la plaque dans le texte
 * Utile pour le LLM
 */
function extractPlateContext(text, plateIndex, contextChars = 50) {
  if (!text || plateIndex < 0) return null;

  const start = Math.max(0, plateIndex - contextChars);
  const end = Math.min(text.length, plateIndex + 7 + contextChars); // 7 = longueur plaque

  return text.slice(start, end).trim();
}

/**
 * Fonction principale: extrait et valide une plaque de texte libre
 * @param {string} text - Texte utilisateur
 * @returns {{plate: string|null, valid: boolean, context: string|null}}
 */
function extractAndValidatePlate(text) {
  const result = extractFirstPlate(text);

  if (!result) {
    return { plate: null, valid: false, context: null };
  }

  const context = extractPlateContext(text, result.index);
  const valid = isValidPlate(result.plate);

  log.info("Plate extraction", {
    plate: result.plate,
    valid,
    hasMention: hasPlateMention(text),
  });

  return {
    plate: result.plate,
    valid,
    context,
  };
}

/**
 * Supprime la plaque du texte pour obtenir le "reste" du message
 * Utile pour analyser l'intent séparément
 */
function removePlateFromText(text, plate) {
  if (!text || !plate) return text;

  // Créer une regex flexible pour la plaque
  const escaped = plate.replace(/-/g, "[-\\s]?");
  const pattern = new RegExp(escaped, "gi");

  return text.replace(pattern, "").replace(/\s+/g, " ").trim();
}

module.exports = {
  extractPlates,
  extractFirstPlate,
  extractAndValidatePlate,
  hasPlateMention,
  extractPlateContext,
  removePlateFromText,
  normalizePlate,
  isValidPlate,
};
