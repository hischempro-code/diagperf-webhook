const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const sgMail = require("@sendgrid/mail");
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
const { createPrestationFlow } = require("./flows/prestation");
const { createSavFlow } = require("./flows/sav");
const { createWebhookHandler } = require("./routes/webhook");
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

// ====== SendGrid init ======
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log("✅ SendGrid configuré");
} else {
  console.warn("⚠️ SENDGRID_API_KEY absent, emails désactivés");
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
initEmailService({ sgMail, log });
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
const { router: dashboardRouter, broadcastDashboardEvent } = createDashboardRouter({ supabase, log, sgMail });
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

  // timingSafeEqual exige même longueur
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "length_mismatch" };

  const ok = crypto.timingSafeEqual(a, b);
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

// ====== WhatsApp: mark message as read (inline removed — now in lib/whatsapp-client.js) ======
// ====== PDF Quote Generator (branded DiagPerf) ======
async function generateQuotePdf({ devisRef, date, vehicleDesc, plate, prestationLabel, stageLabel, gainTxt, htTxt, ttcTxt, tvaTxt, customerName, customerEmail, customerPhone }) {
  const PDFDocument = require("pdfkit");

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // DiagPerf brand colors (matching logo)
    const navy = "#1a237e";
    const red = "#c62828";
    const dark = "#212121";
    const gray = "#616161";
    const lightGray = "#9e9e9e";
    const marginL = 50;
    const marginR = 545;
    const colW = marginR - marginL;

    // ── Header: company info left, logo top-right ──
    const logoPath = path.join(__dirname, "assets", "logo.png");
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 380, 15, { height: 120 });
    }
    doc.fontSize(24).font("Helvetica-Bold").fillColor(navy).text("DIAGPERF", marginL, 40);
    doc.fontSize(10).font("Helvetica").fillColor(gray).text("Reprogrammation & Diagnostic automobile", marginL, 68);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(dark).text("38 Rue Jean Pierre Plicque, 77124 Villenoy", marginL, 84);
    doc.fontSize(9).font("Helvetica-Bold").fillColor(dark).text("contact@diagperf.com  |  06 75 54 70 85", marginL, 97);

    // Navy accent line
    doc.moveTo(marginL, 118).lineTo(marginR, 118).strokeColor(navy).lineWidth(2.5).stroke();
    // Thin red line below
    doc.moveTo(marginL, 122).lineTo(marginR, 122).strokeColor(red).lineWidth(1).stroke();

    // ── DEVIS title + ref ──
    doc.fontSize(20).font("Helvetica-Bold").fillColor(navy).text("DEVIS", marginL, 138);
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(`Référence : ${devisRef}`, 370, 140);
    doc.text(`Date : ${date}`, 370, 158);

    let y = 190;

    // ── Client section (displayed only if customerName provided) ──
    if (customerName) {
      doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
      y += 12;
      doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("CLIENT", marginL, y);
      y += 22;
      doc.fontSize(11).font("Helvetica").fillColor(dark);
      doc.text(customerName, marginL, y);
      y += 18;
      if (customerEmail) { doc.text(customerEmail, marginL, y); y += 18; }
      if (customerPhone) { doc.text(customerPhone, marginL, y); y += 18; }
      y += 10;
    }

    // ── Vehicule section ──
    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("VÉHICULE", marginL, y);
    y += 22;
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(vehicleDesc, marginL, y);
    y += 18;
    doc.text(`Plaque : ${plate}`, marginL, y);

    // ── Prestation section ──
    y += 35;
    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("PRESTATION", marginL, y);
    y += 22;
    doc.fontSize(11).font("Helvetica").fillColor(dark);
    doc.text(prestationLabel + (stageLabel ? ` — ${stageLabel}` : ""), marginL, y);
    y += 18;
    if (gainTxt) {
      doc.font("Helvetica-Bold").fillColor(red).text(`Gains : ${gainTxt}`, marginL, y);
      doc.font("Helvetica").fillColor(dark);
      y += 18;
    }
    doc.text("Durée d'intervention : 2h - 4h", marginL, y);

    // ── Tarification table ──
    y += 40;
    doc.moveTo(marginL, y).lineTo(marginR, y).strokeColor("#e0e0e0").lineWidth(1).stroke();
    y += 12;
    doc.fontSize(13).font("Helvetica-Bold").fillColor(navy).text("TARIFICATION", marginL, y);
    y += 25;

    // Table header (navy background)
    doc.rect(marginL, y, colW, 28).fillAndStroke(navy, navy);
    doc.fontSize(10).font("Helvetica-Bold").fillColor("white");
    doc.text("Désignation", marginL + 12, y + 8, { width: 300 });
    doc.text("Montant", marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    // HT row
    doc.rect(marginL, y, colW, 28).stroke("#dddddd");
    doc.fontSize(10).font("Helvetica").fillColor(dark);
    doc.text("Total HT", marginL + 12, y + 8, { width: 300 });
    doc.text(htTxt, marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    // TVA row
    doc.rect(marginL, y, colW, 28).fillAndStroke("#f5f5f5", "#dddddd");
    doc.fontSize(10).font("Helvetica").fillColor(dark);
    doc.text("TVA (20%)", marginL + 12, y + 8, { width: 300 });
    doc.text(tvaTxt, marginR - 112, y + 8, { width: 100, align: "right" });
    y += 28;

    // TTC row (navy blue background)
    doc.rect(marginL, y, colW, 32).fillAndStroke(navy, navy);
    doc.fontSize(12).font("Helvetica-Bold").fillColor("white");
    doc.text("TOTAL TTC", marginL + 12, y + 9, { width: 300 });
    doc.text(ttcTxt, marginR - 112, y + 9, { width: 100, align: "right" });
    y += 50;

    // ── Garantie ──
    doc.fontSize(12).font("Helvetica-Bold").fillColor(navy).text("GARANTIE", marginL, y);
    y += 20;
    doc.fontSize(9).font("Helvetica").fillColor(gray);
    doc.text("Se référer à nos conditions d'utilisation sur diagperf.com", marginL, y, { width: colW });
    y += 20;

    // ── Conditions ──
    doc.fontSize(9).fillColor(lightGray);
    doc.text(
      "Ce devis est valable 30 jours à compter de sa date d'émission. " +
      "Le paiement est dû à la livraison du véhicule. Moyens de paiement acceptés : CB, espèces, virement.",
      marginL, y, { width: colW }
    );

    // ── Footer (fixed at bottom of page 1) ──
    const footerY = 755;
    doc.moveTo(marginL, footerY).lineTo(marginR, footerY).strokeColor(navy).lineWidth(1).stroke();
    doc.fontSize(8).fillColor(gray);
    doc.text(
      "DiagPerf — 38 Rue Jean Pierre Plicque, 77124 Villenoy — contact@diagperf.com — 06 75 54 70 85",
      marginL, footerY + 8, { width: colW, align: "center" }
    );

    doc.end();
  });
}

