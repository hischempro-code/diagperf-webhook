/**
 * config/index.js — Configuration centralisée
 */

require("dotenv").config();

// ====== Validation env vars ======
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_VERIFY_TOKEN",
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("❌ Variables d'environnement manquantes:", missing.join(", "));
  process.exit(1);
}

// ====== Configuration ======
const config = {
  // API Versions
  WA_API_VERSION: "v19.0",
  
  // Ports & URLs
  PORT: process.env.PORT || 3000,
  
  // Tokens & Keys
  DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN || "diagperf_admin_2026",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  
  // Feature flags
  VERIFY_SIGNATURE: (process.env.VERIFY_SIGNATURE || "false").toLowerCase() === "true",
  
  // Timeouts & Intervals
  NON_TEXT_COOLDOWN_MS: 300000, // 5 min
  REVIEW_CHECK_INTERVAL_MS: 300000, // 5 min
  
  // Limits
  MAX_AUDIO_SIZE_MB: 20,
  MAX_TRANSCRIPT_LENGTH: 2000,
  
  // Pricing (centimes)
  STAGE1_FIXED_PRICE_CENTS: 39000,
  
  // Location
  DIAGPERF_LOCATION: {
    latitude: 48.945,
    longitude: 2.853,
    name: "DiagPerf",
    address: "38 Rue Jean Pierre Plicque, 77124 Villenoy",
  },
};

// ====== Constants ======
const PRESTATION_INTENTS = new Set(["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES"]);
const MANUAL_QUOTE_INTENTS = new Set(["AUTRES"]);
const CUSTOM_QUOTE_STAGES = new Set(["stage2", "stage3", "stage4"]);
const TTC_INTENTS = new Set(["REPROG", "E85", "FAP", "ADBLUE", "EGR", "DIAG"]);

const UPSELL_INTENTS = new Set(["FAP", "ADBLUE", "E85", "REPROG"]);
const NON_TEXT_TYPES = new Set(["image", "video", "sticker", "location", "contacts", "unsupported", "order", "system", "reaction", "document"]);

const DIAG_OPTIONS = [
  {
    id: "diag_1",
    title: "Diagnostic simple",
    description: "Lecture & effacement défauts",
    detail: "Lecture et effacement des codes défaut",
    priceTtcCents: 5000,
    duration: "20 min",
  },
  {
    id: "diag_2",
    title: "Diag approfondi",
    description: "Interprétation + remise à zéro",
    detail: "Lecture, interprétation des défauts et remise à zéros des compteurs",
    priceTtcCents: 8000,
    duration: "35 min",
  },
  {
    id: "diag_3",
    title: "Recherche de panne",
    description: "Diag, test, analyse données",
    detail: "Recherche de panne électrique (diagnostic, test, analyse de données)",
    priceTtcCents: 13000,
    duration: "1h",
  },
];

const MENU_MAP = {
  REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8"
};

const INTENT_LABELS = {
  REPROG: "🏎️ Reprogrammation moteur",
  E85: "⛽ Conversion E85",
  FAP: "🔧 Suppression FAP",
  EGR: "🔧 Suppression EGR",
  ADBLUE: "🔧 Suppression AdBlue",
  DIAG: "🔍 Diagnostic",
  AUTRES: "🎨 Autres services",
  SAV: "🛠️ SAV / Support",
};

// ====== LLM Config ======
const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-20250414";

module.exports = {
  config,
  PRESTATION_INTENTS,
  MANUAL_QUOTE_INTENTS,
  CUSTOM_QUOTE_STAGES,
  TTC_INTENTS,
  UPSELL_INTENTS,
  NON_TEXT_TYPES,
  DIAG_OPTIONS,
  MENU_MAP,
  INTENT_LABELS,
  LLM_MODEL,
  REQUIRED_ENV,
};
