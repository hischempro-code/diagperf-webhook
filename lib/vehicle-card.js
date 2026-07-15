/**
 * vehicle-card.js — Génération de la fiche performance véhicule personnalisée DiagPerf
 * Affichée automatiquement après identification de la plaque.
 */

// Même règle que le flow (validateIntentForVehicle) pour la compatibilité AdBlue :
// la fiche ne doit pas promettre une suppression AdBlue à un diesel sans système SCR
// (ex: Audi A4 2010) — sinon le client la demande et le flow la refuse.
const { _hasAdBlueSystem } = require("./vehicle-service");

const STAGE1_FIXED_PRICE = 390;
const E85_FIXED_PRICE = 490;
const FAP_FIXED_PRICE_OLD = 260;
const FAP_FIXED_PRICE_NEW = 300;

/**
 * Détecte le type de carburant depuis les champs véhicule.
 */
function normalizeFuel(fuel = "", trim = "") {
  const f = (fuel + " " + trim).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/electr|bev|\bev\b/.test(f)) return "electric";
  if (/hybride|hybrid|hev|phev|mhev/.test(f)) return "hybrid";
  if (/diesel|hdi|tdi|dci|cdti|bluehdi|d4d|crdi|jtd/.test(f)) return "diesel";
  if (/essence|sp\d|gpl|gnv|tfsi|tsi|tce|puretech|thp|gdi|vti|hpi/.test(f)) return "essence";
  // Dernier recours: si le nom de carburant contient "E" → essence
  if (/\bE\b|\bessence\b/i.test(fuel)) return "essence";
  return "unknown";
}

/**
 * Estime les gains Stage 1 selon la puissance, le carburant et la cylindrée.
 * Returns null si le moteur est trop faible ou atmosphérique.
 */
function estimateGains(powerHp, fuelType, engineCc) {
  if (!powerHp || powerHp < 70 || powerHp > 500) return null;
  const cc = engineCc || 1600;
  const hpPerLiter = powerHp / (cc / 1000);

  // Moteurs atmosphériques : gains trop faibles pour être mentionnés
  const isTurbo = hpPerLiter > 55 || powerHp > 130;
  if (!isTurbo) return null;

  // Gains moyens constatés : diesel ~22%, essence turbo ~26%
  const gainPct = fuelType === "diesel" ? 0.22 : 0.26;
  const gainHp = Math.max(15, Math.round(powerHp * gainPct / 5) * 5);
  return { gainHp, newHp: powerHp + gainHp, pct: Math.round(gainPct * 100) };
}

/**
 * Estime le prix Stage 1.
 */
function stage1PriceText(powerHp, year) {
  // Bornes STRICTES, alignées sur computeReprogPrice (flow) + la grille RAG (< 400ch, < 2018).
  // Avant, "<=" affichait 390€ pour un 2018/400ch pile → puis le flow générait "sur devis" → incohérence.
  if (powerHp && powerHp < 400 && year && year < 2018) return `*${STAGE1_FIXED_PRICE}€ TTC*`;
  return "sur devis";
}

/**
 * Estime le prix E85.
 */
function e85PriceText(year) {
  // Borne STRICTE, alignée sur computeE85Price (flow) + grille RAG (< 2020).
  if (year && year < 2020) return `*${E85_FIXED_PRICE}€ TTC*`;
  return "sur devis";
}

/**
 * Construit la fiche performance complète pour la confirmation véhicule.
 * @param {object} vehicle — Objet véhicule issu de lookupVehicleFromPlate
 * @returns {string} Message WhatsApp formaté
 */