// ====== Send PDF quote via WhatsApp (best-effort) ======
async function sendQuotePdf(fromWa, { devisId, plate, vehicle, prestationLabel, stageLabel, gainTxt, devisRow, customerName, customerEmail, customerPhone }) {
  try {
    const vehicleDesc = vehicle
      ? [vehicle.make, vehicle.model, vehicle.version].filter(Boolean).join(" ")
      : "N/A";
    const htCents = devisRow?.total_ht_centimes || 0;
    const ttcCents = devisRow?.total_ttc_centimes || 0;
    const tvaCents = ttcCents - htCents;
    const htTxt = htCents > 0 ? `${(htCents / 100).toFixed(2)} EUR` : "N/A";
    const ttcTxt = ttcCents > 0 ? `${(ttcCents / 100).toFixed(2)} EUR` : "N/A";
    const tvaTxt = tvaCents > 0 ? `${(tvaCents / 100).toFixed(2)} EUR` : "N/A";
    const devisRef = `DEV-${devisId}`;
    const date = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

    const pdfBuffer = await generateQuotePdf({
      devisRef, date, vehicleDesc, plate: plate || "N/A",
      prestationLabel: prestationLabel || "N/A", stageLabel, gainTxt,
      htTxt, ttcTxt, tvaTxt,
      customerName, customerEmail, customerPhone,
    });

    const mediaId = await uploadWhatsAppMedia(pdfBuffer, `${devisRef}.pdf`, "application/pdf");
    await sendWhatsAppDocument(fromWa, mediaId, `${devisRef}.pdf`, `📄 Votre devis ${devisRef}`);
    log.info("sendQuotePdf: PDF envoyé", { wa_id: fromWa, devisRef });
  } catch (err) {
    log.error("sendQuotePdf: erreur (non-blocking)", { wa_id: fromWa, error: String(err?.message || err) });
  }
}

// ====== DiagPerf location constants ======
const DIAGPERF_LOCATION = {
  latitude: 48.9583,
  longitude: 2.8789,
  name: "DiagPerf – Reprogrammation & Diagnostic",
  address: "38 Rue Jean Pierre Plicque, 77124 Villenoy",
};

// ====== Geocoding + estimation trajet (APIs gratuites, sans clé) ======

/**
 * Géocode une ville ou un code postal français via api-adresse.data.gouv.fr
 * @param {string} query - Code postal ou nom de ville (ex: "77124", "Meaux", "Paris 15")
 * @returns {Promise<{lat: number, lng: number, label: string}|null>}
 */
