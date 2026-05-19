const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const { retrieveContext, formatContextForPrompt, preloadEmbedder } = require("./rag");
const { renderStageGainsVideo, renderPrestationVideo } = require("./lib/creatomateVideo");
const { buildDiagnosticContext, detectDtcCodes, detectMileage, detectSymptoms } = require("./lib/diagnostic-helper");
const { detectSentiment } = require("./lib/sentiment-detector");
const {
  getClientProfile,
  updateClientProfile,
  extractProfileSignals,
  buildMemoryContext,
  shouldSummarize,
  summarizeAndStore,
} = require("./lib/conversation-memory");
const {
  parseRoutingInstruction,
  createInitialStateFromRoute,
  buildRoutingInstructions,
} = require("./lib/intent-router");
const {
  VOICE_TYPES,
  handleVoiceMessage,
  getErrorMessage,
  isTranscript,
} = require("./lib/voice-handler");
const {
  extractAndValidatePlate,
} = require("./lib/plate-extractor");
const { createDashboardRouter } = require("./routes/dashboard");
const {
  isGreetingOrReset,
  extractInboundText,
  extractInteractiveId,
  normalizePlate,
  validatePlate,
  validateEmail,
} = require("./lib/text-helpers");
const {
  initEmailService,
  sendQuoteEmail,
  sendContactRecapEmail,
  sendRdvClientEmail,
  sendRdvDiagperfEmail,
  sendSavClientEmail,
  sendSavDiagperfEmail,
} = require("./lib/email-service");
const {
  initVehicleService,
  parseNumberFromString,
  parseYearFromDateFR,
  slugify,
  mapFuelToCarburant,
  lookupReprogStages,
  formatStageLabel,
  fetchVehicleFromPlate,
  standardizeVehicleData,
  lookupVehicleFromPlate,
  STAGE1_FIXED_PRICE_CENTS,
  TTC_INTENTS,
  CUSTOM_QUOTE_STAGES,
  computeReprogPrice,
  computeE85Price,
  computeAdbluePrice,
  computeEgrPrice,
  computeFapPrice,
  _isDieselVehicle,
  _isEssenceVehicle,
  _hasAdBlueSystem,
  INTENT_VEHICLE_REQUIREMENTS,
  validateIntentForVehicle,
  UPSELL_OPTIONS,
  getUpsellOptionsForVehicle,
  buildUpsellMessage,
  UPSELL_INTENTS,
  buildVehicleOnlyText,
} = require("./lib/vehicle-service");
const {
  initDevisService,
  getPrestationTarif,
  getPrestationLibelle,
  createDevis,
  addUpsellOptionsToDevis,
} = require("./lib/devis-service");
const {
  initLlmService,
  ANTHROPIC_API_KEY,
  LLM_MODEL,
  LLM_SYSTEM_PROMPT,
  isLikelyQuestion,
  askLLM,
} = require("./lib/llm-service");
const {
  INTENT_MAP,
  detectIntent,
  intentToPrestationCode,
  intentToLabel,
} = require("./lib/intent-detector");
const {
  initEventHandlers,
  notifyGarage,
  handleFrustrationEscalation,
  handleEscalationButtons,
  createReviewRequest,
  processReviewRequests,
  handleReviewRating,
  handleGarageDoneCommand,
  REVIEW_CHECK_INTERVAL_MS,
} = require("./lib/event-handlers");
const { initRelanceService, runRelances } = require("./lib/relance-service");
const {
  initConversationService,
  getConversationState,
  setConversationState,
  clearConversationState,
  getRecentMessages,
} = require("./lib/conversation-service");
const { createPrestationFlow } = require("./flows/prestation");
const { createSavFlow } = require("./flows/sav");
const { createWebhookHandler } = require("./routes/webhook");
const { initPdfService, sendQuotePdf } = require("./lib/pdf-service");
const {
  initMediaBuilders,
  DIAGPERF_LOCATION,
  buildTravelEstimateMessage,
  getVehicleImageUrl,
  buildGainsChartUrl,
  buildSingleStageChartUrl,
  buildVehicleCardUrl,
  buildPrestationCardUrl,
  sendMenuList,
} = require("./lib/media-builders");
const {
  initWhatsAppClient,
  markAsRead,
  sendTypingIndicator,
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppList,
  sendWhatsAppImage,
  sendWhatsAppVideo,
  sendWhatsAppLocation,
  sendWhatsAppDocument,
  uploadWhatsAppMedia,
} = require("./lib/whatsapp-client");

// Node 18+ => fetch global. Node <18 => fallback node-fetch
const fetchFn = global.fetch || require("node-fetch");

