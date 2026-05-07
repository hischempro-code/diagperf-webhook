/**
 * plate-utils.js — Fonctions utilitaires pour les plaques d'immatriculation
 */

/**
 * Normalise une plaque au format standard AA-123-AA
 */
function normalizePlate(input) {
  if (!input) return "";
  const cleaned = String(input)
    .toUpperCase()
    .replace(/[-\s_]/g, "")
    .replace(/[^A-Z0-9]/g, "");
  return cleaned;
}

/**
 * Valide une plaque française (format SIV AA-123-AA)
 */
function validatePlate(input) {
  const normalized = normalizePlate(input);
  const sivFormat = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (sivFormat.test(normalized)) {
    // Format avec tirets pour l'affichage
    const formatted = `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5, 7)}`;
    return { valid: true, plate: formatted, raw: normalized };
  }
  return { valid: false, plate: normalized, raw: input };
}

/**
 * Formate une plaque pour l'affichage (AA-123-AA)
 */
function formatPlate(plate) {
  const normalized = normalizePlate(plate);
  if (normalized.length !== 7) return plate;
  return `${normalized.slice(0, 2)}-${normalized.slice(2, 5)}-${normalized.slice(5, 7)}`;
}

module.exports = {
  normalizePlate,
  validatePlate,
  formatPlate,
};