async function geocodeAddress(query) {
  try {
    const q = String(query || "").trim();
    if (!q || q.length < 2) return null;
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1&type=municipality`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    const feat = json?.features?.[0];
    if (!feat) return null;
    const [lng, lat] = feat.geometry.coordinates;
    const label = feat.properties?.label || feat.properties?.city || q;
    return { lat, lng, label };
  } catch (err) {
    log.debug("geocodeAddress failed", { query, error: String(err?.message || err) });
    return null;
  }
}

/**
 * Estime le temps de trajet en voiture depuis un point vers DiagPerf (Villenoy)
 * via l'API OSRM (gratuite, sans clé)
 * @param {number} fromLat
 * @param {number} fromLng
 * @returns {Promise<{durationMin: number, distanceKm: number}|null>}
 */
async function estimateTravelTime(fromLat, fromLng) {
  try {
    const toLat = DIAGPERF_LOCATION.latitude;
    const toLng = DIAGPERF_LOCATION.longitude;
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json();
    const route = json?.routes?.[0];
    if (!route) return null;
    const durationMin = Math.round(route.duration / 60);
    const distanceKm = Math.round(route.distance / 1000);
    return { durationMin, distanceKm };
  } catch (err) {
    log.debug("estimateTravelTime failed", { fromLat, fromLng, error: String(err?.message || err) });
    return null;
  }
}

/**
 * Construit le message d'estimation trajet pour le client
 * @param {string} cityQuery - Code postal ou ville saisie par le client
 * @returns {Promise<string|null>} - Message formaté ou null si échec
 */
async function buildTravelEstimateMessage(cityQuery) {
  const geo = await geocodeAddress(cityQuery);
  if (!geo) return null;
  const travel = await estimateTravelTime(geo.lat, geo.lng);
  if (!travel) return null;
  return (
    `📍 Vous êtes à environ *${travel.durationMin} min* (${travel.distanceKm} km) de DiagPerf !\n\n` +
    `🏁 Départ : ${geo.label}\n` +
    `🏠 Arrivée : ${DIAGPERF_LOCATION.address}\n\n` +
    `🚗 Parking gratuit sur place. Nous sommes à 5 min à pied de la gare de Villenoy.`
  );
}

// ====== Vehicle image URL builder (Wikipedia Commons → imagin.studio fallback) ======
const MAKE_WIKI_MAP = {
  citroen:"Citroën", citroën:"Citroën",
  peugeot:"Peugeot", renault:"Renault",
  volkswagen:"Volkswagen", mercedes:"Mercedes-Benz", "mercedes-benz":"Mercedes-Benz",
  bmw:"BMW", audi:"Audi", ford:"Ford", opel:"Opel", fiat:"Fiat",
  toyota:"Toyota", honda:"Honda", nissan:"Nissan", hyundai:"Hyundai",
  kia:"Kia", seat:"SEAT", skoda:"Škoda", dacia:"Dacia",
  volvo:"Volvo", mini:"Mini", porsche:"Porsche", tesla:"Tesla",
  alfa:"Alfa Romeo", "alfa romeo":"Alfa Romeo", suzuki:"Suzuki",
  mazda:"Mazda", mitsubishi:"Mitsubishi", subaru:"Subaru",
  chevrolet:"Chevrolet", jeep:"Jeep", land:"Land Rover", "land rover":"Land Rover",
  jaguar:"Jaguar", lexus:"Lexus", infiniti:"Infiniti", cupra:"Cupra",
  ds:"DS", smart:"Smart",
};

async function getVehicleImageUrl(vehicle) {
  if (!vehicle?.make) return null;
  const makeRaw = String(vehicle.make).trim();
  const modelRaw = String(vehicle.model || "").trim().split(" ")[0];
  if (!modelRaw) return null;
  const year = vehicle.year ? String(vehicle.year) : "";

  const wikiMake = MAKE_WIKI_MAP[makeRaw.toLowerCase()] || makeRaw.charAt(0).toUpperCase() + makeRaw.slice(1).toLowerCase();

  try {
    // Step 1: Use Wikipedia search to find the best article for this vehicle generation
    const searchQuery = `${wikiMake} ${modelRaw}${year ? ` ${year}` : ""} car`;
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(searchQuery)}&srlimit=3&format=json`;
    const searchResp = await fetchFn(searchUrl);
    const searchJson = await searchResp.json();
    const searchResults = searchJson?.query?.search || [];

    // Pick the best article: prefer one containing the model name
    const modelLower = modelRaw.toLowerCase();
    const bestArticle = searchResults.find(r => r.title.toLowerCase().includes(modelLower)) || searchResults[0];
    if (!bestArticle) throw new Error("No Wikipedia article found");

    const articleTitle = bestArticle.title;
    log.debug("Wikipedia article found", { search: searchQuery, article: articleTitle });

    // Step 2: Get all images from the article
    const imgsUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(articleTitle)}&prop=images&imlimit=50&format=json`;
    const imgsResp = await fetchFn(imgsUrl);
    const imgsJson = await imgsResp.json();
    const pages = Object.values(imgsJson?.query?.pages || {});
    const allImages = (pages[0]?.images || [])
      .map(i => i.title)
      .filter(t => /\.(jpg|jpeg|png)$/i.test(t) && !/flag|icon|logo|commons|wiki|map/i.test(t));

    let bestFile = null;

    if (year && allImages.length) {
      // Step 3a: Find image with exact year + "Front" in filename
      bestFile = allImages.find(t => t.includes(year) && /front/i.test(t));

      // Step 3b: Find image with nearby year + front
      if (!bestFile) {
        const yearNum = parseInt(year);
        for (let delta = 0; delta <= 3; delta++) {
          for (const y of [String(yearNum + delta), String(yearNum - delta)]) {
            const m = allImages.find(t => t.includes(y) && /front/i.test(t));
            if (m) { bestFile = m; break; }
          }
          if (bestFile) break;
        }
      }

      // Step 3c: Find image with nearby year (no front requirement), exclude rear/interior
      if (!bestFile) {
        const yearNum = parseInt(year);
        for (let delta = 0; delta <= 3; delta++) {
          for (const y of [String(yearNum + delta), String(yearNum - delta)]) {
            const m = allImages.find(t => t.includes(y) && !/rear|interior|engine|badge|back|dashboard/i.test(t));
            if (m) { bestFile = m; break; }
          }
          if (bestFile) break;
        }
      }
    }

    // Step 4: Resolve file to thumbnail URL
    if (bestFile) {
      const fileUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(bestFile)}&prop=imageinfo&iiprop=url&iiurlwidth=800&format=json`;
      const fileResp = await fetchFn(fileUrl);
      const fileJson = await fileResp.json();
      const filePages = Object.values(fileJson?.query?.pages || {});
      const thumbUrl = filePages[0]?.imageinfo?.[0]?.thumburl;
      if (thumbUrl) {
        log.debug("Wikipedia year-matched image", { article: articleTitle, year, file: bestFile });
        return thumbUrl;
      }
    }

    // Step 5: Fallback to pageimage of the found article
    const piUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(articleTitle)}&prop=pageimages&piprop=thumbnail&pithumbsize=800&format=json`;
    const piResp = await fetchFn(piUrl);
    const piJson = await piResp.json();
    const piPages = Object.values(piJson?.query?.pages || {});
    const piThumb = piPages[0]?.thumbnail?.source;
    if (piThumb) {
      log.debug("Wikipedia pageimage fallback", { article: articleTitle });
      return piThumb;
    }
  } catch (wikiErr) {
    log.debug("Wikipedia image lookup failed", { error: String(wikiErr?.message || wikiErr) });
  }

  // Step 6: Final fallback → imagin.studio
  const make = encodeURIComponent(makeRaw.toLowerCase());
  const model = encodeURIComponent(modelRaw.toLowerCase());
  let url = `https://cdn.imagin.studio/getimage?customer=img&make=${make}&modelFamily=${model}`;
  if (year) url += `&modelYear=${year}`;
  url += `&angle=01&zoomType=fullscreen&fileType=png&width=800`;
  return url;
}

// ====== Synthetic dyno curve generator ======
function generateDynoCurve(peakValue, peakRpmRatio, rpmPoints) {
  return rpmPoints.map(rpm => {
    const x = rpm / rpmPoints[rpmPoints.length - 1];
    const k = peakRpmRatio;
    const curve = peakValue * Math.pow(x / k, 1.5) * Math.exp(1.5 * (1 - x / k));
    return Math.round(curve);
  });
}