// ====== WhatsApp API version (centralized) ======
const WA_API_VERSION = "v19.0";

// ====== Retry utility (for transient API failures) ======
async function withRetry(fn, { retries = 2, delayMs = 500, label = "API call" } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === retries;
      const status = err?.status || err?.response?.status;
      const isRetryable = !status || status >= 500 || status === 429;
      if (isLast || !isRetryable) throw err;
      const wait = delayMs * Math.pow(2, attempt);
      log.warn(`${label}: retry ${attempt + 1}/${retries} in ${wait}ms`, { error: String(err?.message || err) });
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

dotenv.config();

// ====== Validation des variables d'environnement ======
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ====== Brevo SMTP init ======
let _emailTransporter = null;
if (process.env.BREVO_SMTP_KEY) {
  _emailTransporter = nodemailer.createTransport({
    host: "smtp-relay.brevo.com",
    port: 587,
    secure: false,
    auth: {
      user: process.env.BREVO_SMTP_LOGIN || "abcf2c001@smtp-brevo.com",
      pass: process.env.BREVO_SMTP_KEY,
    },
  });
  console.log(`✅ Brevo SMTP configuré (from: ${process.env.EMAIL_FROM || "diag.perf.pro@gmail.com"})`);
} else {
  console.warn("⚠️ BREVO_SMTP_KEY absent, emails désactivés");
}

// ====== Logger structuré (zéro dépendance) ======
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || "info"] ?? LOG_LEVELS.info;

const log = {
  _fmt(level, msg, meta) {
    const ts = new Date().toISOString();
    const prefix = meta?.wa_id ? `[${meta.wa_id}]` : "";
    const extra = meta ? ` ${JSON.stringify(meta)}` : "";
    return `${ts} ${level.toUpperCase()} ${prefix} ${msg}${extra}`;
  },
  debug(msg, meta) { if (LOG_LEVEL <= 0) console.debug(log._fmt("debug", msg, meta)); },
  info(msg, meta)  { if (LOG_LEVEL <= 1) console.log(log._fmt("info", msg, meta)); },
  warn(msg, meta)  { if (LOG_LEVEL <= 2) console.warn(log._fmt("warn", msg, meta)); },
  error(msg, meta) { if (LOG_LEVEL <= 3) console.error(log._fmt("error", msg, meta)); },
};

// ====== Init services ======
initEmailService({ transporter: _emailTransporter, log });
initVehicleService({ supabase, log, fetchFn });
initDevisService({ supabase, log });
// initWhatsAppClient called after insertOutboundMessage is defined (see below)

const app = express();

// ====== RAW BODY pour signature ======
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ====== Static files ======
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

// ====== OG Preview Image (for WhatsApp link preview) ======
let _ogImageCache = null;
let _ogImageCacheTime = 0;
const OG_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
app.get("/og-preview.png", async (req, res) => {
  try {
    if (_ogImageCache && (Date.now() - _ogImageCacheTime) < OG_CACHE_TTL) {
      res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      return res.send(_ogImageCache);
    }
    const chart = {
      type: "bar",
      data: {
        labels: ["Suivi devis", "Validation", "Notifications"],
        datasets: [{
          data: [100, 100, 100],
          backgroundColor: ["#3b82f6", "#6366f1", "#8b5cf6"],
          barThickness: 50,
          borderRadius: 8,
        }],
      },
      options: {
        indexAxis: "y",
        layout: { padding: { top: 40, bottom: 30, left: 40, right: 40 } },
        plugins: {
          title: {
            display: true,
            text: ["🏁 DIAGPERF", "━━━━━━━━━━━━━━━━━━━━━━━━━", "Votre Espace Client"],
            font: { size: 32, weight: "bold", family: "Arial" },
            color: "#f9fafb",
            padding: { bottom: 16 },
          },
          subtitle: {
            display: true,
            text: ["📊 Suivi en temps réel  •  ✅ Validation en 1 clic  •  🔔 Alertes", "", "Reprogrammation & Diagnostic Automobile"],
            font: { size: 15, weight: "bold", family: "Arial" },
            color: "#94a3b8",
            padding: { bottom: 12 },
          },
          legend: { display: false },
        },
        scales: {
          x: { display: false, max: 100 },
          y: { grid: { display: false }, ticks: { font: { size: 14, weight: "bold" }, color: "#d1d5db" } },
        },
      },
    };
    const encoded = encodeURIComponent(JSON.stringify(chart));
    const url = `https://quickchart.io/chart?c=${encoded}&w=1200&h=630&bkg=%23060611&v=4&f=png`;
    const imgResp = await fetchFn(url);
    if (!imgResp.ok) throw new Error(`QuickChart ${imgResp.status}`);
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    _ogImageCache = buffer;
    _ogImageCacheTime = Date.now();
    res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.send(buffer);
  } catch (err) {
    log.debug("OG preview image error", { error: String(err?.message || err) });
    res.status(502).send("Image unavailable");
  }
});

