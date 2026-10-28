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

// Variables utiles mais NON bloquantes : leur absence ne doit pas tuer le bot
// (SAV, diagnostic, chat continuent de tourner), mais elle casse silencieusement
// une fonctionnalité précise. On alerte FORT dans les logs pour rendre le bug visible.
const RECOMMENDED_ENV = [
  ["IMMATRICULATION_API_URL", "recherche véhicule par plaque"],
  ["IMMATRICULATION_API_TOKEN", "recherche véhicule par plaque"],
  ["GOOGLE_AI_API_KEY", "embeddings RAG — source unique des prix/compatibilités pour le LLM"],
  ["DASHBOARD_TOKEN", "auth du dashboard admin — sans elle le dashboard est inaccessible"],
  ["WEB_CHAT_TOKEN", "auth du chat du site — sans elle la fenêtre de discussion du site reste fermée"],
];
const missingRecommended = RECOMMENDED_ENV.filter(([k]) => !process.env[k]);
if (missingRecommended.length) {
  console.warn(
    "⚠️  Variables recommandées manquantes:",
    missingRecommended.map(([k, usage]) => `${k} (${usage})`).join(", "),
    "\n   → Les fonctionnalités listées échoueront tant qu'elles ne sont pas définies (ex: sur Render → Environment)."
  );
}

// Sécurité : sans VERIFY_SIGNATURE=true, n'importe qui peut POSTer sur /webhook
// en se faisant passer pour Meta (injection de faux messages clients).
// Activation sûre : passer d'abord VERIFY_SIGNATURE=shadow (logge le verdict sans
// rejeter) pour confirmer que META_APP_SECRET est correct, PUIS =true pour enforcer.
{
  const _sigMode = (process.env.VERIFY_SIGNATURE || "false").toLowerCase();
  if (_sigMode === "true") {
    console.log("✅ VERIFY_SIGNATURE=true — signature HMAC des webhooks Meta vérifiée (enforce).");
  } else if (_sigMode === "shadow") {
    console.warn("🕵️  VERIFY_SIGNATURE=shadow — verdict signature loggé mais NON enforcé. Vérifier les logs 'Signature (shadow) — OK' puis passer à =true.");
  } else {
    console.warn("⚠️  VERIFY_SIGNATURE désactivé — la signature HMAC des webhooks Meta n'est PAS vérifiée (trou de sécurité). Passer à =shadow puis =true + META_APP_SECRET en production.");
  }
}

// ====== Configuration ======
const config = {
  // API Versions
  WA_API_VERSION: "v19.0",
  
  // Ports & URLs
  PORT: process.env.PORT || 3000,
  
  // Tokens & Keys
  // Pas de token par défaut : un fallback hardcodé committé sur GitHub = dashboard admin ouvert
  DASHBOARD_TOKEN: process.env.DASHBOARD_TOKEN || "",
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
    latitude: 48.9583,
    longitude: 2.8789,
    name: "DiagPerf – Reprogrammation & Diagnostic",
    address: "38 Rue Jean Pierre Plicque, 77124 Villenoy",
  },
};

// ====== Constants ======
const PRESTATION_INTENTS = new Set(["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES", "CARPLAY"]);
const MANUAL_QUOTE_INTENTS = new Set(["AUTRES"]);

// Prestations chiffrées par le garage APRÈS identification du véhicule : pas de prix
// automatique, mais la plaque reste indispensable pour chiffrer.
// CarPlay : le prix dépend du module compatible avec le modèle et son écran d'origine
// (la pièce) + la main-d'œuvre — impossible à fixer à l'avance.
// Parcours : plaque → confirmation véhicule → coordonnées → garage notifié.
const QUOTE_ON_REQUEST_INTENTS = new Set(["CARPLAY"]);
const QUOTE_ON_REQUEST_INFO = {
  CARPLAY: {
    platePrompt: "📱 *Installation CarPlay* ✅\n\nLe module CarPlay dépend de votre modèle et de son écran d'origine.\nEnvoyez votre plaque d'immatriculation (ex: AA 123 BB) pour que l'on prépare votre devis.",
    reason: "Le prix dépend de la pièce (module CarPlay compatible avec votre véhicule) et de la main-d'œuvre : notre équipe vérifie la compatibilité et vous envoie un *devis personnalisé*.",
  },
};
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

// Durée d'intervention par prestation — SOURCE UNIQUE (affichée sur le devis WhatsApp + PDF).
// Alignée sur la grille durées du prompt LLM (lib/llm-service.js). DIAG a sa durée par
// niveau (DIAG_OPTIONS.duration) ; AUTRES = sur devis (variable) → non listé ici.
const PRESTATION_DURATIONS = {
  REPROG: "1h30 à 2h",
  E85: "1h30",
  FAP: "1h à 1h30",
  EGR: "1h",
  ADBLUE: "1h à 1h30",
};

// Téléphone du garage — affiché sur les devis / messages de contact direct.
// (constante unique : évite un numéro copié-collé qui diverge à chaque changement)
const GARAGE_PHONE = process.env.GARAGE_PHONE || "06 75 54 70 85";

// Avertissement E85 — affiché AVEC le devis Conversion E85.
// Raison métier : trop de demandes arrivent pour des véhicules non compatibles éthanol
// (injection directe fragile, moteur non éligible…). Le prix annoncé ne vaut donc que
// sous réserve de compatibilité, confirmée par le garage avant toute réservation.
// WhatsApp ne permet pas la couleur : on utilise 🔴 + gras pour le rendre impossible à rater.
const E85_ESTIMATE_NOTICE = [
  "🔴 *PRIX ESTIMATIF — SOUS RÉSERVE DE COMPATIBILITÉ*",
  "⚠️ *Tous les véhicules essence ne sont PAS compatibles E85.* Le tarif ci-dessus est une estimation ; il dépend de la compatibilité réelle de votre moteur.",
  `📞 *Merci d'appeler directement le garage au ${GARAGE_PHONE}* pour faire vérifier la compatibilité de votre véhicule avant toute réservation.`,
].join("\n");

const MENU_MAP = {
  REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8", CARPLAY: "9"
};

const INTENT_LABELS = {
  REPROG: "🏎️ Reprogrammation moteur",
  E85: "⛽ Conversion E85",
  FAP: "🔧 Suppression FAP",
  EGR: "🔧 Suppression EGR",
  ADBLUE: "🔧 Suppression AdBlue",
  DIAG: "🔍 Diagnostic",
  AUTRES: "🎨 Autres services",
  CARPLAY: "📱 Installation CarPlay",
  SAV: "🛠️ SAV / Support",
};

// ====== LLM Config ======
const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-5-20251001";

module.exports = {
  config,
  PRESTATION_INTENTS,
  MANUAL_QUOTE_INTENTS,
  QUOTE_ON_REQUEST_INTENTS,
  QUOTE_ON_REQUEST_INFO,
  CUSTOM_QUOTE_STAGES,
  TTC_INTENTS,
  UPSELL_INTENTS,
  NON_TEXT_TYPES,
  DIAG_OPTIONS,
  PRESTATION_DURATIONS,
  GARAGE_PHONE,
  E85_ESTIMATE_NOTICE,
  MENU_MAP,
  INTENT_LABELS,
  LLM_MODEL,
  REQUIRED_ENV,
};