// ====== Dyno chart builder (Chart.js 2.x — QuickChart.io compatible) ======
function buildDynoChartUrl(peakPowerOrig, peakPowerMod, peakTorqueOrig, peakTorqueMod, vehicleName, subtitle) {
  const rpmPoints = [1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
  const rpmLabels = rpmPoints.map(r => String(r));
  const pwrOrig = generateDynoCurve(peakPowerOrig, 0.78, rpmPoints);
  const pwrMod = generateDynoCurve(peakPowerMod, 0.78, rpmPoints);
  const trqOrig = generateDynoCurve(peakTorqueOrig, 0.5, rpmPoints);
  const trqMod = generateDynoCurve(peakTorqueMod, 0.5, rpmPoints);

  const chart = {
    type: "line",
    data: {
      labels: rpmLabels,
      datasets: [
        {
          label: `Puissance origine (${peakPowerOrig} ch)`,
          data: pwrOrig,
          borderColor: "rgba(120,120,120,0.8)",
          borderWidth: 2, borderDash: [6, 3],
          fill: false, lineTension: 0.4, pointRadius: 0,
          yAxisID: "y-power",
        },
        {
          label: `Puissance modifiée (${peakPowerMod} ch)`,
          data: pwrMod,
          borderColor: "rgb(220,38,38)",
          borderWidth: 3, fill: false,
          lineTension: 0.4, pointRadius: 0,
          yAxisID: "y-power",
        },
        {
          label: `Couple origine (${peakTorqueOrig} Nm)`,
          data: trqOrig,
          borderColor: "rgba(100,100,100,0.7)",
          borderWidth: 2, borderDash: [6, 3],
          fill: false, lineTension: 0.4, pointRadius: 0,
          yAxisID: "y-torque",
        },
        {
          label: `Couple modifié (${peakTorqueMod} Nm)`,
          data: trqMod,
          borderColor: "rgb(37,99,235)",
          borderWidth: 3, fill: false,
          lineTension: 0.4, pointRadius: 0,
          yAxisID: "y-torque",
        },
      ],
    },
    options: {
      title: {
        display: true,
        text: [vehicleName, subtitle],
        fontSize: 15,
        fontStyle: "bold",
      },
      legend: {
        position: "bottom",
        labels: { usePointStyle: true, padding: 12 },
      },
      scales: {
        xAxes: [{
          scaleLabel: { display: true, labelString: "Régime (tr/min)", fontStyle: "bold" },
        }],
        yAxes: [
          {
            id: "y-power", type: "linear", position: "left",
            scaleLabel: { display: true, labelString: "Puissance (ch)", fontColor: "rgb(220,38,38)", fontStyle: "bold" },
            ticks: { beginAtZero: true },
          },
          {
            id: "y-torque", type: "linear", position: "right",
            scaleLabel: { display: true, labelString: "Couple (Nm)", fontColor: "rgb(37,99,235)", fontStyle: "bold" },
            ticks: { beginAtZero: true },
            gridLines: { drawOnChartArea: false },
          },
        ],
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=700&h=420&bkg=white&f=png`;
}

// ====== Premium vehicle spec card (QuickChart.io canvas) ======
function buildVehicleCardUrl({ vehicle, stage, stageLabel, priceTtc }) {
  if (!vehicle?.make) return null;
  const vName = `${vehicle.make} ${vehicle.model || ""}`.trim();
  const yearTxt = vehicle.year ? `${vehicle.year}` : "";
  const fuelTxt = vehicle.fuel ? vehicle.fuel.toUpperCase() : "";
  const ccTxt = vehicle.engine_cc ? `${vehicle.engine_cc}cc` : "";
  const hpTxt = vehicle.power_hp ? `${vehicle.power_hp}ch` : "";
  const engineTxt = [fuelTxt, ccTxt, hpTxt].filter(Boolean).join(" • ");
  const plateTxt = vehicle.plate || "";

  const pwrOrig = stage?.puissance_origine || vehicle.power_hp || 0;
  const pwrAfter = stage?.puissance_apres || 0;
  const trqOrig = stage?.couple_origine || 0;
  const trqAfter = stage?.couple_apres || 0;
  const gainPwr = stage?.gain_puissance || 0;
  const gainTrq = stage?.gain_couple || 0;
  const isE85 = /e85/i.test(stage?.stage || "");

  const chart = {
    type: "bar",
    data: {
      labels: isE85 ? ["Économie carburant"] : ["Puissance (ch)", "Couple (Nm)"],
      datasets: isE85 ? [
        { label: "Jusqu'à -40% sur le carburant", data: [40], backgroundColor: "#22c55e", barThickness: 36 },
      ] : [
        { label: "Origine", data: [pwrOrig, trqOrig], backgroundColor: "rgba(120,120,120,0.6)", barThickness: 28 },
        { label: "Après reprog", data: [pwrAfter, trqAfter], backgroundColor: ["rgba(220,38,38,0.9)", "rgba(37,99,235,0.9)"], barThickness: 28 },
      ],
    },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 10, bottom: 10, left: 10, right: 10 } },
      plugins: {
        title: {
          display: true,
          text: [
            `🏁 ${vName}${yearTxt ? ` (${yearTxt})` : ""}`,
            engineTxt,
            plateTxt ? `Plaque : ${plateTxt}` : "",
            "",
            stageLabel ? `Prestation : ${stageLabel}` : "",
            ...(isE85 ? ["Conversion Bioéthanol E85"] : [
              gainPwr ? `⚡ +${gainPwr}ch  |  +${gainTrq}Nm` : "",
            ]),
            priceTtc ? `💰 ${priceTtc}` : "",
          ].filter(Boolean),
          font: { size: 14, weight: "bold" },
          color: "#1a1a2e",
          padding: { bottom: 16 },
        },
        subtitle: {
          display: true,
          text: "DIAGPERF — Reprogrammation & Diagnostic",
          font: { size: 11, weight: "bold" },
          color: "#3b82f6",
          padding: { bottom: 8 },
        },
        legend: { position: "bottom", labels: { usePointStyle: true, padding: 10, font: { size: 11 } } },
        datalabels: {
          display: true,
          anchor: "end",
          align: "right",
          font: { weight: "bold", size: 13 },
          color: "#1a1a2e",
          formatter: (v) => v + (isE85 ? "%" : ""),
        },
      },
      scales: {
        x: { display: true, grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { font: { size: 13, weight: "bold" }, color: "#1a1a2e" } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=%23f8f9fa&v=4&f=png`;
}

// ====== Gains chart URL builder (QuickChart.io — free, no API key) ======
function buildGainsChartUrl(stages, vehicleName) {
  if (!stages || stages.length === 0) return null;
  const s = stages[0];
  const bestStage = stages.reduce((best, cur) => ((cur.puissance_apres || 0) > (best.puissance_apres || 0) ? cur : best), stages[0]);
  const sub = stages.map(st => `${formatStageLabel(st.stage)}: ${st.puissance_apres}ch / ${st.couple_apres}Nm`).join("  |  ");
  return buildDynoChartUrl(
    s.puissance_origine || 0, bestStage.puissance_apres || 0,
    s.couple_origine || 0, bestStage.couple_apres || 0,
    vehicleName, sub
  );
}

// ====== Single-stage gains chart (dyno style for individual selection) ======
function buildSingleStageChartUrl(stage, vehicleName) {
  if (!stage) return null;
  const stageLabel = formatStageLabel(stage.stage);
  const sub = `${stageLabel} — +${stage.gain_puissance || "?"}ch / +${stage.gain_couple || "?"}Nm`;
  return buildDynoChartUrl(
    stage.puissance_origine || 0, stage.puissance_apres || 0,
    stage.couple_origine || 0, stage.couple_apres || 0,
    vehicleName, sub
  );
}

// ====== Premium prestation card (E85, FAP, ADBLUE, DIAG) ======
// Displays vehicle info + prestation-specific visual gauge (savings, pollution reduction, etc.)
function buildPrestationCardUrl({ vehicle, intent, prestationLabel, priceTtc, extra = {} }) {
  if (!vehicle?.make) return null;
  const vName = `${vehicle.make} ${vehicle.model || ""}`.trim();
  const yearTxt = vehicle.year ? `${vehicle.year}` : "";
  const fuelTxt = vehicle.fuel ? vehicle.fuel.toUpperCase() : "";
  const ccTxt = vehicle.engine_cc ? `${vehicle.engine_cc}cc` : "";
  const hpTxt = vehicle.power_hp ? `${vehicle.power_hp}ch` : "";
  const engineTxt = [fuelTxt, ccTxt, hpTxt].filter(Boolean).join(" • ");
  const plateTxt = vehicle.plate || "";

  // Configure chart data and titles per intent
  let labels = [];
  let datasets = [];
  let subtitleLines = [];
  let unit = "";

  if (intent === "E85") {
    labels = ["Économie carburant", "Réduction CO₂"];
    datasets = [
      { label: "Jusqu'à (%)", data: [40, 70], backgroundColor: ["#22c55e", "#16a34a"], barThickness: 32 },
    ];
    subtitleLines = ["🌿 Conversion Bioéthanol E85", "Compatible essence uniquement"];
    unit = "%";
  } else if (intent === "FAP") {
    labels = ["Risque colmatage", "Pertes de puissance", "Consommation"];
    datasets = [
      { label: "Réduction (%)", data: [100, 15, 5], backgroundColor: ["#3b82f6", "#2563eb", "#1d4ed8"], barThickness: 32 },
    ];
    subtitleLines = ["🔧 Suppression FAP", "Fin des problèmes de colmatage"];
    unit = "%";
  } else if (intent === "ADBLUE") {
    labels = ["Pannes SCR", "Entretien AdBlue", "Voyants moteur"];
    datasets = [
      { label: "Réduction (%)", data: [100, 100, 100], backgroundColor: ["#8b5cf6", "#7c3aed", "#6d28d9"], barThickness: 32 },
    ];
    subtitleLines = ["💧 Suppression AdBlue", "Fin des coûts d'entretien SCR"];
    unit = "%";
  } else if (intent === "DIAG") {
    labels = ["Défauts lus", "Codes effacés", "Précision diag"];
    datasets = [
      { label: "Couverture (%)", data: [100, 100, 100], backgroundColor: ["#f59e0b", "#d97706", "#b45309"], barThickness: 32 },
    ];
    subtitleLines = ["🔍 Diagnostic électronique complet"];
    unit = "%";
  } else if (intent === "EGR") {
    labels = ["Encrassement moteur", "Consommation", "Fiabilité"];
    datasets = [
      { label: "Amélioration (%)", data: [100, 8, 80], backgroundColor: ["#10b981", "#059669", "#047857"], barThickness: 32 },
    ];
    subtitleLines = ["🔩 Suppression EGR (Diesel uniquement)", "Fin de l'encrassement moteur"];
    unit = "%";
  } else {
    return null;
  }

  const chart = {
    type: "bar",
    data: { labels, datasets },
    options: {
      indexAxis: "y",
      layout: { padding: { top: 10, bottom: 10, left: 10, right: 10 } },
      plugins: {
        title: {
          display: true,
          text: [
            `🏁 ${vName}${yearTxt ? ` (${yearTxt})` : ""}`,
            engineTxt,
            plateTxt ? `Plaque : ${plateTxt}` : "",
            "",
            prestationLabel ? `Prestation : ${prestationLabel}` : "",
            ...subtitleLines,
            priceTtc ? `💰 ${priceTtc}` : "",
          ].filter(Boolean),
          font: { size: 14, weight: "bold" },
          color: "#1a1a2e",
          padding: { bottom: 16 },
        },
        subtitle: {
          display: true,
          text: "DIAGPERF — Reprogrammation & Diagnostic",
          font: { size: 11, weight: "bold" },
          color: "#3b82f6",
          padding: { bottom: 8 },
        },
        legend: { display: false },
        datalabels: {
          display: true,
          anchor: "end",
          align: "right",
          font: { weight: "bold", size: 13 },
          color: "#1a1a2e",
          formatter: (v) => v + unit,
        },
      },
      scales: {
        x: { display: true, grid: { display: false }, ticks: { font: { size: 11 } }, max: 100 },
        y: { grid: { display: false }, ticks: { font: { size: 12, weight: "bold" }, color: "#1a1a2e" } },
      },
    },
  };

  const encoded = encodeURIComponent(JSON.stringify(chart));
  return `https://quickchart.io/chart?c=${encoded}&w=600&h=400&bkg=%23f8f9fa&v=4&f=png`;
}

const DIAGPERF_LOGO_URL = `${process.env.SUPABASE_URL}/storage/v1/object/public/assets/logo.png`;

async function sendMenuList(to, { showLogo = false } = {}) {
  // Envoyer le logo DiagPerf avant le menu (premier contact uniquement)
  if (showLogo) {
    try {
      await sendWhatsAppImage(to, DIAGPERF_LOGO_URL, "");
    } catch (imgErr) {
      log.debug("Logo send failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
    }
  }

  return sendWhatsAppList(
    to,
    `Bonjour 👋 Bienvenue chez DiagPerf 🚗💨\n\nPour obtenir un devis personnalisé, veuillez choisir la prestation souhaitée :`,
    "Nos prestations",
    [
      {
        title: "Nos prestations",
        rows: [
          { id: "menu_1", title: "Reprog moteur", description: "Optimisation de la puissance et du couple" },
          { id: "menu_2", title: "Conversion E85", description: "Passage au biothanol (essence uniquement)" },
          { id: "menu_3", title: "Suppression FAP", description: "Filtre à particules" },
          { id: "menu_4", title: "Suppression EGR", description: "Vanne EGR" },
          { id: "menu_5", title: "Suppression ADBlue", description: "Système AdBlue" },
          { id: "menu_6", title: "Diagnostic complet", description: "Diagnostic électronique complet" },
          { id: "menu_7", title: "Autres prestations", description: "Autres demandes" },
          { id: "menu_8", title: "SAV / Réclamation", description: "Support et réclamations" },
        ],
      },
    ]
  );
}

// ====== Garage internal notification (best effort) ======
async function notifyGarage(message) {
  const garageWaId = process.env.GARAGE_WA_ID;
  if (!garageWaId) {
    log.debug("notifyGarage: GARAGE_WA_ID non configuré, skip");
    return;
  }
  try {
    log.info("notifyGarage: envoi en cours", { to: garageWaId, preview: message.slice(0, 80) });
    await sendWhatsAppText(garageWaId, message);
    log.info("notifyGarage: envoi OK", { to: garageWaId });
  } catch (err) {
    log.error("notifyGarage: échec envoi", { to: garageWaId, error: String(err?.message || err) });
  }
}

// ====== Frustration / human escalation ======
// Cooldown en mémoire (par wa_id) pour éviter de spammer le garage quand
// un client frustré envoie plusieurs messages d'affilée.
const ESCALATION_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
const _lastEscalationAt = new Map();

/**
 * Détecte si le message client exprime de la frustration / urgence / demande
 * explicite d'un humain. Si oui :
 *   - notifie le garage (best-effort)
 *   - envoie un message d'apaisement + bouton pour être rappelé
 *   - retourne true (message intercepté)
 * Sinon retourne false.
 *
 * Cooldown : n'escalade pas plus d'1 fois par 15 min pour un même wa_id.
 */
async function handleFrustrationEscalation(fromWa, text, rawMsg) {
  // Ignorer les messages non-texte et les interactions bouton (pas pertinent)
  if (!text || rawMsg?.interactive) return false;

  const signal = detectSentiment(text, {});
  if (!signal.shouldEscalate) return false;

  // Cooldown
  const last = _lastEscalationAt.get(fromWa) || 0;
  const now = Date.now();
  if (now - last < ESCALATION_COOLDOWN_MS) {
    log.debug("Escalation cooldown active, skip", { wa_id: fromWa, score: signal.score });
    return false;
  }

  _lastEscalationAt.set(fromWa, now);

  log.warn("Frustration détectée → escalade humaine", {
    wa_id: fromWa,
    score: signal.score,
    level: signal.level,
    critical: signal.critical,
    reasons: signal.reasons,
    preview: text.slice(0, 120),
  });

  // Message au client : empathie + 2 boutons
  const calmingMsg = signal.critical
    ? `🚨 J'ai bien noté une situation urgente. Notre équipe va être prévenue immédiatement.\n\nSouhaites-tu être rappelé ?`
    : signal.level === "angry"
      ? `Je comprends ta frustration et j'en suis désolé 🙏\nJe préfère passer la main à un conseiller humain de l'équipe DiagPerf pour t'aider correctement.\n\nSouhaites-tu être rappelé ?`
      : `Je te sens un peu frustré, et c'est normal 🙏\nJe peux te mettre en relation avec un conseiller humain de DiagPerf.\n\nSouhaites-tu être rappelé ?`;

  try {
    await sendWhatsAppInteractiveButtons(fromWa, calmingMsg, [
      { id: "escalate_callback", title: "☎️ Être rappelé" },
      { id: "escalate_continue", title: "💬 Continuer ici" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ]);
  } catch (err) {
    log.error("Escalation: erreur envoi message apaisement", { wa_id: fromWa, error: String(err?.message || err) });
  }

  // Notifier le garage (best effort, non bloquant)
  const header = signal.critical ? "🚨 URGENCE CLIENT" : "⚠️ CLIENT FRUSTRÉ";
  notifyGarage(
    `${header}\n` +
    `WhatsApp : ${fromWa}\n` +
    `Niveau : ${signal.level} (score ${signal.score})\n` +
    `Raisons : ${signal.reasons.join(" | ")}\n` +
    `Message : "${text.slice(0, 200)}"\n` +
    `Date : ${new Date().toISOString()}`
  ).catch(() => {});

  return true;
}

/**
 * Gère les boutons d'escalade (`escalate_callback`, `escalate_continue`).
 * Retourne true si géré, false sinon.
 */
async function handleEscalationButtons(fromWa, text, rawMsg) {
  const buttonId = extractInteractiveId(rawMsg);
  if (!buttonId) return false;

  if (buttonId === "escalate_callback") {
    log.info("Client demande un rappel via escalade", { wa_id: fromWa });
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `✅ C'est noté ! Un conseiller DiagPerf va te rappeler dans les meilleurs délais.\n\nEntre-temps, tu peux aussi nous joindre au *06 75 54 70 85* (horaires : Mar-Ven 10h-18h, Sam 10h-16h).`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );
    notifyGarage(
      `☎️ DEMANDE DE RAPPEL CLIENT\n` +
      `WhatsApp : ${fromWa}\n` +
      `Merci de rappeler ce client dès que possible.\n` +
      `Date : ${new Date().toISOString()}`
    ).catch(() => {});
    return true;
  }

  if (buttonId === "escalate_continue") {
    log.info("Client choisit de continuer avec le bot", { wa_id: fromWa });
    // Reset du cooldown pour permettre une nouvelle escalade si besoin
    _lastEscalationAt.delete(fromWa);
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Parfait, on continue ensemble 👌\nDis-moi ce que tu souhaites faire :`,
      [
        { id: "menu_1", title: "🔧 Reprog / Stage 1" },
        { id: "menu_6", title: "🔍 Diagnostic" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]
    );
    return true;
  }

  return false;
}

// ====== Avis client (review requests) ======
// Lien Google Reviews de DiagPerf (à personnaliser avec le vrai lien)
const GOOGLE_REVIEWS_URL = process.env.GOOGLE_REVIEWS_URL || "https://g.page/r/diagperf/review";

/**
 * Crée une demande d'avis client, envoyée automatiquement 48h après l'intervention.
 * Appelée quand le garage marque une intervention comme terminée (commande DONE).
 */
async function createReviewRequest({ waId, devisId, prestation, vehicleDesc, customerName, customerEmail }) {
  try {
    const { data, error } = await supabase
      .from("review_requests")
      .upsert({
        wa_id: waId,
        devis_id: devisId || null,
        prestation: prestation || null,
        vehicle_desc: vehicleDesc || null,
        customer_name: customerName || null,
        customer_email: customerEmail || null,
      }, { onConflict: "wa_id,devis_id" })
      .select("id")
      .single();

    if (error) throw error;
    log.info("Review request created", { wa_id: waId, devisId, id: data?.id });
    return data;
  } catch (err) {
    log.error("createReviewRequest failed", { wa_id: waId, error: String(err?.message || err) });
    return null;
  }
}

/**
 * Scheduler : vérifie les demandes d'avis à envoyer (send_at <= NOW() et sent = false).
 * Appelé périodiquement par setInterval.
 */
async function processReviewRequests() {
  try {
    const { data: pending, error } = await supabase
      .from("review_requests")
      .select("*")
      .eq("sent", false)
      .lte("send_at", new Date().toISOString())
      .limit(10);

    if (error) {
      log.error("processReviewRequests: query failed", { error: error.message });
      return;
    }
    if (!pending || pending.length === 0) return;

    for (const req of pending) {
      try {
        const name = req.customer_name ? ` ${req.customer_name.split(" ")[0]}` : "";
        const prestaTxt = req.prestation ? `\n🛠️ Prestation : ${req.prestation}` : "";

        await sendWhatsAppInteractiveButtons(
          req.wa_id,
          `Bonjour${name} ! 👋\n\n` +
          `Nous espérons que tout s'est bien passé lors de votre passage chez DiagPerf 🚗${prestaTxt}\n\n` +
          `Votre avis compte beaucoup pour nous ! Comment évaluez-vous votre expérience ?`,
          [
            { id: "review_5", title: "⭐⭐⭐⭐⭐ Excellent" },
            { id: "review_4", title: "⭐⭐⭐⭐ Très bien" },
            { id: "review_low", title: "😕 À améliorer" },
          ]
        );

        // Mettre l'état de conversation pour capter la réponse
        await setConversationState(req.wa_id, "AWAITING_REVIEW_RATING", null, {
          reviewRequestId: req.id,
          customerName: req.customer_name,
          customerEmail: req.customer_email,
        });

        // Marquer comme envoyé
        await supabase
          .from("review_requests")
          .update({ sent: true })
          .eq("id", req.id);

        log.info("Review request sent", { wa_id: req.wa_id, id: req.id });
      } catch (sendErr) {
        log.error("processReviewRequests: send failed", { wa_id: req.wa_id, id: req.id, error: String(sendErr?.message || sendErr) });
      }
    }
  } catch (err) {
    log.error("processReviewRequests: unexpected error", { error: String(err?.message || err) });
  }
}

// Intervalle du scheduler avis (toutes les 5 minutes)
const REVIEW_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Traite la réponse du client à la demande d'avis.
 * Retourne true si le message a été géré, false sinon.
 */
async function handleReviewRating(fromWa, text, rawMsg) {
  const convState = await getConversationState(fromWa);
  if (!convState || convState.state !== "AWAITING_REVIEW_RATING") return false;

  const buttonId = extractInteractiveId(rawMsg);
  const t = String(text || "").trim().toLowerCase();
  const stateData = convState.data || {};
  const reviewRequestId = stateData.reviewRequestId;

  // Bouton "Menu" → quitter le flow avis
  if (buttonId === "btn_back_menu") {
    await clearConversationState(fromWa);
    await sendMenuList(fromWa);
    return true;
  }

  // Déterminer la note
  let rating = null;
  if (buttonId === "review_5" || t === "5" || t.includes("excellent")) rating = 5;
  else if (buttonId === "review_4" || t === "4" || t.includes("très bien") || t.includes("tres bien")) rating = 4;
  else if (buttonId === "review_low" || t === "1" || t === "2" || t === "3" || t.includes("améliorer") || t.includes("ameliorer") || t.includes("pas bien") || t.includes("mauvais") || t.includes("nul")) rating = parseInt(t, 10) || 2;

  if (rating === null) {
    // Pas compris → re-demander
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci de choisir une des options ci-dessous 😊`,
      [
        { id: "review_5", title: "⭐⭐⭐⭐⭐ Excellent" },
        { id: "review_4", title: "⭐⭐⭐⭐ Très bien" },
        { id: "review_low", title: "😕 À améliorer" },
      ]
    );
    return true;
  }

  // Enregistrer la note en base
  if (reviewRequestId) {
    await supabase
      .from("review_requests")
      .update({ rating, responded_at: new Date().toISOString() })
      .eq("id", reviewRequestId);
  }

  if (rating >= 4) {
    // Avis positif → lien Google Reviews
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci beaucoup ! 🙏 Nous sommes ravis que vous soyez satisfait !\n\n` +
      `Si vous avez 30 secondes, un avis Google nous aiderait énormément :\n` +
      `👉 ${GOOGLE_REVIEWS_URL}\n\n` +
      `Merci et à bientôt chez DiagPerf ! 🚗`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );
    log.info("Review: positive rating", { wa_id: fromWa, rating });
  } else {
    // Avis négatif → callback technicien + notif garage
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci pour votre retour honnête 🙏\n\n` +
      `Nous sommes désolés que votre expérience n'ait pas été à la hauteur.\n` +
      `Un technicien va vous recontacter rapidement pour résoudre le problème.\n\n` +
      `Votre satisfaction est notre priorité ! 💪`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );

    // Notifier le garage
    const name = stateData.customerName || fromWa;
    await notifyGarage(
      `⚠️ AVIS NÉGATIF (${rating}⭐)\n` +
      `Client : ${name} (${fromWa})\n` +
      `Email : ${stateData.customerEmail || "N/A"}\n\n` +
      `🔴 Action requise : recontacter le client dans les plus brefs délais.`
    );
    log.info("Review: negative rating → garage notified", { wa_id: fromWa, rating });
  }

  await clearConversationState(fromWa);
  return true;
}

