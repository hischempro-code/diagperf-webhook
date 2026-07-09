/**
 * intent-router.js — Routing automatique LLM → flows
 *
 * Permet au LLM de router finement vers n'importe quel état d'un flow
 * avec des données pré-extraites du message client.
 *
 * Format de routing supporté :
 * {
 *   "type": "route",
 *   "target": "WAITING_PLATE|WAITING_VEHICLE_CONFIRM|WAITING_QUOTE_CONFIRM|...",
 *   "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV",
 *   "data": { "plate": "...", "vehicle": {...}, "addons": [...], ... },
 *   "message": "Message optionnel à afficher avant/action"
 * }
 */

// Logger local simple (compatible avec le pattern utilisé dans autres modules)
const log = {
  info: (...a) => console.log("[intent-router]", ...a),
  warn: (...a) => console.warn("[intent-router]", ...a),
  error: (...a) => console.error("[intent-router]", ...a),
  debug: (...a) => console.debug("[intent-router]", ...a),
};

// Map des intents valides
const VALID_INTENTS = new Set([
  "REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES", "SAV"
]);

// Map des états valides pour le routing — noms réels utilisés dans prestation.js / sav.js
const VALID_STATES = new Set([
  // États prestations (prestation.js)
  "WAITING_PLATE",
  "WAITING_VEHICLE_CONFIRM",
  "VEHICLE_INCOMPATIBLE",
  "WAITING_QUOTE_CONFIRM",
  "WAITING_UPSELL",
  "WAITING_DEVIS_CONTACT",
  "WAITING_POST_QUOTE_CHOICE",
  "AWAITING_RDV_COORDINATES",
  "AWAITING_CITY_FOR_TRAVEL",
  // États SAV (sav.js)
  "SAV_TOPIC",
  "SAV_COORDINATES",
  "SAV_DESCRIPTION",
  // Fallback
  "MENU",
  "HUMAN_HANDOFF"
]);

/**
 * Parse et valide une instruction de routing LLM
 * @param {object} llmResult - Résultat brut du LLM
 * @returns {object|null} - Instruction normalisée ou null si invalide
 */
function parseRoutingInstruction(llmResult) {
  if (!llmResult || typeof llmResult !== "object") return null;

  // Format legacy : type=intent → convertir en route vers WAITING_PLATE
  if (llmResult.type === "intent" && llmResult.intent) {
    if (!VALID_INTENTS.has(llmResult.intent)) {
      log.warn("Invalid intent from LLM", { intent: llmResult.intent });
      return null;
    }
    return {
      type: "route",
      target: "WAITING_PLATE",
      intent: llmResult.intent,
      data: {},
      message: llmResult.message || null,
    };
  }

  // Format nouveau : type=route avec target explicite
  if (llmResult.type === "route") {
    let target = llmResult.target;
    const intent = llmResult.intent;

    if (!intent || !VALID_INTENTS.has(intent)) {
      log.warn("Invalid or missing intent for route", { intent });
      return null;
    }

    if (!target || !VALID_STATES.has(target)) {
      // Le LLM invente parfois des états ("QUOTE_CONFIRMED"…). L'intent et les data
      // (plaque !) restent exploitables → rabattre sur l'état d'entrée sûr plutôt
      // que de tout jeter (retourner null finissait en "Je n'ai pas bien saisi").
      const fallbackTarget = intent === "SAV" ? "SAV_TOPIC" : "WAITING_PLATE";
      log.warn("Invalid routing target, falling back to safe entry state", { target, fallbackTarget, intent });
      target = fallbackTarget;
    }

    const confidence = llmResult.confidence || 0.8;
    const safeTarget = capTargetByConfidence(target, confidence);

    return {
      type: "route",
      target: safeTarget,
      intent,
      data: sanitizeRouteData(llmResult.data || {}),
      message: llmResult.message || null,
      confidence,
    };
  }

  return null;
}

/**
 * Sanitize les données de routing pour éviter l'injection.
 * Filtre les clés autorisées ET valide les valeurs.
 */
