// ====== Pure helper functions (testable, no side-effects) ======

function normalizePlate(input) {
  const cleaned = String(input || "")
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
  const sivPattern = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (sivPattern.test(cleaned)) {
    return cleaned.slice(0, 2) + "-" + cleaned.slice(2, 5) + "-" + cleaned.slice(5);
  }
  return cleaned;
}

function validatePlate(input) {
  const normalized = normalizePlate(input);
  const sivFormat = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
  if (sivFormat.test(normalized)) {
    return { valid: true, plate: normalized };
  }
  return { valid: false, plate: normalized };
}

function isGreetingOrReset(text) {
  const t = String(text || "").trim().toLowerCase();
  const greetings = ["bonjour", "bonsoir", "salut", "salam", "hello", "yo", "coucou"];
  return greetings.includes(t) || t === "menu" || t === "start" || t === "0" || t === "reset" || t === "annuler" || t === "retour" || t === "accueil";
}

function extractInboundText(msg) {
  const type = msg?.type;
  if (type === "text") return msg.text?.body || "";
  if (type === "button") return msg.button?.text || "";
  if (type === "interactive") {
    const btnTitle = msg.interactive?.button_reply?.title;
    const listTitle = msg.interactive?.list_reply?.title;
    return btnTitle || listTitle || "[interactive]";
  }
  return `[${type || "unknown"}]`;
}

function extractInteractiveId(msg) {
  if (msg?.type !== "interactive") return null;
  return msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
}

const INTENT_MAP = {
  REPROG:  { code: "reprogrammation",      menu: "1", keywords: ["reprogrammation", "reprog", "stage"] },
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
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t === cfg.menu) return intent;
  }
  const questionPatterns = [
    /^(combien|quel|quelle|quels|quelles|comment|pourquoi|est[\s-]ce|c'est quoi|qu'est|quoi|où|ou est|ça coute|ca coute)/,
    /\?$/,
    /^(le |la |les |un |une |des )?(prix|tarif|coût|cout|durée|duree|garantie|horaire|adresse|compatib)/,
  ];
  if (questionPatterns.some((re) => re.test(t))) return null;
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (cfg.keywords.some((kw) => t.includes(kw))) return intent;
  }
  return null;
}

const STAGE1_FIXED_PRICE_CENTS = 39000;

function computeReprogPrice(vehicle) {
  const hp = vehicle?.power_hp;
  const year = vehicle?.year;
  if (typeof hp === "number" && hp > 0 && typeof year === "number" && hp < 400 && year < 2018) {
    return STAGE1_FIXED_PRICE_CENTS;
  }
  return null;
}

function computeE85Price(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2020) {
    return 49000;
  }
  return null;
}

function computeFapPrice(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2019) {
    return 26000;
  }
  return 30000;
}

function computeEgrPrice(vehicle) {
  // EGR : 190€ TTC uniquement pour véhicules diesel
  const fuel = String(vehicle?.fuel || "").toLowerCase();
  const isDiesel = /diesel|gazole|hdi|tdi|dci|cdi|bluehdi|d4d|crdi/i.test(fuel);
  if (isDiesel) return 19000;
  return null;
}

function computeAdbluePrice(vehicle) {
  const fields = [
    vehicle?.engine, vehicle?.model, vehicle?.fuel,
    vehicle?.trim, vehicle?.version,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/blue[\s-]?hdi/i.test(fields)) {
    return 26000;
  }
  return 30000;
}

function validateEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return re.test(email) ? email : null;
}

module.exports = {
  normalizePlate,
  validatePlate,
  isGreetingOrReset,
  extractInboundText,
  extractInteractiveId,
  detectIntent,
  computeReprogPrice,
  computeE85Price,
  computeFapPrice,
  computeEgrPrice,
  computeAdbluePrice,
  validateEmail,
  INTENT_MAP,
  STAGE1_FIXED_PRICE_CENTS,
};