/**
 * Détecte la commande "DONE [plaque]" envoyée par le garage pour marquer une intervention terminée.
 * Crée automatiquement une review request pour le client associé au devis.
 * Retourne true si le message a été géré.
 */
async function handleGarageDoneCommand(fromWa, text) {
  const garageWaId = process.env.GARAGE_WA_ID;
  if (!garageWaId || fromWa !== garageWaId) return false;

  const match = String(text || "").trim().match(/^DONE\s+(.+)/i);
  if (!match) return false;

  const plateOrRef = match[1].trim().toUpperCase();
  log.info("Garage DONE command received", { plate: plateOrRef });

  // Chercher le dernier devis avec cette plaque
  try {
    const normalizedPlate = normalizePlate(plateOrRef);
    const { data: devis, error } = await supabase
      .from("devis")
      .select("id, wa_id, prestation_code, plaque")
      .or(`plaque.eq.${normalizedPlate},plaque.eq.${plateOrRef}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!devis) {
      await sendWhatsAppText(fromWa, `❌ Aucun devis trouvé pour "${plateOrRef}".`);
      return true;
    }

    const prestationLabel = intentToLabel(
      Object.keys(INTENT_MAP).find(k => INTENT_MAP[k].code === devis.prestation_code) || ""
    ) || devis.prestation_code;

    const result = await createReviewRequest({
      waId: devis.wa_id,
      devisId: String(devis.id),
      prestation: prestationLabel,
      vehicleDesc: devis.plaque || null,
      customerName: null,
      customerEmail: null,
    });

    if (result) {
      await sendWhatsAppText(fromWa,
        `✅ Intervention marquée comme terminée pour ${plateOrRef}.\n` +
        `📩 Demande d'avis programmée dans 48h pour le client ${devis.wa_id}.`
      );
    } else {
      await sendWhatsAppText(fromWa, `⚠️ Intervention marquée mais erreur lors de la création de la demande d'avis.`);
    }
  } catch (err) {
    log.error("handleGarageDoneCommand failed", { plate: plateOrRef, error: String(err?.message || err) });
    await sendWhatsAppText(fromWa, `❌ Erreur : ${err?.message || "inconnue"}`);
  }

  return true;
}