function sanitizeRouteData(data) {
  const allowedKeys = [
    "plate", "vehicle", "vehicleYear", "addons", "priceCents", "priceTtc",
    "customerName", "customerEmail", "customerPhone", "preferredDate",
    "preferredTime", "symptoms", "dtcCodes", "mileage", "ticketType",
    "ticketDescription", "photosProvided", "skipConfirmation", "reason",
  ];

  const sanitized = {};
  for (const key of allowedKeys) {
    if (data[key] !== undefined) sanitized[key] = data[key];
  }

  // Validation des valeurs scalaires sensibles
  if (sanitized.plate !== undefined) {
    sanitized.plate = typeof sanitized.plate === "string"
      ? (sanitized.plate.replace(/[^A-Z0-9\-]/gi, "").slice(0, 9).toUpperCase() || null)
      : null;
  }
  if (sanitized.vehicleYear !== undefined) {
    const yr = parseInt(sanitized.vehicleYear, 10);
    sanitized.vehicleYear = (yr >= 1900 && yr <= new Date().getFullYear() + 2) ? yr : null;
  }
  if (sanitized.priceCents !== undefined) {
    const p = parseInt(sanitized.priceCents, 10);
    sanitized.priceCents = (Number.isInteger(p) && p > 0 && p < 10_000_00) ? p : null;
  }
  if (sanitized.mileage !== undefined) {
    const m = parseInt(sanitized.mileage, 10);
    sanitized.mileage = (Number.isInteger(m) && m > 0 && m < 2_000_000) ? m : null;
  }
  if (sanitized.customerEmail !== undefined) {
    sanitized.customerEmail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(sanitized.customerEmail || ""))
      ? String(sanitized.customerEmail).slice(0, 254)
      : null;
  }

  return sanitized;
}

// Confiance minimale requise pour atteindre chaque état cible
// Plus l'état est "profond" dans le flow, plus la confiance requise est haute
const STATE_CONFIDENCE_FLOOR = {
  "WAITING_PLATE": 0.5,
  "VEHICLE_INCOMPATIBLE": 0.65,
  "WAITING_VEHICLE_CONFIRM": 0.7,
  "WAITING_UPSELL": 0.75,
  "WAITING_QUOTE_CONFIRM": 0.8,
  "WAITING_DEVIS_CONTACT": 0.82,
  "WAITING_POST_QUOTE_CHOICE": 0.85,
  "AWAITING_RDV_COORDINATES": 0.85,
  "AWAITING_CITY_FOR_TRAVEL": 0.85,
  "SAV_TOPIC": 0.5,
  "SAV_COORDINATES": 0.65,
  "SAV_DESCRIPTION": 0.75,
  "HUMAN_HANDOFF": 0.65,
  "MENU": 0.5,
};

/**
 * Plafonne l'état cible en fonction de la confiance LLM.
 * Si la confiance est insuffisante pour l'état demandé, on retombe sur WAITING_PLATE.
 */
function capTargetByConfidence(target, confidence) {
  const required = STATE_CONFIDENCE_FLOOR[target] ?? 0.9;
  if (confidence >= required) return target;
  const isSav = target?.startsWith?.("SAV_");
  log.warn("Routing confidence too low for target, capping to safe state", { target, confidence, required });
  return isSav ? "SAV_TOPIC" : "WAITING_PLATE";
}

/**
 * Détermine si un routing est "sûr" (confiance suffisante)
 */
function isRoutingSafe(instruction, minConfidence = 0.7) {
  if (!instruction || instruction.type !== "route") return false;
  return (instruction.confidence || 0) >= minConfidence;
}

/**
 * Enrichit le system prompt du LLM avec les instructions de routing
 * À appeler pour construire le prompt final
 */
function buildRoutingInstructions() {
  return `
ROUTING AVANCÉ (optionnel) — Tu peux router directement vers un état spécifique :

Si tu as TOUTES les infos nécessaires dans le message du client, retourne :
{
  "type": "route",
  "target": "NOM_ETAT",
  "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV",
  "data": { ... },
  "confidence": 0.9
}

États disponibles pour routing :
- WAITING_PLATE → demande la plaque (défaut si tu n'es pas sûr)
- WAITING_VEHICLE_CONFIRM → le véhicule est connu, attend confirmation
- WAITING_QUOTE_CONFIRM → devis prêt, attend confirmation client
- WAITING_POST_QUOTE_CHOICE → devis confirmé, choix RDV ou envoi devis
- AWAITING_RDV_COORDINATES → demande date/heure de RDV
- WAITING_UPSELL → propose options additionnelles
- WAITING_DEVIS_CONTACT → demande nom/email/tel pour envoyer le devis
- VEHICLE_INCOMPATIBLE → véhicule incompatible, propose alternatives
- SAV_TOPIC → flux SAV, choix du type de problème
- SAV_DESCRIPTION → flux SAV, description détaillée

Champs data utiles :
- plate: "AB123CD" (si plaque détectée)
- vehicle: { make, model, fuel, horsepower, year } (si véhicule identifié)
- vehicleYear: 2019
- addons: ["FAP", "EGR"] (options additionnelles détectées)
- priceCents: 49000 (prix en centimes si calculable)
- customerName, customerEmail, customerPhone
- preferredDate, preferredTime
- symptoms, dtcCodes, mileage
- skipConfirmation: true (si le client a déjà confirmé implicitement)

⚠️ N'utilise le routing avancé que si tu as vraiment toutes les infos.
Sinon, retourne le format classique { "type": "intent", "intent": "..." }.

Exemple routing avancé :
Client: "Je veux une reprog pour ma Golf 7 GTI 2018 AB123CD, c'est pour quand ?"
→ { "type": "route", "target": "WAITING_POST_QUOTE_CHOICE", "intent": "REPROG", "data": { "plate": "AB123CD", "vehicle": { "make": "Volkswagen", "model": "Golf 7 GTI", "year": 2018 }, "skipConfirmation": true }, "confidence": 0.95 }
`;
}