// ====== GET verification (Meta challenge) ======
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get("/health", (_req, res) => res.status(200).send("OK"));

// ====== Dashboard & Client API routes (extracted) ======
const { router: dashboardRouter, broadcastDashboardEvent } = createDashboardRouter({ supabase, log, transporter: _emailTransporter });
app.use(dashboardRouter);

// ====== Signature check ======
function verifyMetaSignature(req) {
  const signature = req.get("x-hub-signature-256"); // "sha256=..."
  const appSecret = process.env.META_APP_SECRET;

  if (!signature) return { ok: false, reason: "missing_signature_header" };
  if (!appSecret) return { ok: false, reason: "missing_META_APP_SECRET" };
  if (!req.rawBody) return { ok: false, reason: "missing_raw_body" };

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", appSecret).update(req.rawBody).digest("hex");

  // Comparaison en temps constant sur des buffers de taille fixe (71 = "sha256=" + 64 hex)
  const SIG_LEN = 71;
  const sigBuf = Buffer.alloc(SIG_LEN, 0);
  const expBuf = Buffer.alloc(SIG_LEN, 0);
  Buffer.from(signature.slice(0, SIG_LEN), "utf8").copy(sigBuf);
  Buffer.from(expected.slice(0, SIG_LEN), "utf8").copy(expBuf);
  const bytesMatch = crypto.timingSafeEqual(sigBuf, expBuf);
  const ok = bytesMatch && signature.length === expected.length;
  return { ok, reason: ok ? "ok" : "bad_signature" };
}

// ====== Supabase: Conversation helpers ======
async function getOrCreateConversation(waPhone) {
  const { data: existing, error: selErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("wa_phone", waPhone)
    .maybeSingle();

  if (selErr) throw selErr;
  if (existing?.id) return existing.id;

  const { data: created, error: insErr } = await supabase
    .from("conversations")
    .insert({ wa_phone: waPhone, contexte_json: {} })
    .select("id")
    .single();

  if (insErr) throw insErr;
  return created.id;
}

async function resetConversationContext(conversationId) {
  const { error } = await supabase
    .from("conversations")
    .update({ contexte_json: {} })
    .eq("id", conversationId);

  if (error) throw error;
}

// ====== Messages insert ======
async function insertInboundMessage({
  conversationId,
  waMessageId,
  text,
  timestamp,
  raw,
}) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      direction: "in",
      wa_message_id: waMessageId,
      body: text,
      ts: Number(timestamp),
      raw_payload: raw,
    })
    .select("id, conversation_id")
    .single();

  if (error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("duplicate") || msg.includes("unique")) {
      log.warn("Duplicate inbound message, skip", { wa_message_id: waMessageId });
      return { inserted: false, conversation_id: conversationId };
    }
    throw error;
  }

  return {
    inserted: true,
    conversation_id: data.conversation_id,
    message_id: data.id,
  };
}