function buildVehiclePerformanceCard(vehicle) {
  if (!vehicle) return null;

  const make = vehicle.make || "";
  const model = vehicle.model || "";
  const year = parseInt(vehicle.year, 10) || 0;
  const power = parseInt(vehicle.power_hp, 10) || 0;
  const cc = vehicle.engine_cc ? `${vehicle.engine_cc}cc` : "";
  const fuel = vehicle.fuel || "";
  const codeMoteur = vehicle.code_moteur || vehicle.engine_code || null;

  const fuelType = normalizeFuel(fuel, vehicle.trim || "");
  const isEssence = fuelType === "essence";
  const isDiesel = fuelType === "diesel";
  const isHybridOrEV = fuelType === "hybrid" || fuelType === "electric";
  // Motorisation non reconnue par l'API → on NE DEVINE PAS essence/diesel (anti-hallucination).
  const isUnknownFuel = !isEssence && !isDiesel && !isHybridOrEV;

  // Gains chiffrés uniquement si la motorisation est connue : sinon on ne peut pas
  // choisir le bon barème (diesel ~22% vs essence ~26%) → gains génériques.
  const gains = (power && !isHybridOrEV && !isUnknownFuel) ? estimateGains(power, fuelType, vehicle.engine_cc) : null;

  const lines = [];

  // ── Identité véhicule ──
  const vehicleName = [make, model].filter(Boolean).join(" ");
  lines.push(`🚗 *${vehicleName}*${year ? ` (${year})` : ""}`);
  const engineParts = [fuel, cc, power ? `*${power} ch*` : null].filter(Boolean);
  if (engineParts.length > 0) lines.push(engineParts.join(" | "));
  if (codeMoteur) lines.push(`🔧 Code moteur : ${codeMoteur}`);
  lines.push("");

  if (isHybridOrEV) {
    lines.push(`⚠️ Véhicule ${fuelType === "electric" ? "électrique" : "hybride"} — contactez-nous pour les options disponibles.`);
    lines.push(`📞 *06 75 54 70 85*`);
    lines.push("");
  } else {
    // ── Potentiel Stage 1 ──
    if (gains) {
      lines.push(`🚀 *Stage 1 DiagPerf :*`);
      lines.push(`   ${power} ch → *~${gains.newHp} ch* _(+${gains.gainHp} ch)_`);
    } else {
      lines.push(`🚀 *Stage 1 DiagPerf :* disponible — gains personnalisés`);
    }

    // ── Économies E85 ──
    if (isEssence) {
      lines.push(`⛽ *E85 Flexfuel :* économies estimées *~700 €/an*`);
    }

    lines.push("");

    // ── Grille de compatibilités ──
    const s1Price = stage1PriceText(power, year);
    lines.push(`📋 *Compatibilités :*`);
    lines.push(`   ✅ Stage 1 — ${s1Price} • ⏱ 1h30`);

    if (isEssence) {
      lines.push(`   ✅ E85 — ${e85PriceText(year)} • ⏱ 1h30`);
      lines.push(`   ❌ FAP / EGR / AdBlue _(moteur essence)_`);
    } else if (isDiesel) {
      const fapPrice = (year && year >= 2019) ? FAP_FIXED_PRICE_NEW : FAP_FIXED_PRICE_OLD;
      lines.push(`   ✅ Suppression FAP — *${fapPrice}€ TTC* • ⏱ 1h à 1h30`);
      lines.push(`   ✅ Suppression EGR — *190€ TTC* • ⏱ 1h`);
      // AdBlue uniquement si le véhicule a un système SCR (cohérent avec le flow)
      if (_hasAdBlueSystem(vehicle)) {
        lines.push(`   ✅ Suppression AdBlue — *à partir de 260€ TTC* • ⏱ 1h30`);
      }
      lines.push(`   ❌ E85 _(moteur diesel)_`);
    } else {
      // Motorisation non déterminée : ne PAS affirmer une compatibilité carburant inventée.
      lines.push(`   ℹ️ E85 / FAP / EGR / AdBlue : compatibilité confirmée selon la motorisation exacte`);
    }

    lines.push("");
    lines.push(`🛡️ *Garantie* : se référer à nos CGV — Devis gratuit, sans engagement`);
    lines.push("");
  }

  lines.push(`Est-ce bien votre véhicule ?`);

  return lines.join("\n");
}

/**
 * Message de "chargement" envoyé immédiatement après réception de la plaque.
 * Crée l'effet "analyse en temps réel".
 */
function buildAnalysisStartMessage(plate) {
  return `🔍 *${plate}* — identification véhicule en cours ⏳`;
}

/**
 * Message intermédiaire envoyé après l'identification, avant la fiche.
 */
function buildAnalysisProgressMessage(vehicle) {
  const make = vehicle?.make || "";
  const model = vehicle?.model || "";
  const name = [make, model].filter(Boolean).join(" ");
  return `⚡ *${name || "Véhicule"}* identifié — génération du profil DiagPerf...`;
}

module.exports = {
  buildVehiclePerformanceCard,
  buildAnalysisStartMessage,
  buildAnalysisProgressMessage,
  normalizeFuel,
  estimateGains,
};