/**
 * Crée l'état de conversation initial basé sur une instruction de routing
 */
function createInitialStateFromRoute(instruction) {
  const { target, intent, data } = instruction;

  const baseState = {
    intent,
    state: target,
    data: {
      // Données de base toujours présentes
      plate: data.plate || null,
      vehicle: data.vehicle || null,
      vehicleYear: data.vehicleYear || null,
      confirmed: false,
      // Flags selon le target
      skip_confirmation: data.skipConfirmation || false,
      // Métadonnées
      routed_at: new Date().toISOString(),
      routed_by: "llm",
      route_confidence: instruction.confidence || 0.8,
    }
  };

  // Enrichir selon l'état cible
  switch (target) {
    case "WAITING_PLATE":
      // État initial par défaut, pas de données spéciales
      break;

    case "WAITING_VEHICLE_CONFIRM":
      baseState.data.confirmed = false;
      baseState.data.vehicle_confirmed = false;
      break;

    case "WAITING_QUOTE_CONFIRM":
      if (data.priceCents) {
        baseState.data.price_cents = data.priceCents;
        baseState.data.price_is_ttc = data.priceTtc !== false;
      }
      if (data.addons) {
        baseState.data.selected_addons = data.addons;
      }
      baseState.data.quote_ready = true;
      break;

    case "WAITING_POST_QUOTE_CHOICE":
      baseState.data.confirmed = true;
      baseState.data.quote_confirmed_at = new Date().toISOString();
      if (data.priceCents) {
        baseState.data.price_cents = data.priceCents;
      }
      break;

    case "AWAITING_RDV_COORDINATES":
      baseState.data.appointment_requested = true;
      if (data.preferredDate) {
        baseState.data.preferred_date = data.preferredDate;
      }
      if (data.preferredTime) {
        baseState.data.preferred_time = data.preferredTime;
      }
      break;

    case "WAITING_UPSELL":
      baseState.data.upsell_offered = true;
      if (data.addons) {
        baseState.data.selected_addons = data.addons;
      }
      break;

    case "WAITING_DEVIS_CONTACT":
      baseState.data.contact_requested = true;
      if (data.customerName) baseState.data.customer_name = data.customerName;
      if (data.customerEmail) baseState.data.customer_email = data.customerEmail;
      if (data.customerPhone) baseState.data.customer_phone = data.customerPhone;
      break;

    case "VEHICLE_INCOMPATIBLE":
      baseState.data.incompatible = true;
      if (data.reason) baseState.data.incompatible_reason = data.reason;
      break;

    case "SAV_TOPIC":
      baseState.data.ticket_type = data.ticketType || null;
      break;

    case "SAV_DESCRIPTION":
      if (data.ticketDescription) {
        baseState.data.ticket_description = data.ticketDescription;
      }
      break;

    case "MENU":
      baseState.state = null;
      baseState.data = {};
      break;

    case "HUMAN_HANDOFF":
      baseState.data.human_requested = true;
      baseState.data.handoff_reason = data.reason || "client_request";
      break;
  }

  return baseState;
}

/**
 * Détermine si on peut "sauter" une étape grâce aux données pré-extraites
 */
function canSkipStep(currentState, targetState, data) {
  // Si on a déjà la plaque et qu'on va vers WAITING_PLATE → on peut sauter
  if (targetState === "WAITING_PLATE" && data.plate) {
    return { canSkip: true, skipTo: "WAITING_VEHICLE_CONFIRM", reason: "plate_provided" };
  }

  // Si on a véhicule confirmé et qu'on va vers WAITING_VEHICLE_CONFIRM → sauter vers devis
  if (targetState === "WAITING_VEHICLE_CONFIRM" && data.vehicle && data.skipConfirmation) {
    return { canSkip: true, skipTo: "WAITING_QUOTE_CONFIRM", reason: "vehicle_preconfirmed" };
  }

  // Si devis déjà confirmé implicitement
  if (targetState === "WAITING_QUOTE_CONFIRM" && data.skipConfirmation) {
    return { canSkip: true, skipTo: "WAITING_POST_QUOTE_CHOICE", reason: "quote_preconfirmed" };
  }

  return { canSkip: false };
}

module.exports = {
  parseRoutingInstruction,
  isRoutingSafe,
  capTargetByConfidence,
  createInitialStateFromRoute,
  canSkipStep,
  buildRoutingInstructions,
  VALID_INTENTS,
  VALID_STATES,
  STATE_CONFIDENCE_FLOOR,
};