// ====== Outbound message insert (best effort, fire & forget) ======
async function insertOutboundMessage(to, text) {
  try {
    const convId = await getOrCreateConversation(to);
    await supabase.from("messages").insert({
      conversation_id: convId,
      direction: "out",
      body: text,
      ts: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    log.warn("insertOutboundMessage failed", { to, error: String(err?.message || err) });
  }
}

initWhatsAppClient({ log, fetchFn, WA_API_VERSION, insertOutboundMessage });
initPdfService({ log, uploadWhatsAppMedia, sendWhatsAppDocument });
initMediaBuilders({ log, fetchFn, sendWhatsAppImage, sendWhatsAppList });
initConversationService({ log, supabase });

// ====== Init LLM service (needs getRecentMessages + getConversationState) ======
initLlmService({ supabase, log, fetchFn, getRecentMessages, getConversationState });
initEventHandlers({ log, supabase, sendWhatsAppText, sendWhatsAppInteractiveButtons, setConversationState, clearConversationState, getConversationState, sendMenuList });
initRelanceService({ log, supabase, sendWhatsAppText });

// ====== Voice transcription (Groq Whisper — free tier) ======
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

// ====== Non-text message types (media, calls, etc.) ======
// VOICE_TYPES imported from lib/voice-handler
const NON_TEXT_TYPES = new Set(["image", "video", "sticker", "location", "contacts", "unsupported", "order", "system", "reaction", "document"]);

// ====== Anti-spam for missed call / media auto-reply (5 min cooldown, persistent) ======
const NON_TEXT_COOLDOWN_MS = 300000; // 5 min

async function getNonTextCooldown(waId) {
  try {
    const convId = await getOrCreateConversation(waId);
    const { data } = await supabase.from("conversations").select("contexte_json").eq("id", convId).single();
    return data?.contexte_json?.last_non_text_reply_at || 0;
  } catch { return 0; }
}

async function setNonTextCooldown(waId) {
  try {
    const convId = await getOrCreateConversation(waId);
    const { data } = await supabase.from("conversations").select("contexte_json").eq("id", convId).single();
    const ctx = data?.contexte_json || {};
    ctx.last_non_text_reply_at = Date.now();
    await supabase.from("conversations").update({ contexte_json: ctx }).eq("id", convId);
  } catch (err) {
    log.warn("setNonTextCooldown failed", { waId, error: String(err?.message || err) });
  }
}

// ====== Helper : répondre à une question off-topic via LLM puis re-proposer les boutons ======
// Retourne : { handled: true, redirected?: true } | false
// - Si le LLM détecte un intent → redirige vers le flow approprié (clear state + dispatch)
// - Si le LLM répond à une question FAQ → envoie la réponse + re-propose les boutons
// - Sinon retourne false → l'appelant re-propose les boutons normalement.
async function tryOffTopicAnswer({ fromWa, text, retryMessage, retryButtons, rawMsg }) {
  const t = String(text || "").trim();
  // Ne pas appeler le LLM pour les réponses courtes de type bouton (oui/non/chiffre/menu)
  if (t.length < 4) return false;
  if (/^(oui|non|yes|no|ok|okay|d['']accord|confirmer|annuler|suivant|passer|skip|ajouter|menu|\d{1,2})\.?$/i.test(t)) return false;

  // Check for direct intent keywords first (e.g. user types "reprog" mid-SAV)
  const { detectIntent } = require("./lib/intent-detector");
  const directIntent = detectIntent(text);
  if (directIntent) {
    log.info("Mid-flow intent change detected (keyword)", { wa_id: fromWa, intent: directIntent });
    await clearConversationState(fromWa);
    const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
    const mapped = menuMap[directIntent] || text;
    const prestaHandled = await handlePrestationFlow(fromWa, mapped, rawMsg || {});
    if (prestaHandled) return { handled: true, redirected: true };
    const savHandled = await handleSavFlow(fromWa, mapped, rawMsg || {});
    if (savHandled) return { handled: true, redirected: true };
  }

  try {
    const llmResult = await askLLM(text, fromWa);
    if (!llmResult) return false;

    // LLM detected an intent change → redirect user to the correct flow
    if (llmResult.type === "intent" && llmResult.intent) {
      const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
      const mapped = menuMap[llmResult.intent];
      if (mapped) {
        log.info("Mid-flow intent change detected (LLM)", { wa_id: fromWa, intent: llmResult.intent });
        await clearConversationState(fromWa);
        const prestaHandled = await handlePrestationFlow(fromWa, mapped, rawMsg || {});
        if (prestaHandled) return { handled: true, redirected: true };
        const savHandled = await handleSavFlow(fromWa, mapped, rawMsg || {});
        if (savHandled) return { handled: true, redirected: true };
      }
    }

    // LLM answered a FAQ question → send answer + re-propose buttons
    if (llmResult.type === "answer" && llmResult.message) {
      await sendWhatsAppText(fromWa, llmResult.message);
      if (retryMessage && retryButtons) {
        await sendWhatsAppInteractiveButtons(fromWa, retryMessage, retryButtons);
      }
      log.info("Off-topic question answered via LLM + retry buttons", { wa_id: fromWa });
      return { handled: true };
    }

    return false;
  } catch (err) {
    log.warn("Off-topic LLM answer failed", { wa_id: fromWa, error: String(err?.message || err) });
    return false;
  }
}

// ====== Helper unifié : fallback d'un état interactif ======
// Combine tryOffTopicAnswer + re-proposition des boutons en une seule ligne.
// À utiliser à la place du pattern manuel dans TOUS les états interactifs.
//
// Usage type :
//   return respondOrAnswerQuestion(fromWa, text, "Est-ce bien votre véhicule ?", [...buttons], rawMsg);
//
// Handles:
// 1. Intent change → redirects to the correct flow seamlessly
// 2. FAQ question → answers via LLM then re-proposes current buttons
// 3. Neither → just re-proposes the current buttons
async function respondOrAnswerQuestion(fromWa, text, retryMessage, retryButtons, rawMsg) {
  const result = await tryOffTopicAnswer({ fromWa, text, retryMessage, retryButtons, rawMsg });
  if (result && result.handled) return true;
  // If retryMessage is null, caller handles fallback UI themselves
  if (!retryMessage) return false;
  await sendWhatsAppInteractiveButtons(fromWa, retryMessage, retryButtons);
  return true;
}

// ====== Prestation flow (extracted to flows/prestation.js) ======
let handlePrestationFlow, PRESTATION_INTENTS, handleSavFlow;
({ handlePrestationFlow, PRESTATION_INTENTS } = createPrestationFlow({
  supabase, log,
  sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppList: sendWhatsAppList,
  sendWhatsAppImage, sendWhatsAppVideo, sendWhatsAppLocation,
  setConversationState, clearConversationState, getConversationState,
  sendMenuList, notifyGarage, broadcastDashboardEvent,
  respondOrAnswerQuestion, askLLM,
  sendQuotePdf, buildGainsChartUrl, buildVehicleCardUrl,
  buildPrestationCardUrl, renderStageGainsVideo, getVehicleImageUrl,
  buildTravelEstimateMessage, extractAndValidatePlate,
  DIAGPERF_LOCATION,
  sendRdvClientEmail, sendRdvDiagperfEmail, sendContactRecapEmail,
}));

// ====== SAV flow (extracted to flows/sav.js) ======
({ handleSavFlow } = createSavFlow({
  supabase, log,
  sendWhatsAppInteractiveButtons, sendWhatsAppImage,
  setConversationState, clearConversationState, getConversationState,
  notifyGarage, getVehicleImageUrl,
  sendSavClientEmail, sendSavDiagperfEmail,
  respondOrAnswerQuestion,
}));

// ====== POST webhook events (extracted to routes/webhook.js) ======
app.post("/webhook", createWebhookHandler({
  supabase, log,
  verifyMetaSignature,
  sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppLocation,
  markAsRead, sendTypingIndicator,
  getConversationState, setConversationState, clearConversationState,
  getOrCreateConversation, insertInboundMessage, resetConversationContext,
  sendMenuList, DIAGPERF_LOCATION,
  handleVoiceMessage, VOICE_TYPES, getErrorMessage, GROQ_API_KEY,
  WA_API_VERSION, fetchFn,
  NON_TEXT_TYPES, NON_TEXT_COOLDOWN_MS, getNonTextCooldown, setNonTextCooldown,
  handleGarageDoneCommand, handleReviewRating,
  handleEscalationButtons, handleFrustrationEscalation,
  handlePrestationFlow, handleSavFlow,
  askLLM,
}));

// ====== Start server ======
const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  log.info(`Webhook en écoute sur http://localhost:${port}`);
  // Pré-charger le modèle d'embeddings en arrière-plan (améliore la latence du 1er appel RAG)
  preloadEmbedder().catch(() => {});
});