// ====== Conversation State (table conversation_state) ======
const CONV_STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getConversationState(waId) {
  const { data, error } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("wa_id", waId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  // TTL : si updated_at > 30 min, auto-clear
  if (data.updated_at) {
    const age = Date.now() - new Date(data.updated_at).getTime();
    if (age > CONV_STATE_TTL_MS) {
      log.info("Conversation state expired (TTL)", { wa_id: waId, state: data.state, ageMin: Math.round(age / 60000) });
      await clearConversationState(waId);
      return null;
    }
  }

  return data;
}

async function setConversationState(waId, state, intent, data) {
  const { error } = await supabase
    .from("conversation_state")
    .upsert(
      {
        wa_id: waId,
        state,
        intent,
        data: data || {},
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wa_id" }
    );

  if (error) throw error;
}

async function clearConversationState(waId) {
  const { error } = await supabase
    .from("conversation_state")
    .delete()
    .eq("wa_id", waId);

  if (error) throw error;
}

async function getRecentMessages(waId, limit = 6) {
  try {
    // Récupérer la conversation
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("wa_phone", waId)
      .maybeSingle();

    if (!conv?.id) return [];

    const { data: msgs, error } = await supabase
      .from("messages")
      .select("direction, body, ts")
      .eq("conversation_id", conv.id)
      .order("ts", { ascending: false })
      .limit(limit);

    if (error || !msgs) return [];

    // Inverser pour ordre chronologique, filtrer messages vides
    return msgs
      .reverse()
      .filter(m => m.body && m.body.trim())
      .map(m => ({
        role: m.direction === "in" ? "user" : "assistant",
        content: m.body.trim().slice(0, 500),
      }));
  } catch (err) {
    log.warn("getRecentMessages failed", { wa_id: waId, error: String(err?.message || err) });
    return [];
  }
}

// ====== Init LLM service (needs getRecentMessages + getConversationState) ======
initLlmService({ supabase, log, fetchFn, getRecentMessages, getConversationState });



// ====== Voice transcription (Groq Whisper — free tier) ======
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

// Fonctions vocales déplacées dans lib/voice-handler.js
// Conservées pour compatibilité avec code existant
async function downloadWhatsAppMedia(mediaId) {
  const { downloadWhatsAppMedia: download } = require("./lib/voice-handler");
  return download(mediaId, process.env.WHATSAPP_TOKEN, WA_API_VERSION, fetchFn);
}

async function transcribeAudio(audioBuffer, mimeType) {
  const { transcribeWithGroq } = require("./lib/voice-handler");
  const result = await transcribeWithGroq(audioBuffer, mimeType, "fr", fetchFn);
  return result ? result.text : null;
}

// ====== Non-text message types (media, calls, etc.) ======
// VOICE_TYPES importé depuis lib/voice-handler
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
// Retourne true si pris en charge (réponse envoyée + re-proposition), false sinon.
async function tryOffTopicAnswer({ fromWa, text, retryMessage, retryButtons }) {
  const t = String(text || "").trim();
  // Ne pas appeler le LLM pour les réponses courtes de type bouton (oui/non/chiffre/menu)
  if (t.length < 4) return false;
  if (/^(oui|non|yes|no|ok|okay|d['']accord|confirmer|annuler|suivant|passer|skip|ajouter|menu|\d{1,2})\.?$/i.test(t)) return false;
  try {
    const llmResult = await askLLM(text, fromWa);
    if (!llmResult || llmResult.type !== "answer" || !llmResult.message) return false;
    await sendWhatsAppText(fromWa, llmResult.message);
    if (retryMessage && retryButtons) {
      await sendWhatsAppInteractiveButtons(fromWa, retryMessage, retryButtons);
    }
    log.info("Off-topic question answered via LLM + retry buttons", { wa_id: fromWa });
    return true;
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
//   return respondOrAnswerQuestion(fromWa, text, "Est-ce bien votre véhicule ?", [...buttons]);
//
// Cela garantit que toute question off-topic est répondue via LLM avant de
// re-proposer les boutons, sans avoir à dupliquer la logique dans chaque état.
async function respondOrAnswerQuestion(fromWa, text, retryMessage, retryButtons) {
  const handled = await tryOffTopicAnswer({ fromWa, text, retryMessage, retryButtons });
  if (handled) return true;
  await sendWhatsAppInteractiveButtons(fromWa, retryMessage, retryButtons);
  return true;
}

// ====== Prestation flow (extracted to flows/prestation.js) ======
const { handlePrestationFlow, PRESTATION_INTENTS } = createPrestationFlow({
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
});

// ====== SAV flow (extracted to flows/sav.js) ======
const { handleSavFlow } = createSavFlow({
  supabase, log,
  sendWhatsAppInteractiveButtons, sendWhatsAppImage,
  setConversationState, clearConversationState, getConversationState,
  notifyGarage, getVehicleImageUrl,
  sendSavClientEmail, sendSavDiagperfEmail,
});

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

// ====== Graceful shutdown ======
function gracefulShutdown(signal) {
  log.info(`${signal} reçu, arrêt gracieux...`);
  clearInterval(reviewInterval);
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
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