// ====== Scheduler : demandes d'avis client (toutes les 5 min) ======
const reviewInterval = setInterval(() => {
  processReviewRequests().catch(err => {
    log.error("Review scheduler error", { error: String(err?.message || err) });
  });
}, REVIEW_CHECK_INTERVAL_MS);
log.info(`Scheduler avis client démarré (intervalle: ${REVIEW_CHECK_INTERVAL_MS / 1000}s)`);

// ====== Scheduler : relances devis (toutes les heures, sans tir initial) ======
const relanceInterval = setInterval(() => runRelances().catch(err => log.error("Relance scheduler error", { error: String(err?.message || err) })), 60 * 60 * 1000);
log.info("Scheduler relances devis démarré (intervalle: 1h)");

// ====== Graceful shutdown ======
function gracefulShutdown(signal) {
  log.info(`${signal} reçu, arrêt gracieux...`);
  clearInterval(reviewInterval);
  clearInterval(relanceInterval);
  server.close(() => {
    log.info("Serveur arrêté proprement");
    process.exit(0);
  });
  setTimeout(() => {
    log.warn("Arrêt forcé après timeout (10s)");
    process.exit(1);
  }, 10000);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

// Capture les erreurs async non catchées (sinon silencieuses sur Render)
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled Promise rejection", { reason: String(reason?.message || reason) });
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { error: String(err?.message || err), stack: err?.stack?.slice(0, 500) });
});
