const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");
const sgMail = require("@sendgrid/mail");
const { retrieveContext, formatContextForPrompt, preloadEmbedder } = require("./rag");

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

// ====== Client PWA API (public, auth by wa_id hash) ======
app.get("/api/client/devis", async (req, res) => {
  try {
    const wa = req.query.wa;
    const pin = req.query.pin;
    if (!wa || !pin) return res.status(400).json({ error: "wa et pin requis" });
    // PIN = 4 derniers chiffres du numéro WhatsApp
    const expectedPin = wa.replace(/\D/g, "").slice(-4);
    if (pin !== expectedPin) return res.status(401).json({ error: "PIN incorrect" });

    const { data: devis, error } = await supabase
      .from("devis")
      .select("id, plaque, prestation_code, total_ttc_centimes, total_ht_centimes, statut, created_at")
      .eq("wa_id", wa)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;

    res.json({ devis: devis || [] });
  } catch (err) {
    log.error("Client API error", { error: String(err?.message || err) });
    res.status(500).json({ error: "Erreur" });
  }
});

// ====== SSE real-time notifications for dashboard ======
const sseClients = new Set();

app.get("/api/dashboard/events", (req, res) => {
  const token = req.query.token;
  if (token !== (process.env.DASHBOARD_TOKEN || "diagperf_admin_2026")) return res.status(401).end();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // keepalive comment
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcastDashboardEvent(type, data) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// ====== Dashboard admin API ======
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "diagperf_admin_2026";

function requireDashboardAuth(req, res, next) {
  const token = req.query.token || req.headers["x-dashboard-token"];
  if (token !== DASHBOARD_TOKEN) return res.status(401).json({ error: "Non autorisé" });
  next();
}

app.get("/api/dashboard/stats", requireDashboardAuth, async (_req, res) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Devis totaux + aujourd'hui + semaine + mois
    const [allDevis, todayDevis, weekDevis, monthDevis] = await Promise.all([
      supabase.from("devis").select("id", { count: "exact", head: true }),
      supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", todayStart),
      supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", weekStart),
      supabase.from("devis").select("id", { count: "exact", head: true }).gte("created_at", monthStart),
    ]);

    // Chiffre d'affaires (somme TTC)
    const { data: revenueData } = await supabase
      .from("devis")
      .select("total_ttc_centimes, created_at");

    let revenueTotalCents = 0, revenueMonthCents = 0, revenueWeekCents = 0, revenueTodayCents = 0;
    const dailyRevenue = {};
    const dailyDevisCount = {};
    const prestationCounts = {};

    // Devis avec prestation_code pour le breakdown
    const { data: allDevisData } = await supabase
      .from("devis")
      .select("total_ttc_centimes, created_at, prestation_code, statut");

    for (const d of (allDevisData || [])) {
      const ttc = d.total_ttc_centimes || 0;
      revenueTotalCents += ttc;

      const createdAt = d.created_at;
      if (createdAt >= monthStart) revenueMonthCents += ttc;
      if (createdAt >= weekStart) revenueWeekCents += ttc;
      if (createdAt >= todayStart) revenueTodayCents += ttc;

      // Daily aggregation (last 30 days)
      const day = createdAt?.substring(0, 10);
      if (day) {
        dailyRevenue[day] = (dailyRevenue[day] || 0) + ttc;
        dailyDevisCount[day] = (dailyDevisCount[day] || 0) + 1;
      }

      // Prestation breakdown
      const code = d.prestation_code || "autre";
      prestationCounts[code] = (prestationCounts[code] || 0) + 1;
    }

    // Conversations totales
    const { count: totalConversations } = await supabase
      .from("conversations").select("id", { count: "exact", head: true });

    // Messages aujourd'hui
    const { count: todayMessages } = await supabase
      .from("messages").select("id", { count: "exact", head: true }).gte("ts", todayStart);

    // Avis clients
    const { data: reviews } = await supabase
      .from("review_requests").select("rating, sent, responded_at");

    const reviewStats = { total: 0, sent: 0, responded: 0, avgRating: 0, ratings: {} };
    let ratingSum = 0, ratingCount = 0;
    for (const r of (reviews || [])) {
      reviewStats.total++;
      if (r.sent) reviewStats.sent++;
      if (r.responded_at) {
        reviewStats.responded++;
        if (r.rating) {
          ratingSum += r.rating;
          ratingCount++;
          reviewStats.ratings[r.rating] = (reviewStats.ratings[r.rating] || 0) + 1;
        }
      }
    }
    reviewStats.avgRating = ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0;

    // Derniers devis (50 pour Kanban complet)
    const { data: recentDevis } = await supabase
      .from("devis")
      .select("id, plaque, prestation_code, total_ttc_centimes, total_ht_centimes, statut, wa_id, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    // Monthly revenue breakdown (last 12 months)
    const monthlyRevenue = {};
    const monthlyDepenses = {};
    for (const d of (allDevisData || [])) {
      const m = d.created_at?.substring(0, 7); // YYYY-MM
      if (m) monthlyRevenue[m] = (monthlyRevenue[m] || 0) + (d.total_ttc_centimes || 0);
    }

    // Depenses
    let depensesData = [];
    let totalDepensesCents = 0;
    let monthDepensesCents = 0;
    try {
      const { data: deps } = await supabase
        .from("depenses")
        .select("*")
        .order("date_depense", { ascending: false });
      depensesData = deps || [];
      for (const dep of depensesData) {
        totalDepensesCents += dep.montant_centimes || 0;
        const depMonth = dep.date_depense?.substring(0, 7);
        if (depMonth) monthlyDepenses[depMonth] = (monthlyDepenses[depMonth] || 0) + (dep.montant_centimes || 0);
        if (dep.date_depense >= monthStart.substring(0, 10)) monthDepensesCents += dep.montant_centimes || 0;
      }
    } catch (depErr) {
      log.debug("Depenses table not yet created", { error: String(depErr?.message || depErr) });
    }

    res.json({
      devis: {
        total: allDevis.count || 0,
        today: todayDevis.count || 0,
        week: weekDevis.count || 0,
        month: monthDevis.count || 0,
      },
      revenue: {
        total: revenueTotalCents,
        month: revenueMonthCents,
        week: revenueWeekCents,
        today: revenueTodayCents,
      },
      depenses: {
        total: totalDepensesCents,
        month: monthDepensesCents,
      },
      benefice: {
        total: revenueTotalCents - totalDepensesCents,
        month: revenueMonthCents - monthDepensesCents,
      },
      conversations: totalConversations || 0,
      todayMessages: todayMessages || 0,
      reviews: reviewStats,
      prestationBreakdown: prestationCounts,
      monthlyRevenue,
      monthlyDepenses,
      dailyRevenue,
      dailyDevisCount,
      recentDevis: recentDevis || [],
      recentDepenses: depensesData.slice(0, 20),
    });
  } catch (err) {
    log.error("Dashboard stats API error", { error: String(err?.message || err) });
    res.status(500).json({ error: "Erreur interne" });
  }
});

// ── CRUD Devis ──
app.post("/api/dashboard/devis", requireDashboardAuth, express.json(), async (req, res) => {
  try {
    const { plaque, prestation_code, total_ttc_centimes, statut } = req.body;
    if (!plaque || !total_ttc_centimes) return res.status(400).json({ error: "plaque et total_ttc_centimes requis" });
    const tauxTva = 0.20;
    const ttc = Math.round(Number(total_ttc_centimes));
    const ht = Math.round(ttc / (1 + tauxTva));
    const tva = ttc - ht;
    const { data, error } = await supabase.from("devis").insert({
      plaque: String(plaque).toUpperCase().replace(/\s+/g, "-"),
      prestation_code: prestation_code || "autre",
      total_ht_centimes: ht,
      taux_tva: tauxTva,
      total_tva_centimes: tva,
      total_ttc_centimes: ttc,
      statut: statut || "draft",
      source: "dashboard",
    }).select("id").single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    log.error("Dashboard create devis error", { error: String(err?.message || err) });
    res.status(500).json({ error: String(err?.message || "Erreur") });
  }
});

app.delete("/api/dashboard/devis/:id", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalide" });
    // Delete devis_lignes first
    await supabase.from("devis_lignes").delete().eq("devis_id", id);
    const { error } = await supabase.from("devis").delete().eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    log.error("Dashboard delete devis error", { error: String(err?.message || err) });
    res.status(500).json({ error: String(err?.message || "Erreur") });
  }
});

app.patch("/api/dashboard/devis/:id", requireDashboardAuth, express.json(), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalide" });
    const updates = {};
    if (req.body.statut) updates.statut = req.body.statut;
    if (req.body.total_ttc_centimes) {
      const ttc = Math.round(Number(req.body.total_ttc_centimes));
      updates.total_ttc_centimes = ttc;
      updates.total_ht_centimes = Math.round(ttc / 1.20);
      updates.total_tva_centimes = ttc - updates.total_ht_centimes;
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Rien à modifier" });
    const { error } = await supabase.from("devis").update(updates).eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    log.error("Dashboard patch devis error", { error: String(err?.message || err) });
    res.status(500).json({ error: String(err?.message || "Erreur") });
  }
});

// ── CRUD Dépenses ──
app.post("/api/dashboard/depenses", requireDashboardAuth, express.json(), async (req, res) => {
  try {
    const { libelle, montant_centimes, categorie, date_depense, notes } = req.body;
    if (!libelle || !montant_centimes) return res.status(400).json({ error: "libelle et montant requis" });
    const { data, error } = await supabase.from("depenses").insert({
      libelle,
      montant_centimes: Math.round(Number(montant_centimes)),
      categorie: categorie || "autre",
      date_depense: date_depense || new Date().toISOString().substring(0, 10),
      notes: notes || null,
    }).select("id").single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (err) {
    log.error("Dashboard create depense error", { error: String(err?.message || err) });
    res.status(500).json({ error: String(err?.message || "Erreur") });
  }
});

app.delete("/api/dashboard/depenses/:id", requireDashboardAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "ID invalide" });
    const { error } = await supabase.from("depenses").delete().eq("id", id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    log.error("Dashboard delete depense error", { error: String(err?.message || err) });
    res.status(500).json({ error: String(err?.message || "Erreur") });
  }
});

// ====== Test email route ======
app.get("/test-email", async (req, res) => {
  const to = req.query.to;
  if (!to) {
    return res.status(400).json({ error: "Paramètre ?to=email@example.com requis" });
  }
  if (!process.env.SENDGRID_API_KEY) {
    return res.status(503).json({ error: "SENDGRID_API_KEY non configuré" });
  }

  const msg = {
    to,
    from: process.env.SENDGRID_FROM || "noreply@diagperf.com",
    subject: "DiagPerf - Email test",
    text: "Ceci est un email de test envoyé depuis le serveur DiagPerf.",
    html: "<h2>DiagPerf</h2><p>Ceci est un email de test envoyé depuis le serveur DiagPerf.</p>",
  };

  try {
    const [response] = await sgMail.send(msg);
    log.info("test-email: envoi OK", { to, statusCode: response.statusCode });
    return res.json({ success: true, to, statusCode: response.statusCode });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("test-email: échec envoi", { to, error: body });
    return res.status(500).json({ error: "Échec envoi email", details: body });
  }
});

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

// ====== Salut / reset triggers ======
function isGreetingOrReset(text) {
  const t = String(text || "").trim().toLowerCase();
  const greetings = [
    "bonjour",
    "bonsoir",
    "salut",
    "salam",
    "hello",
    "yo",
    "coucou",
  ];
  return greetings.includes(t) || t === "menu" || t === "start" || t === "0" || t === "reset" || t === "annuler" || t === "retour" || t === "accueil";
}

// ====== Extract inbound text (text/button/interactive) ======
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

// ====== Plaque helpers ======
function normalizePlate(input) {
  // Remove spaces, hyphens, underscores and convert to uppercase
  const cleaned = String(input || "")
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
  
  // Validate French SIV format: 2 letters + 3 digits + 2 letters
  const sivPattern = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (sivPattern.test(cleaned)) {
    // Format as AA-123-BB for storage/display
    return cleaned.slice(0, 2) + "-" + cleaned.slice(2, 5) + "-" + cleaned.slice(5);
  }
  
  // If not valid, return cleaned version for error handling
  return cleaned;
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

// ====== WhatsApp: mark message as read ======
async function markAsRead(messageId) {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return;
    await fetchFn(`https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  } catch (err) {
    log.debug("markAsRead failed", { messageId, error: String(err?.message || err) });
  }
}

// ====== WhatsApp: typing indicator ======
async function sendTypingIndicator(to) {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return;
    await fetchFn(`https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, recipient_type: "individual", typing_action: "typing_on" }),
    });
  } catch (err) {
    log.debug("sendTypingIndicator failed", { to, error: String(err?.message || err) });
  }
}

// ====== WhatsApp send ======
async function sendWhatsAppText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, text).catch(() => {});
  return json;
}

// ====== WhatsApp interactive buttons ======
async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp Interactive API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp interactive send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp Interactive API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp interactive API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, bodyText).catch(() => {});
  return json;
}

// ====== WhatsApp interactive list ======
async function sendWhatsAppList(to, bodyText, buttonLabel, sections) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections,
        },
      },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp List API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp list send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp List API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp list API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, bodyText).catch(() => {});
  return json;
}

// ====== WhatsApp image message ======
async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const imagePayload = { link: imageUrl };
  if (caption) imagePayload.caption = caption;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: imagePayload,
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp Image API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp image send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp Image API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp image API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, caption || "[image]").catch(() => {});
  return json;
}

// ====== WhatsApp video message ======
async function sendWhatsAppVideo(to, videoUrl, caption = "") {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const videoPayload = { link: videoUrl };
  if (caption) videoPayload.caption = caption;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "video",
      video: videoPayload,
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp Video API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp video send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp Video API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp video API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, caption || "[video]").catch(() => {});
  return json;
}

// ====== WhatsApp location message ======
async function sendWhatsAppLocation(to, latitude, longitude, name, address) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;

  const resp = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "location",
      location: { latitude, longitude, name, address },
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    log.error("WhatsApp Location API error", { status: resp.status, to, body: json });
    throw new Error(`WhatsApp location send failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    log.error("WhatsApp Location API returned error in 200", { to, error: json.error });
    throw new Error(`WhatsApp location API error: ${JSON.stringify(json.error)}`);
  }

  insertOutboundMessage(to, `[📍 ${name}] ${address}`).catch(() => {});
  return json;
}

// ====== WhatsApp media upload (for PDF documents) ======
async function uploadWhatsAppMedia(buffer, filename, mimeType) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/media`;

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    log.error("WhatsApp Media Upload error", { status: resp.status, body: json });
    throw new Error(`Media upload failed: ${JSON.stringify(json.error || json)}`);
  }
  return json.id;
}

// ====== WhatsApp document message ======
async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/${WA_API_VERSION}/${phoneNumberId}/messages`;
  const resp = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { id: mediaId, filename, caption: caption || "" },
    }),
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    log.error("WhatsApp Document API error", { status: resp.status, to, body: json });
    throw new Error(`Document send failed: ${JSON.stringify(json.error || json)}`);
  }
  insertOutboundMessage(to, caption || `[📄 ${filename}]`).catch(() => {});
  return json;
}

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

// ====== Email config (anti-spam) ======
const EMAIL_FROM = { name: "Diagperf", email: process.env.SENDGRID_FROM || "contact@diagperf.com" };
const EMAIL_REPLY_TO = EMAIL_FROM;

// ====== Email devis au client (best effort) ======
async function sendQuoteEmail({ to, devis }) {
  if (!to || !process.env.SENDGRID_API_KEY) return;

  const ref = `DEV-${devis.id}`;
  const htTxt = typeof devis.total_ht_centimes === "number"
    ? `${(devis.total_ht_centimes / 100).toFixed(2)}€`
    : "N/A";
  const ttcTxt = typeof devis.total_ttc_centimes === "number"
    ? `${(devis.total_ttc_centimes / 100).toFixed(2)}€`
    : "N/A";

  const msg = {
    to,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject: `Votre devis Diagperf - ${ref}`,
    text:
      `Bonjour,\n\n` +
      `Voici votre devis Diagperf :\n\n` +
      `Référence : ${ref}\n` +
      `Prestation : ${devis.prestation}\n` +
      `Plaque : ${devis.plaque}\n` +
      `Durée d'intervention : 2 à 4 heures\n` +
      `Total HT : ${htTxt}\n` +
      `Total TTC : ${ttcTxt}\n\n` +
      `Notre équipe vous recontacte rapidement.\n\n` +
      `DiagPerf`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">DiagPerf</h2>` +
      `<p>Bonjour,</p>` +
      `<p>Voici votre devis :</p>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Référence</td><td style="padding:8px;border:1px solid #ddd;">${ref}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Prestation</td><td style="padding:8px;border:1px solid #ddd;">${devis.prestation}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Plaque</td><td style="padding:8px;border:1px solid #ddd;">${devis.plaque}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Durée d'intervention</td><td style="padding:8px;border:1px solid #ddd;">2 à 4 heures</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Total HT</td><td style="padding:8px;border:1px solid #ddd;">${htTxt}</td></tr>` +
      `<tr style="background:#f5f5f5;"><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Total TTC</td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${ttcTxt}</td></tr>` +
      `</table>` +
      `<p>Notre équipe vous recontacte rapidement.</p>` +
      `<p style="color:#888;font-size:12px;">DiagPerf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendQuoteEmail: envoi OK", { to, ref });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendQuoteEmail: échec envoi", { to, ref, error: body });
  }
}

// ====== Email contact recap (envoi à Diag.perf.pro@gmail.com) ======
async function sendContactRecapEmail({ lastName, firstName, contact, prestation, plate, vehicleDesc }) {
  if (!process.env.SENDGRID_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  const msg = {
    to: toEmail,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject: `Nouveau contact via WhatsApp - ${prestation}`,
    text:
      `Nouveau contact via WhatsApp\n\n` +
      `Nom : ${lastName}\n` +
      `Prénom : ${firstName}\n` +
      `Contact (email ou téléphone) : ${contact}\n` +
      `Prestation demandée : ${prestation}\n` +
      `Plaque d'immatriculation : ${plate}\n` +
      `Véhicule détecté : ${vehicleDesc}\n`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">Nouveau contact WhatsApp</h2>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Nom</td><td style="padding:8px;border:1px solid #ddd;">${lastName}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Prénom</td><td style="padding:8px;border:1px solid #ddd;">${firstName}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Contact</td><td style="padding:8px;border:1px solid #ddd;">${contact}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Prestation</td><td style="padding:8px;border:1px solid #ddd;">${prestation}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Plaque</td><td style="padding:8px;border:1px solid #ddd;">${plate}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
      `</table>` +
      `<p style="color:#888;font-size:12px;">DiagPerf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendContactRecapEmail: envoi OK", { to: toEmail, prestation });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendContactRecapEmail: échec envoi", { to: toEmail, error: body });
  }
}

// ====== Email devis client (après RDV ou contact technicien) ======
async function sendRdvClientEmail({ to, firstName, lastName, vehicleDesc, prestationLabel, devisRef, htTxt, ttcTxt, contactReason }) {
  if (!to || !process.env.SENDGRID_API_KEY) return;

  const subjectPrefix = contactReason === "technicien"
    ? "Contact technicien"
    : "Votre devis Diagperf";
  const subject = `${subjectPrefix} - ${prestationLabel} - Ref. ${devisRef}`;

  const msg = {
    to,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject,
    text:
      `Bonjour ${firstName} ${lastName},\n\n` +
      `Nous vous remercions pour votre confiance.\n\n` +
      `Veuillez trouver ci-dessous le récapitulatif de votre devis :\n\n` +
      `Véhicule : ${vehicleDesc}\n` +
      `Prestation : ${prestationLabel}\n` +
      `Durée d'intervention : 2h-4h\n` +
      `Référence devis : ${devisRef}\n` +
      `Total HT : ${htTxt}\n` +
      `Total TTC : ${ttcTxt}\n\n` +
      `Notre équipe vous recontactera dans les plus brefs délais pour convenir d'un rendez-vous.\n\n` +
      `Cordialement,\nL'équipe Diagperf`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">Diagperf</h2>` +
      `<p>Bonjour <strong>${firstName} ${lastName}</strong>,</p>` +
      `<p>Nous vous remercions pour votre confiance.</p>` +
      `<p>Veuillez trouver ci-dessous le récapitulatif de votre devis :</p>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🚗 Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🔧 Prestation</td><td style="padding:8px;border:1px solid #ddd;">${prestationLabel}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">⏱️ Durée d'intervention</td><td style="padding:8px;border:1px solid #ddd;">2h-4h</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence devis</td><td style="padding:8px;border:1px solid #ddd;">${devisRef}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total HT</td><td style="padding:8px;border:1px solid #ddd;">${htTxt}</td></tr>` +
      `<tr style="background:#f5f5f5;"><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total TTC</td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${ttcTxt}</td></tr>` +
      `</table>` +
      `<p>Notre équipe vous recontactera dans les plus brefs délais pour convenir d'un rendez-vous.</p>` +
      `<p>Cordialement,<br><strong>L'équipe Diagperf</strong></p>` +
      `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendRdvClientEmail: envoi OK", { to, devisRef });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendRdvClientEmail: échec envoi", { to, devisRef, error: body });
  }
}

// ====== Email notification Diagperf (après RDV ou contact technicien) ======
async function sendRdvDiagperfEmail({ firstName, lastName, clientEmail, waId, vehicleDesc, engineCode, plate, prestationLabel, devisRef, htTxt, ttcTxt, contactReason }) {
  if (!process.env.SENDGRID_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  const subjectPrefix = contactReason === "technicien"
    ? "Contact technicien"
    : "Nouvelle demande de RDV";
  const subject = `${subjectPrefix} - ${prestationLabel} - ${firstName} ${lastName}`;

  const msg = {
    to: toEmail,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject,
    text:
      `${subjectPrefix} via WhatsApp :\n\n` +
      `Client : ${firstName} ${lastName}\n` +
      `Email : ${clientEmail}\n` +
      `WhatsApp : ${waId}\n` +
      `Véhicule : ${vehicleDesc}\n` +
      `Code moteur : ${engineCode}\n` +
      `Plaque : ${plate}\n` +
      `Prestation : ${prestationLabel}\n` +
      `Durée d'intervention : 2h-4h\n` +
      `Référence devis : ${devisRef}\n` +
      `Total HT : ${htTxt}\n` +
      `Total TTC : ${ttcTxt}\n`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">${subjectPrefix} via WhatsApp</h2>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">👤 Client</td><td style="padding:8px;border:1px solid #ddd;">${firstName} ${lastName}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📧 Email</td><td style="padding:8px;border:1px solid #ddd;">${clientEmail}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📱 WhatsApp</td><td style="padding:8px;border:1px solid #ddd;">${waId}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🚗 Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🔧 Code moteur</td><td style="padding:8px;border:1px solid #ddd;">${engineCode}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🪪 Plaque</td><td style="padding:8px;border:1px solid #ddd;">${plate}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Prestation</td><td style="padding:8px;border:1px solid #ddd;">${prestationLabel}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">⏱️ Durée d'intervention</td><td style="padding:8px;border:1px solid #ddd;">2h-4h</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence devis</td><td style="padding:8px;border:1px solid #ddd;">${devisRef}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total HT</td><td style="padding:8px;border:1px solid #ddd;">${htTxt}</td></tr>` +
      `<tr style="background:#f5f5f5;"><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total TTC</td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${ttcTxt}</td></tr>` +
      `</table>` +
      `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendRdvDiagperfEmail: envoi OK", { to: toEmail, devisRef });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendRdvDiagperfEmail: échec envoi", { to: toEmail, devisRef, error: body });
  }
}

// ====== Email SAV client (confirmation demande SAV) ======
async function sendSavClientEmail({ to, firstName, lastName, savRef, topic, vehicleDesc, description }) {
  if (!to || !process.env.SENDGRID_API_KEY) return;

  const subject = `DiagPerf - Confirmation demande SAV - Ref. ${savRef}`;

  const msg = {
    to,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject,
    text:
      `Bonjour ${firstName} ${lastName},\n\n` +
      `Nous avons bien reçu votre demande SAV.\n\n` +
      `Référence : ${savRef}\n` +
      `Sujet : ${topic}\n` +
      `Véhicule : ${vehicleDesc}\n\n` +
      `Description : ${description}\n\n` +
      `Notre équipe vous recontactera dans les 24h pour traiter votre demande.\n\n` +
      `Cordialement,\nL'équipe DiagPerf`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">Diagperf – Confirmation demande SAV</h2>` +
      `<p>Bonjour <strong>${firstName} ${lastName}</strong>,</p>` +
      `<p>Nous avons bien reçu votre demande SAV.</p>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence</td><td style="padding:8px;border:1px solid #ddd;">${savRef}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🛠️ Sujet</td><td style="padding:8px;border:1px solid #ddd;">${topic}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🚗 Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📝 Description</td><td style="padding:8px;border:1px solid #ddd;">${description}</td></tr>` +
      `</table>` +
      `<p>Notre équipe vous recontactera dans les 24h pour traiter votre demande.</p>` +
      `<p>Cordialement,<br><strong>L'équipe DiagPerf</strong></p>` +
      `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendSavClientEmail: envoi OK", { to, savRef });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendSavClientEmail: échec envoi", { to, savRef, error: body });
  }
}

// ====== Email SAV notification Diagperf ======
async function sendSavDiagperfEmail({ firstName, lastName, clientEmail, waId, vehicleDesc, plate, topic, description, savRef }) {
  if (!process.env.SENDGRID_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  const subject = `Nouveau ticket SAV - ${topic} - ${firstName} ${lastName}`;

  const msg = {
    to: toEmail,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    subject,
    text:
      `Nouveau ticket SAV via WhatsApp\n\n` +
      `Référence : ${savRef}\n` +
      `Sujet : ${topic}\n\n` +
      `Client : ${firstName} ${lastName}\n` +
      `Email : ${clientEmail}\n` +
      `WhatsApp : ${waId}\n\n` +
      `Véhicule : ${vehicleDesc}\n` +
      `Plaque : ${plate}\n\n` +
      `Description : ${description}\n\n` +
      `Date : ${new Date().toISOString()}`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">` +
      `<h2 style="color:#1a1a1a;">Nouveau ticket SAV via WhatsApp</h2>` +
      `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence</td><td style="padding:8px;border:1px solid #ddd;">${savRef}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🛠️ Sujet</td><td style="padding:8px;border:1px solid #ddd;">${topic}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">👤 Client</td><td style="padding:8px;border:1px solid #ddd;">${firstName} ${lastName}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📧 Email</td><td style="padding:8px;border:1px solid #ddd;">${clientEmail}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📱 WhatsApp</td><td style="padding:8px;border:1px solid #ddd;">${waId}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🚗 Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🪪 Plaque</td><td style="padding:8px;border:1px solid #ddd;">${plate}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📝 Description</td><td style="padding:8px;border:1px solid #ddd;">${description}</td></tr>` +
      `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📅 Date</td><td style="padding:8px;border:1px solid #ddd;">${new Date().toISOString()}</td></tr>` +
      `</table>` +
      `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
      `</div>`,
  };

  try {
    await sgMail.send(msg);
    log.info("sendSavDiagperfEmail: envoi OK", { to: toEmail, savRef });
  } catch (err) {
    const body = err?.response?.body || err.message;
    log.error("sendSavDiagperfEmail: échec envoi", { to: toEmail, savRef, error: body });
  }
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

// ====== Helpers: parsing ======
function parseNumberFromString(str) {
  if (!str) return null;
  const m = String(str).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function parseYearFromDateFR(dateFr) {
  if (!dateFr) return null;
  const m = String(dateFr).match(/(\d{4})$/);
  return m ? Number(m[1]) : null;
}

// ====== Reprog Shiftech: helpers ======
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mapFuelToCarburant(fuel) {
  const f = String(fuel || "").toUpperCase();
  if (["DIESEL", "GAZOLE", "GO"].some((k) => f.includes(k))) return "diesel";
  if (["ES", "ESSENCE", "PETROL"].some((k) => f.includes(k))) return "petrol";
  return null;
}

async function lookupReprogStages(vehicle) {
  const marque = slugify(vehicle?.make);
  const carburant = mapFuelToCarburant(vehicle?.fuel);
  const hp = vehicle?.power_hp;
  const year = vehicle?.year;

  if (!marque || !carburant || typeof hp !== "number" || hp <= 0) return [];

  const hpMin = hp - 5;
  const hpMax = hp + 5;

  // Extract first significant word from model for ilike filter
  // e.g. "GOLF VI 2.0 TDI" → "golf", "3 SERIE" → "3"
  const modelSlug = slugify(
    String(vehicle?.model || "").split(/[\s\/]+/).find((w) => w.length >= 1) || ""
  );

  // Extract cylindre from model or trim (e.g. "2.0" from "GOLF VI 2.0 TDI")
  const cylMatch = String(vehicle?.model || "").match(/(\d+\.\d+)/)
    || String(vehicle?.trim || "").match(/(\d+\.\d+)/);
  const cylindree = cylMatch ? cylMatch[1] : null;

  // Build version year patterns for ilike (year 1)
  const versionYears = [];
  if (typeof year === "number" && year > 1990) {
    versionYears.push(String(year));
    versionYears.push(String(year - 1));
    versionYears.push(String(year + 1));
  }

  // Helper: run a single Supabase query with given filters
  async function queryStages({ useModel, useVersion, useCylindree }) {
    let q = supabase
      .from("reprog_moteurs")
      .select("*")
      .eq("marque", marque)
      .eq("carburant", carburant)
      .gte("puissance_origine", hpMin)
      .lte("puissance_origine", hpMax)
      .neq("stage", "gearbox");

    if (useModel && modelSlug) {
      q = q.ilike("modele", `%${modelSlug}%`);
    }

    if (useVersion && versionYears.length > 0) {
      // version starts with year: OR across year, year-1, year+1
      q = q.or(versionYears.map((y) => `version.ilike.${y}%`).join(","));
    }

    if (useCylindree && cylindree) {
      q = q.ilike("moteur_slug", `%${cylindree.replace(".", "-")}%`);
    }

    const { data, error } = await q.order("prix_centimes", { ascending: true });
    if (error) {
      log.error("lookupReprogStages: erreur Supabase", {
        error: error.message, marque, modelSlug, carburant, hp,
        useModel, useVersion, useCylindree,
      });
      return null;
    }
    return data && data.length > 0 ? data : null;
  }

  // Tiered matching: most precise first, stop at first hit
  let rows = null;
  let matchTier = null;

  // Tier 1: marque + modle + version(year1) + carburant + cylindre + puissance5
  if (modelSlug && versionYears.length > 0 && cylindree) {
    rows = await queryStages({ useModel: true, useVersion: true, useCylindree: true });
    if (rows) matchTier = "tier1:model+version+cyl";
  }

  // Tier 2: marque + modle + version(year1) + carburant + puissance5
  if (!rows && modelSlug && versionYears.length > 0) {
    rows = await queryStages({ useModel: true, useVersion: true, useCylindree: false });
    if (rows) matchTier = "tier2:model+version";
  }

  // Tier 3: marque + modle + carburant + puissance5 (previous fallback)
  if (!rows && modelSlug) {
    rows = await queryStages({ useModel: true, useVersion: false, useCylindree: false });
    if (rows) matchTier = "tier3:model";
  }

  // Tier 4: marque + carburant + puissance5 (last resort)
  if (!rows) {
    rows = await queryStages({ useModel: false, useVersion: false, useCylindree: false });
    if (rows) matchTier = "tier4:marque-only";
  }

  if (!rows || rows.length === 0) return [];

  // Group by moteur_slug and pick the motor whose puissance_origine is closest to hp
  const byMotor = new Map();
  for (const row of rows) {
    const key = row.moteur_slug || "__unknown__";
    if (!byMotor.has(key)) byMotor.set(key, []);
    byMotor.get(key).push(row);
  }

  let bestMotor = null;
  let bestDiff = Infinity;
  for (const [key, motorRows] of byMotor) {
    const refHp = motorRows[0].puissance_origine;
    const diff = Math.abs(refHp - hp);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMotor = key;
    }
  }

  const result = bestMotor ? byMotor.get(bestMotor) : [];
  if (result.length > 0) {
    const matched = result[0];
    log.info("lookupReprogStages: moteur match", {
      matchTier,
      moteur_slug: matched.moteur_slug,
      version: matched.version,
      puissance_origine: matched.puissance_origine,
      marque, modelSlug, cylindree, year: year || null, hp,
    });
  }

  return result;
}

function formatStageLabel(stage) {
  const map = { stage1: "STAGE 1", stage2: "STAGE 2", e85: "E85", e85plus: "E85+" };
  return map[stage] || stage.toUpperCase();
}

// ====== VEHICLE API (apiplaqueimmatriculation.com) ======
// .env  ajouter :
// IMMATRICULATION_API_URL=https://api.apiplaqueimmatriculation.com
// IMMATRICULATION_API_TOKEN=xxxxx
// IMMATRICULATION_API_COUNTRY=FR
async function fetchVehicleFromPlate(plate) {
  const baseUrl = process.env.IMMATRICULATION_API_URL;
  const token = process.env.IMMATRICULATION_API_TOKEN;
  const country = process.env.IMMATRICULATION_API_COUNTRY || "FR";

  if (!baseUrl || !token) {
    throw new Error("IMMATRICULATION_API_NOT_CONFIGURED");
  }

  const normalized = normalizePlate(plate).replace(/-/g, "");

  const url =
    `${baseUrl}/plaque?immatriculation=${encodeURIComponent(normalized)}` +
    `&token=${encodeURIComponent(token)}` +
    `&pays=${encodeURIComponent(country)}`;

  const resp = await fetchFn(url, { method: "POST" });
  const body = await resp.text();

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    log.error("Immatriculation API: rponse non-JSON", { body: body.slice(0, 300) });
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      log.warn("Immatriculation API: token expir/quota (401) - fallback manuel", { status: resp.status, code_erreur: json.code_erreur });
      throw new Error("IMMATRICULATION_API_INVALID_TOKEN");
    }
    log.error("Immatriculation API HTTP error", { status: resp.status, code_erreur: json.code_erreur, message: json.message, erreur: json.data?.erreur });
    if (resp.status === 403) {
      throw new Error("IMMATRICULATION_API_INVALID_TOKEN");
    }
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  if (json.code_erreur !== 200) {
    log.error("Immatriculation API code_erreur", { code_erreur: json.code_erreur, message: json.message, erreur: json.data?.erreur });
    throw new Error("IMMATRICULATION_API_FAILED");
  }

  const data = json.data;

  // 1) Pas de data
  if (!data) {
    log.warn("VEHICLE_NOT_FOUND: data absente", { plaque: normalized });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  // 2) data.erreur truthy (string non vide, objet, etc.)
  if (data.erreur) {
    log.warn("VEHICLE_NOT_FOUND: data.erreur", { plaque: normalized, erreur: data.erreur });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  // 3) marque obligatoire (string non vide)
  if (!data.marque || typeof data.marque !== "string" || !data.marque.trim()) {
    log.warn("VEHICLE_NOT_FOUND: marque absente", { plaque: normalized, marque: data.marque });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  // 4) modele obligatoire (string non vide)
  if (!data.modele || typeof data.modele !== "string" || !data.modele.trim()) {
    log.warn("VEHICLE_NOT_FOUND: modele absent", { plaque: normalized, modele: data.modele });
    throw new Error("VEHICLE_NOT_FOUND");
  }

  return json;
}

// Normalisation vers ton format interne
function standardizeVehicleData(raw, plate) {
  const data = raw?.data || {};

  return {
    plate: normalizePlate(plate),
    make: data.marque || null,
    model: data.modele || null,
    trim: data.version || data.sra_commercial || null,
    year: parseYearFromDateFR(data.date1erCir_fr),
    fuel: data.energieNGC || data.type_moteur || null,
    transmission: data.boite_vitesse || null,
    engine_cc: parseNumberFromString(data.ccm),
    power_hp: parseNumberFromString(data.puisFiscReelCH),
    power_kw: parseNumberFromString(data.puisFiscReelKW),
    vin: data.vin || null,
    engine_code: data.code_moteur || null,
    color: data.couleur || null,
    raw,
    source: "apiplaqueimmatriculation",
  };
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

// ====== Intent detection ======
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

  // Toujours matcher les numéros de menu (1-8)
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (t === cfg.menu) return intent;
  }

  // Si le message est une QUESTION → ne pas matcher par mots-clés
  // → laisser le RAG/LLM répondre intelligemment
  const questionPatterns = [
    /^(combien|quel|quelle|quels|quelles|comment|pourquoi|est[\s-]ce|c'est quoi|qu'est|quoi|o|ou est|a coute|ca coute)/,
    /\?$/,
    /^(le |la |les |un |une |des )?(prix|tarif|coût|cout|durée|duree|garantie|horaire|adresse|compatib)/,
  ];
  if (questionPatterns.some((re) => re.test(t))) return null;

  // Sinon, matcher par mots-clés
  for (const [intent, cfg] of Object.entries(INTENT_MAP)) {
    if (cfg.keywords.some((kw) => t.includes(kw))) return intent;
  }
  return null;
}

function intentToPrestationCode(intent) {
  return INTENT_MAP[intent]?.code || null;
}

function intentToLabel(intent) {
  const labels = {
    REPROG: "Reprogrammation moteur",
    E85: "Conversion E85",
    FAP: "Suppression FAP",
    EGR: "Suppression EGR",
    ADBLUE: "Suppression ADBlue",
    DIAG: "Diagnostic complet",
    AUTRES: "Autres prestations",
    SAV: "SAV / Réclamation",
  };
  return labels[intent] || intent;
}

// ====== Plate validation (strict FR format) ======
function validatePlate(input) {
  const normalized = normalizePlate(input);
  // Check if the normalized format matches AA-123-BB
  const sivFormat = /^[A-Z]{2}-\d{3}-[A-Z]{2}$/;
  if (sivFormat.test(normalized)) {
    return { valid: true, plate: normalized };
  }
  return { valid: false, plate: normalized };
}

// ====== Email validation ======
function validateEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  return re.test(email) ? email : null;
}

// ====== Vehicle lookup (shared by both flows) ======
async function lookupVehicleFromPlate(plate) {
  const raw = await fetchVehicleFromPlate(plate);
  return standardizeVehicleData(raw, plate);
}

// ====== Generic pricing from tarifs_prestations ======
// DB schema: tarifs_prestations(prestation_id FK -> prestations.id, prix_base_centimes, actif)
async function getPrestationTarif(prestationCode) {
  // Step 1: resolve prestations.id from code
  const { data: presta, error: pErr } = await supabase
    .from("prestations")
    .select("id")
    .eq("code", prestationCode)
    .maybeSingle();

  if (pErr) {
    log.error("getPrestationTarif: erreur lookup prestation", { prestationCode, error: pErr.message });
    return null;
  }
  if (!presta) {
    log.warn("getPrestationTarif: prestation inconnue", { prestationCode });
    return null;
  }

  // Step 2: fetch tarif by prestation_id + actif
  const { data, error } = await supabase
    .from("tarifs_prestations")
    .select("prix_base_centimes")
    .eq("prestation_id", presta.id)
    .eq("actif", true)
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error("getPrestationTarif: erreur DB tarif", { prestationCode, error: error.message });
    return null;
  }
  return data; // null = pas de tarif trouvé
}

async function getPrestationLibelle(prestationCode) {
  const { data, error } = await supabase
    .from("prestations")
    .select("nom")
    .eq("code", prestationCode)
    .maybeSingle();

  if (error || !data) return prestationCode;
  return data.nom;
}

// ====== Reprog pricing rule ======
// < 400 HP ET année < 2018 → 390€ TTC (39000 centimes)
// Sinon (ou données manquantes) → null (Sur devis personnalisé)
function computeReprogPrice(vehicle) {
  const hp = vehicle?.power_hp;
  const year = vehicle?.year;
  if (typeof hp === "number" && hp > 0 && typeof year === "number" && hp < 400 && year < 2018) {
    return STAGE1_FIXED_PRICE_CENTS;
  }
  return null;
}

// ====== E85 pricing rule ======
// Année < 2020 → 490€ TTC (49000 centimes)
// Sinon (ou données manquantes) → null (Sur devis personnalisé)
function computeE85Price(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2020) {
    return 49000;
  }
  return null;
}

// ====== ADBlue pricing rule ======
// Prix TTC. BlueHDi détecté → 260€ TTC (26000 centimes)
// Sinon → 300€ TTC (30000 centimes)
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

// ====== FAP pricing rule ======
// Prix TTC. Année < 2019 → 260€ TTC (26000 centimes)
// Année ≥ 2019 ou absente → 300€ TTC (30000 centimes)
function computeFapPrice(vehicle) {
  const year = vehicle?.year;
  if (typeof year === "number" && year < 2019) {
    return 26000;
  }
  return 30000;
}

// ====== FIX #1 : Intents dont le prix calculé est déjà TTC ======
const TTC_INTENTS = new Set(["REPROG", "E85", "FAP", "ADBLUE", "DIAG"]);

// ====== Stage 1 fixed price constant ======
const STAGE1_FIXED_PRICE_CENTS = 39000; // 390€ TTC

const UPSELL_OPTIONS = {
  FAP: [
    {
      id: "fap_meca", label: "Suppression mécanique FAP", priceCents: 25000, prestationCode: "suppression_mecanique_fap",
      message:
        `Excellente décision ! 🎉\n\n` +
        `💡 Nous vous recommandons la *suppression mécanique du FAP*.\n\n` +
        `En plus de la suppression logicielle, le retrait physique du filtre à particules permet d'éliminer tout risque de colmatage futur et d'améliorer le flux d'échappement.\n\n` +
        `➕ Suppression mécanique FAP : +250€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+250€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "egr", label: "Suppression EGR", priceCents: 9000, prestationCode: "suppression_egr",
      message:
        `Excellente décision ! 🎉\n\n` +
        `💡 Nous vous recommandons également la *suppression EGR* pour optimiser pleinement votre moteur.\n\n` +
        `La vanne EGR encrassée peut réduire les performances et augmenter la consommation. En la combinant avec la suppression FAP, vous obtenez un résultat optimal.\n\n` +
        `➕ Suppression EGR : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "adblue", label: "Suppression AdBlue", priceCents: 9000, prestationCode: "suppression_adblue",
      message:
        `💡 Votre véhicule est peut-être équipé du système *AdBlue*. Sa suppression permet d'éviter les pannes liées au système SCR et les coûts d'entretien associés.\n\n` +
        `➕ Suppression AdBlue : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "reprog", label: "Reprogrammation Stage 1", priceCents: 28000, prestationCode: "reprogrammation",
      message:
        `💡 Pour aller encore plus loin, nous proposons la *reprogrammation moteur Stage 1*.\n\n` +
        `Après suppression du FAP (et EGR si ajout), la reprog permet de libérer tout le potentiel de votre moteur : plus de puissance, plus de couple, et une meilleure réponse à l'accélération.\n\n` +
        `➕ Reprogrammation Stage 1 : +280€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+280€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
  ADBLUE: [
    {
      id: "fap", label: "Suppression FAP", priceCents: 9000, prestationCode: "suppression_fap",
      message:
        `Excellente décision ! 🎉\n\n` +
        `💡 Nous vous recommandons également la *suppression FAP* pour un fonctionnement optimal de votre moteur.\n\n` +
        `En combinant la suppression AdBlue et FAP, vous éliminez les deux principales sources de problèmes sur les moteurs diesel modernes.\n\n` +
        `➕ Suppression FAP : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "egr", label: "Suppression EGR", priceCents: 9000, prestationCode: "suppression_egr",
      message:
        `💡 Pour compléter le traitement, nous proposons la *suppression EGR*.\n\n` +
        `La vanne EGR est souvent responsable de l'encrassement du moteur. Sa suppression améliore la fiabilité et les performances.\n\n` +
        `➕ Suppression EGR : +90€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+90€)",
      skipBtnLabel: "⏭️ Suivant",
    },
    {
      id: "reprog", label: "Reprogrammation Stage 1", priceCents: 28000, prestationCode: "reprogrammation",
      message:
        `💡 Pour libérer tout le potentiel de votre moteur, nous proposons la *reprogrammation moteur Stage 1*.\n\n` +
        `➕ Reprogrammation Stage 1 : +280€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+280€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
  E85: [
    {
      id: "e85_bougies",
      label: "Bougies d'allumage éthanol",
      priceCents: 17000,
      message:
        `Excellente décision ! 🎉\n\n` +
        `💡 Nous préconisons fortement le changement des *bougies d'allumage classiques* par des *bougies d'allumage adaptées à l'éthanol*.\n\n` +
        `Les bougies standard ne sont pas optimisées pour le bioéthanol. Des bougies adaptées garantissent un meilleur démarrage, une combustion optimale et une durée de vie prolongée du moteur.\n\n` +
        `➕ Bougies d'allumage éthanol : +170€ TTC\n\n` +
        `Souhaitez-vous ajouter cette option ?`,
      addBtnLabel: "✅ Ajouter (+170€)",
      skipBtnLabel: "⏭️ Non merci",
    },
  ],
};

// ====== Intents that have upsells ======
const UPSELL_INTENTS = new Set(["FAP", "ADBLUE", "E85"]);

// ====== Voice transcription (Groq Whisper — free tier) ======
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";

async function downloadWhatsAppMedia(mediaId) {
  const token = process.env.WHATSAPP_TOKEN;
  // Step 1: get media URL
  const metaResp = await fetchFn(`https://graph.facebook.com/${WA_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaResp.ok) throw new Error(`Media meta failed: ${metaResp.status}`);
  const meta = await metaResp.json();
  const mediaUrl = meta.url;
  if (!mediaUrl) throw new Error("No media URL in response");

  // Step 2: download the actual file
  const fileResp = await fetchFn(mediaUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileResp.ok) throw new Error(`Media download failed: ${fileResp.status}`);
  const buffer = Buffer.from(await fileResp.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || "audio/ogg" };
}

async function transcribeAudio(audioBuffer, mimeType) {
  if (!GROQ_API_KEY) return null;

  // Build multipart form data manually
  const boundary = "----FormBoundary" + Date.now().toString(36);
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "ogg";
  const filename = `audio.${ext}`;

  const parts = [];
  // model field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo`);
  // language field
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nfr`);
  // file field
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const fileFooter = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(parts.join("\r\n") + "\r\n" + fileHeader, "utf-8");
  const footerBuf = Buffer.from(fileFooter, "utf-8");
  const bodyBuffer = Buffer.concat([headerBuf, audioBuffer, footerBuf]);

  const resp = await fetchFn("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: bodyBuffer,
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    log.error("Groq transcription error", { status: resp.status, body: errText.slice(0, 200) });
    return null;
  }

  const result = await resp.json();
  const transcript = (result.text || "").trim();
  log.info("Voice transcribed", { chars: transcript.length, preview: transcript.slice(0, 80) });
  return transcript || null;
}

// ====== Non-text message types (media, calls, etc.) ======
const VOICE_TYPES = new Set(["voice", "audio"]);
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

// ====== LLM / RAG : interprétation intelligente des messages ======
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-20250414";

const LLM_SYSTEM_PROMPT = `Tu es l'assistant WhatsApp de **DiagPerf**, garage spécialisé en reprogrammation moteur et diagnostic automobile à Villenoy (77124), près de Meaux en Île-de-France.

IDENTITÉ & TON :
- Tu t'appelles "l'assistant DiagPerf". Tu tutoies le client (style jeune garage passionné).
- Ton : chaleureux, passionné d'automobile, expert technique mais accessible. Utilise des emojis avec parcimonie (1-2 par message max).
- Tu es fier de ton travail : garantie 2 ans, +24 000 motorisations couvertes, outils pro, résultats prouvés.
- Tu ne fais JAMAIS de promesses exagérées. Tu restes honnête et transparent.
- Longueur : 2-4 phrases max pour une réponse simple, 5-8 pour une explication technique. Jamais de pavé.

EXPERTISE MÉTIER :
- Reprogrammation moteur (Stage 1 à 4) : optimisation cartographie calculateur, gains puissance/couple
- Conversion E85/Flexfuel : UNIQUEMENT véhicules essence (diesel = incompatible, propose reprog à la place)
- Suppression FAP, EGR, AdBlue : prestations diesel
- Diagnostic auto : 3 niveaux (simple 50€, approfondi 80€, recherche panne 130€)
- Options : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme (sur devis)
- Stage 1 : reste dans les marges mécaniques du moteur d'origine, ne l'abîme pas
- Garantie 2 ans sur reprog et E85. Intervention gratuite si problème lié à la prestation.
- CT : Stage 1 et E85 n'affectent pas le contrôle technique. FAP/EGR/AdBlue → à discuter au cas par cas.
- Assurance : pas d'obligation de déclarer un Stage 1 ou E85.

CROSS-SELLING (propose naturellement quand c'est pertinent) :
- Client E85 essence → propose les bougies éthanol (+170€) pour démarrage optimal
- Client reprog diesel → propose suppression FAP/EGR/AdBlue en add-on (à partir de +90€)
- Client diagnostic → si le diag révèle un potentiel, propose la reprog
- Client reprog essence → propose la conversion E85 en complément
- JAMAIS de forcing commercial. Propose une seule option complémentaire max, en fin de message.

OBJECTIONS FRÉQUENTES (réponds avec assurance) :
- "C'est fiable ?" → Stage 1 respecte les marges mécaniques, garantie 2 ans, +24 000 motorisations maîtrisées
- "C'est légal ?" → Pas de changement carte grise, CT normal, pas d'obligation assurance
- "C'est cher" → Rapport qualité/prix, garantie 2 ans incluse, devis gratuit sans engagement
- "Ça abîme le moteur ?" → Non, on reste dans les tolérances constructeur, on recommande un diag pré-reprog

INFOS PRATIQUES :
- Adresse : 38 Rue Jean Pierre Plicque, 77124 Villenoy (parking gratuit, 5 min gare de Meaux ligne P)
- Horaires : Mar-Ven 10h-18h, Sam 10h-16h (sur RDV), Dim-Lun fermé
- Contact : WhatsApp (ce chat), email Diag.perf.pro@gmail.com, tél 06 75 54 70 85, Instagram @diagperf
- Délai RDV : 2-5 jours ouvrés
- Paiement : CB, espèces, virement
- Processus : choix prestation → plaque → devis instantané → RDV → intervention jour même → restitution

FORMATAGE WHATSAPP :
- Utilise *gras* pour les prix et infos clés (pas de markdown ## ou liens)
- Sauts de ligne pour aérer
- Max 800 caractères par message

INSTRUCTIONS DE RÉPONSE :
Retourne UNIQUEMENT du JSON brut (pas de backticks, pas de markdown autour).

Cas 1 — Le client DEMANDE EXPLICITEMENT de lancer/commander une prestation ("je veux faire une reprog", "lance un diagnostic", "je voudrais passer au E85") :
{ "type": "intent", "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV" }
⚠️ UNIQUEMENT si le client veut DÉMARRER la prestation. Pas de champ "message".

Cas 2 — Le client pose une QUESTION ou demande une INFO (prix, tarif, durée, garantie, compatibilité, horaires, adresse, différence entre…) :
{ "type": "answer", "message": "Ta réponse" }
⚠️ "Combien coûte X ?" / "C'est quoi X ?" / "Quelle durée ?" = TOUJOURS Cas 2, jamais Cas 1.
⚠️ Termine toujours par une proposition d'action ("Tu veux qu'on lance le devis ?" / "Je peux t'aider pour autre chose ?").

Cas 3 — Incompréhensible, hors sujet, ou message trop vague ("ok", "oui", "non", une plaque d'immat) :
{ "type": "menu" }

CHAMP OPTIONNEL — Localisation :
Si le client demande l'adresse, comment venir, la localisation ou les horaires, ajoute "sendLocation": true dans ton JSON.
Exemple : { "type": "answer", "message": "On est au 38 Rue Jean Pierre Plicque à Villenoy...", "sendLocation": true }

RÈGLES ABSOLUES :
- JSON brut uniquement, sans backticks
- Ne donne JAMAIS un prix que tu ne connais pas → dis "sur devis personnalisé"
- Ne te base JAMAIS sur l'historique pour déduire un intent. Seul le DERNIER message compte.
- Un intent (Cas 1) nécessite une demande EXPLICITE dans le message actuel
- SALUTATIONS ("bonjour", "salut", "hello", "ça va") → Cas 2 : accueil chaleureux + propose tes services. JAMAIS un intent.
- Si un client demande un service qu'on ne fait pas → oriente vers ce qu'on sait faire ou propose de contacter l'équipe`;

async function askLLM(userMessage, waId) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    // 1. Retrieval : chercher les chunks pertinents dans la base de connaissances (hybride v2)
    let ragContext = "";
    try {
      const chunks = await retrieveContext(supabase, userMessage, {
        matchCount: 8,
        matchThreshold: 0.2,
        keywordWeight: 0.3,
      });
      ragContext = formatContextForPrompt(chunks, 4800);
      log.info("RAG retrieval", { query: userMessage.slice(0, 60), chunksFound: chunks.length, contextChars: ragContext.length, topScore: chunks[0]?.combinedScore?.toFixed(2) || "N/A" });
    } catch (ragErr) {
      log.warn("RAG retrieval failed, continuing without context", { error: String(ragErr?.message || ragErr) });
    }

    // 2. Construire le system prompt avec le contexte RAG + grille tarifaire toujours incluse
    let systemPrompt = LLM_SYSTEM_PROMPT;
    systemPrompt += `\n\nGRILLE TARIFAIRE COMPLÈTE (prix TTC) :
🏎️ REPROG Stage 1 : 390€ (<400ch et <2018) | sinon sur devis
🏎️ REPROG Stage 2/3/4 : sur devis (modifications mécaniques requises)
⛽ Conversion E85 : 490€ (essence <2020) | sinon sur devis
🔧 Suppression FAP : 260€ (diesel <2019) | 300€ (≥2019)
🔧 Suppression AdBlue : 260€ (BlueHDi PSA) | 300€ (autres diesel)
🔧 Suppression EGR : sur devis
🔍 Diag simple : 50€ (20min) | Diag approfondi : 80€ (35min) | Recherche panne : 130€ (1h)
➕ Options add-on : bougies E85 +170€ | suppression méca FAP +250€ | EGR add-on +90€ | AdBlue add-on +90€ | FAP add-on +90€ | Reprog add-on +280€
🎨 Sur devis : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme
💡 Devis gratuit et sans engagement.`;
    if (ragContext) {
      systemPrompt += `\n\nCONTEXTE RÉCUPÉRÉ DE LA BASE DE CONNAISSANCES (utilise ces infos en priorité pour répondre, elles sont fiables et à jour) :\n${ragContext}`;
    }

    // 3. Construire les messages avec historique de conversation
    let chatMessages = [];
    if (waId) {
      try {
        const history = await getRecentMessages(waId, 10);
        if (history.length > 0) {
          // Filtrer les doublons avec le message courant et s'assurer d'alterner user/assistant
          const filtered = history.filter(m => m.content !== userMessage);
          // Claude exige que les messages alternent user/assistant
          let lastRole = null;
          for (const m of filtered) {
            if (m.role !== lastRole) {
              chatMessages.push(m);
              lastRole = m.role;
            }
          }
          log.info("LLM history loaded", { wa_id: waId, historyLen: chatMessages.length });
        }
      } catch (histErr) {
        log.warn("LLM history load failed", { error: String(histErr?.message || histErr) });
      }
    }
    // Ajouter le message courant
    chatMessages.push({ role: "user", content: userMessage });

    // 4. Appeler Claude
    const resp = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        system: systemPrompt,
        messages: chatMessages,
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      log.error("LLM API error", { status: resp.status, body: errBody.slice(0, 200) });
      return null;
    }

    const json = await resp.json();
    let content = json.content?.[0]?.text;
    if (!content) return null;

    // Strip markdown code blocks (Claude Sonnet peut envelopper le JSON dans ```json ... ```)
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    const parsed = JSON.parse(content);
    log.info("LLM response", { type: parsed.type, intent: parsed.intent || null, msgLen: (parsed.message || "").length });
    return parsed;
  } catch (err) {
    log.error("LLM call failed", { error: String(err?.message || err) });
    return null;
  }
}

// ====== Generic devis creation ======
// FIX #2 : nouveau paramètre `priceIsTtc` pour distinguer HT vs TTC
async function createDevis({ prestationCode, plate, waId, vehicleYear, priceCentsOverride, priceIsTtc }) {
  if (!plate || typeof plate !== "string" || !plate.trim()) {
    log.error("createDevis: plaque invalide", { plate });
    throw new Error("INVALID_PLATE");
  }
  if (!prestationCode) {
    log.error("createDevis: prestationCode manquant");
    throw new Error("INVALID_PRESTATION");
  }

  const tauxTva = 0.20;
  let totalHt, totalTva, totalTtc;

  if (typeof priceCentsOverride === "number" && priceCentsOverride > 0) {
    // FIX #2 : si le prix fourni est déjà TTC, on en déduit le HT
    if (priceIsTtc) {
      totalTtc = priceCentsOverride;
      totalHt  = Math.round(totalTtc / (1 + tauxTva));
      totalTva = totalTtc - totalHt;
    } else {
      totalHt  = priceCentsOverride;
      totalTva = Math.round(totalHt * tauxTva);
      totalTtc = totalHt + totalTva;
    }
  } else if (priceCentsOverride === null) {
    log.warn("createDevis: prix sur devis personnalisé (override null)", { prestationCode });
    throw new Error("NO_TARIF");
  } else {
    const tarif = await getPrestationTarif(prestationCode);
    if (!tarif || !tarif.prix_base_centimes || tarif.prix_base_centimes <= 0) {
      log.warn("createDevis: pas de tarif trouvé", { prestationCode });
      throw new Error("NO_TARIF");
    }
    totalHt  = tarif.prix_base_centimes;
    totalTva = Math.round(totalHt * tauxTva);
    totalTtc = totalHt + totalTva;
  }

  const libelle = await getPrestationLibelle(prestationCode);

  // Idempotency key includes wa_id so different users don't share a devis,
  // and totalTtc so price changes trigger a new devis (instead of returning a stale one)
  const idempotencyKey = `${prestationCode}:${normalizePlate(plate)}:${waId || "anon"}:${totalTtc}`;

  // 1) Insert devis
  const { data: devis, error: devisErr } = await supabase
    .from("devis")
    .insert({
      plaque: plate,
      prestation_code: prestationCode,
      wa_id: waId || null,
      total_ht_centimes: totalHt,
      taux_tva: tauxTva,
      total_tva_centimes: totalTva,
      total_ttc_centimes: totalTtc,
      source: "whatsapp",
      statut: "draft",
      idempotency_key: idempotencyKey,
    })
    .select("id, total_ht_centimes, total_ttc_centimes")
    .single();

  // 2) Si doublon (unique violation 23505), retourner le devis existant
  //    et mettre à jour les totaux si stale (edge case: ancien devis avec prix différent)
  if (devisErr) {
    const code = devisErr.code || devisErr.details || String(devisErr.message || "");
    if (String(code).includes("23505") || String(devisErr.message || "").includes("duplicate")) {
      log.warn("createDevis: doublon détecté, récupération existant", { idempotencyKey });
      const { data: existing, error: selErr } = await supabase
        .from("devis")
        .select("id, total_ht_centimes, total_ttc_centimes")
        .eq("idempotency_key", idempotencyKey)
        .single();
      if (selErr) throw selErr;
      // Si les totaux de l'existant divergent du calcul actuel, on les corrige
      if (existing.total_ht_centimes !== totalHt || existing.total_ttc_centimes !== totalTtc) {
        log.warn("createDevis: totaux stale détectés, correction", {
          devisId: existing.id,
          oldHt: existing.total_ht_centimes, newHt: totalHt,
          oldTtc: existing.total_ttc_centimes, newTtc: totalTtc,
        });
        const { data: updated } = await supabase
          .from("devis")
          .update({ total_ht_centimes: totalHt, total_tva_centimes: totalTva, total_ttc_centimes: totalTtc })
          .eq("id", existing.id)
          .select("id, total_ht_centimes, total_ttc_centimes")
          .single();
        if (updated) return { ...updated, isNew: false };
      }
      return { ...existing, isNew: false };
    }
    throw devisErr;
  }

  // 3) Insert devis_lignes (seulement si nouveau devis)
  const { error: ligneErr } = await supabase
    .from("devis_lignes")
    .insert({
      devis_id: devis.id,
      prestation_id: null,
      libelle,
      quantite: 1,
      prix_unitaire_ht_centimes: totalHt,
      tva_taux: tauxTva,
      ordre: 1,
    });

  if (ligneErr) throw ligneErr;

  return { ...devis, isNew: true };
}

// ====== Add upsell options to an existing devis ======
async function addUpsellOptionsToDevis(devisId, addedOptionIds, upsellType) {
  if (!devisId || devisId === "N/A") return;

  const tauxTva = 0.20;
  const options = UPSELL_OPTIONS[upsellType] || [];
  const accepted = options.filter(o => addedOptionIds.includes(o.id));

  if (accepted.length === 0) return;

  // Get current max ordre
  const { data: existingLines } = await supabase
    .from("devis_lignes")
    .select("ordre")
    .eq("devis_id", devisId)
    .order("ordre", { ascending: false })
    .limit(1);

  let nextOrdre = (existingLines?.[0]?.ordre || 1) + 1;
  let additionalTtc = 0;

  for (const opt of accepted) {
    const optTtc = opt.priceCents;
    const optHt = Math.round(optTtc / (1 + tauxTva));

    const { error: ligneErr } = await supabase.from("devis_lignes").insert({
      devis_id: devisId,
      prestation_id: null,
      libelle: opt.label,
      quantite: 1,
      prix_unitaire_ht_centimes: optHt,
      tva_taux: tauxTva,
      ordre: nextOrdre++,
    });

    if (ligneErr) {
      log.error("addUpsellOptionsToDevis: insert ligne failed", { devisId, opt: opt.id, error: ligneErr.message });
    }

    additionalTtc += optTtc;
  }

  // Recalculate totals
  const { data: devis, error: fetchErr } = await supabase
    .from("devis")
    .select("total_ht_centimes, total_tva_centimes, total_ttc_centimes")
    .eq("id", devisId)
    .single();

  if (fetchErr) {
    log.error("addUpsellOptionsToDevis: fetch devis failed", { devisId, error: fetchErr.message });
    return;
  }

  const newTtc = devis.total_ttc_centimes + additionalTtc;
  const newHt = Math.round(newTtc / (1 + tauxTva));
  const newTva = newTtc - newHt;

  const { error: updateErr } = await supabase.from("devis").update({
    total_ht_centimes: newHt,
    total_tva_centimes: newTva,
    total_ttc_centimes: newTtc,
  }).eq("id", devisId);

  if (updateErr) {
    log.error("addUpsellOptionsToDevis: update totals failed", { devisId, error: updateErr.message });
  }

  log.info("addUpsellOptionsToDevis: options added", { devisId, options: addedOptionIds, additionalTtc, newTtc });
}

function buildVehicleOnlyText(vehicle) {
  const nameParts = [vehicle.make, vehicle.model, vehicle.trim].filter(Boolean);
  const name = nameParts.length ? nameParts.join(" ") : "Véhicule";

  const detailParts = [];
  if (vehicle.fuel) detailParts.push(vehicle.fuel);
  if (vehicle.engine_cc) detailParts.push(`${vehicle.engine_cc}cc`);
  if (vehicle.power_hp) detailParts.push(`${vehicle.power_hp}ch`);
  else if (vehicle.power_kw) detailParts.push(`${vehicle.power_kw}kW`);
  const details = detailParts.length ? ` (${detailParts.join(" | ")})` : "";

  const yearTxt = vehicle.year ? ` - ${vehicle.year}` : "";

  return (
    `Véhicule détecté :\n` +
    `🚘 ${name}${details}${yearTxt}\n` +
    `🔧 Code moteur : ${vehicle.engine_code || "Non disponible"}\n\n` +
    `Est-ce bien votre véhicule ?`
  );
}

// ====== Unified prestation flow handler (branches 1-7) ======
// Intents handled: REPROG, E85, FAP, EGR, ADBLUE, DIAG, AUTRES
// State machine: WAITING_PLATE → WAITING_VEHICLE_CONFIRM → WAITING_QUOTE_CONFIRM → WAITING_POST_QUOTE_CHOICE → done
//                              ↘ WAITING_VEHICLE_MANUAL ↗   ↘ WAITING_COORDINATES → done
const PRESTATION_INTENTS = new Set(["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES"]);

// FIX #3 : Intents qui nécessitent obligatoirement un devis personnalisé
// (pas de calcul de prix automatique possible)
const MANUAL_QUOTE_INTENTS = new Set(["EGR", "AUTRES"]);

// Stages reprog qui nécessitent un devis personnalisé (pas de prix direct)
const CUSTOM_QUOTE_STAGES = new Set(["stage2", "stage3", "stage4"]);

// ====== Sous-prestations Diagnostic (prix fixes TTC) ======
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

// ====== Shared stage selection builder (used by REPROG and E85_DIESEL_REFUSED) ======
const STAGE1_PRICE_LABEL = `${STAGE1_FIXED_PRICE_CENTS / 100}€`;
const STAGE1_PRICE_LABEL_TTC = `${STAGE1_FIXED_PRICE_CENTS / 100}€ TTC`;

async function buildAndSendStageSelection(fromWa, vehicle, plate, stages, intentOverride) {
  const maxDisplay = 4;
  const displayStages = stages.slice(0, maxDisplay);

  const firstRow = displayStages[0];
  const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
  const motorDesc = firstRow.moteur_slug
    ? firstRow.moteur_slug.replace(/-/g, " ").toUpperCase() + ` ${firstRow.puissance_origine}ch | ${firstRow.couple_origine} Nm`
    : `${vehicle.power_hp || "?"}ch`;

  let stageLines = "";
  displayStages.forEach((s, i) => {
    const stageLabel = formatStageLabel(s.stage);
    const prixTxt = CUSTOM_QUOTE_STAGES.has(s.stage)
      ? "Sur devis personnalisé"
      : (s.stage === "stage1" ? STAGE1_PRICE_LABEL_TTC : (typeof s.prix_centimes === "number" ? `${(s.prix_centimes / 100).toFixed(0)}€ TTC` : "Sur devis personnalisé"));
    stageLines +=
      `\n*${i + 1})* ${stageLabel} — ${prixTxt}\n` +
      `   ⚡ Puissance : ${s.puissance_origine} → ${s.puissance_apres} ch (+${s.gain_puissance} ch)\n` +
      `   🔧 Couple : ${s.couple_origine} → ${s.couple_apres} Nm (+${s.gain_couple} Nm)\n`;
  });

  const stageButtons = displayStages.slice(0, 3).map((s, i) => {
    const btnLabel = formatStageLabel(s.stage);
    const btnPrix = CUSTOM_QUOTE_STAGES.has(s.stage)
      ? "Devis"
      : (s.stage === "stage1" ? STAGE1_PRICE_LABEL : (typeof s.prix_centimes === "number" ? `${(s.prix_centimes / 100).toFixed(0)}€` : "Devis"));
    return { id: `stage_choice_${i + 1}`, title: `${btnLabel} — ${btnPrix}`.slice(0, 20) };
  });

  if (stageButtons.length < 3) {
    stageButtons.push({ id: "btn_back_menu", title: "🏠 Menu" });
  }

  let msg =
    `🏎️ *Reprogrammation moteur — ${vehicleName}*\n` +
    `Moteur : ${motorDesc}\n\n` +
    `Stages disponibles :\n` +
    stageLines;

  if (displayStages.length > 3) {
    msg += `\nPour d'autres options, tapez le numro du stage.`;
  }

  if (msg.length > 4000) {
    log.warn("Stage message too long, truncating", { len: msg.length, stages: displayStages.length });
    msg = msg.slice(0, 3950) + (displayStages.length > 3 ? `\n\n… Pour d'autres options, tapez le numro.` : "");
  }

  const intent = intentOverride || "REPROG";
  await setConversationState(fromWa, "WAITING_STAGE_CHOICE", intent, { plate, vehicle, stages: displayStages });
  // Send gains comparison chart (best effort, non-blocking)
  const gainsChartUrl = buildGainsChartUrl(displayStages, vehicleName);
  if (gainsChartUrl) {
    sendWhatsAppImage(fromWa, gainsChartUrl, `📊 ${vehicleName} — Comparatif des stages`).catch(chartErr => {
      log.debug("Gains chart send failed (non-blocking)", { error: String(chartErr?.message || chartErr) });
    });
  }
  await sendWhatsAppInteractiveButtons(fromWa, msg, stageButtons);
  return displayStages;
}

async function handlePrestationFlow(fromWa, text, rawMsg) {
  const convState = await getConversationState(fromWa);
  const intent = convState?.intent;
  const buttonId = extractInteractiveId(rawMsg);

  // --- Cas 1 : Pas d'état en cours → détecter l'intent ---
  if (!convState || !convState.state) {
    const detected = detectIntent(text);
    if (detected && PRESTATION_INTENTS.has(detected)) {
      const label = intentToLabel(detected);

      // DIAG → sous-menu avec 3 options à prix fixe
      if (detected === "DIAG") {
        await setConversationState(fromWa, "DIAG_CHOOSE", "DIAG", {});
        await sendWhatsAppList(
          fromWa,
          "🔍 Diagnostic complet\n\nChoisissez le type de diagnostic souhaité :",
          "🔍 Voir les options",
          [
            {
              title: "Nos diagnostics",
              rows: DIAG_OPTIONS.map(opt => ({
                id: opt.id,
                title: opt.title,
                description: `${opt.description} — ${(opt.priceTtcCents / 100).toFixed(0)}€ TTC`,
              })),
            },
          ]
        );
        log.info("DIAG flow → sous-menu affiché", { wa_id: fromWa });
        return true;
      }

      // FIX #3 : EGR, AUTRES → devis personnalisé direct (pas de lookup véhicule inutile)
      if (MANUAL_QUOTE_INTENTS.has(detected)) {
        await setConversationState(fromWa, "WAITING_CONTACT_MANUAL", detected, {});
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `${label} ✅\n\n` +
          `Cette prestation nécessite une étude personnalisée.\n` +
          `Veuillez envoyer votre email pour être recontacté (ex: prenom@mail.com).`,
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        log.info("Prestation flow → devis personnalisé direct", { wa_id: fromWa, intent: detected });
        return true;
      }

      await setConversationState(fromWa, "WAITING_PLATE", detected, {});
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `${label} ✅\nVeuillez envoyer votre plaque d'immatriculation (ex: AA 123 BB).`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Prestation flow started", { wa_id: fromWa, intent: detected });
      return true;
    }
    return false;
  }

  // Si l'intent en cours n'est pas une prestation, ne pas gérer
  if (!PRESTATION_INTENTS.has(intent)) return false;

  const prestationCode = intentToPrestationCode(intent);
  const label = intentToLabel(intent);

  // --- Cas spécial : E85_DIESEL_REFUSED (le client a un diesel et ne peut pas faire E85) ---
  if (convState.state === "E85_DIESEL_REFUSED") {
    if (buttonId === "e85_diesel_reprog") {
      // Basculer vers le flow REPROG avec le même véhicule déjà identifié
      const stateData = convState.data || {};
      await clearConversationState(fromWa);
      log.info("E85 diesel → bascule vers REPROG", { wa_id: fromWa });
      return handlePrestationFlow(fromWa, "1", rawMsg);
    }
    if (buttonId === "e85_diesel_menu" || buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }
    // Sinon, tenter la détection d'intent (si l'utilisateur tape autre chose)
    const detected = detectIntent(text);
    if (detected) {
      await clearConversationState(fromWa);
      const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
      return handlePrestationFlow(fromWa, menuMap[detected] || text, rawMsg);
    }
    // Réafficher les boutons
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Souhaitez-vous basculer sur une reprogrammation moteur ou revenir au menu principal ?`,
      [
        { id: "e85_diesel_reprog", title: "🏎️ Reprog moteur" },
        { id: "e85_diesel_menu", title: "🏠 Menu principal" },
      ]
    );
    return true;
  }

  // --- Cas 2 : WAITING_PLATE ---
  if (convState.state === "WAITING_PLATE") {
    const { valid, plate } = validatePlate(text);

    if (!valid) {
      // Vérifier si l'utilisateur change d'avis ou pose une question (pas une plaque)
      const t = String(text || "").trim().toLowerCase();
      const newIntent = detectIntent(t);

      // Changement d'intent → relancer le bon flow
      if (newIntent && newIntent !== intent) {
        await clearConversationState(fromWa);
        log.info("WAITING_PLATE → changement d'intent", { wa_id: fromWa, from: intent, to: newIntent });
        const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
        return handlePrestationFlow(fromWa, menuMap[newIntent] || t, rawMsg);
      }

      // Message long (>10 chars) qui ne ressemble pas à une plaque → tenter le LLM
      if (t.length > 10) {
        try {
          const llmResult = await askLLM(text, fromWa);
          if (llmResult) {
            if (llmResult.type === "intent" && llmResult.intent) {
              await clearConversationState(fromWa);
              const menuMap2 = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
              const mapped = menuMap2[llmResult.intent];
              if (mapped) {
                log.info("WAITING_PLATE → LLM intent redirect", { wa_id: fromWa, intent: llmResult.intent });
                return handlePrestationFlow(fromWa, mapped, rawMsg);
              }
            }
            if (llmResult.type === "answer" && llmResult.message) {
              log.info("WAITING_PLATE → LLM answer", { wa_id: fromWa, msgLen: llmResult.message.length });
              await sendWhatsAppInteractiveButtons(fromWa, llmResult.message, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
              return true;
            }
          }
        } catch (llmErr) {
          log.warn("WAITING_PLATE LLM fallback error", { error: String(llmErr?.message || llmErr) });
        }
      }

      await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas reconnu la plaque 😅\nEnvoie-la au format AA 123 BB (avec ou sans tirets).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    try {
      const vehicle = await lookupVehicleFromPlate(plate);
      await setConversationState(fromWa, "WAITING_VEHICLE_CONFIRM", intent, { plate, vehicle });
      // Send vehicle image (best effort, don't block confirmation)
      getVehicleImageUrl(vehicle).then(vehicleImgUrl => {
        if (vehicleImgUrl) {
          sendWhatsAppImage(fromWa, vehicleImgUrl, `🚘 ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}${vehicle.year ? ` (${vehicle.year})` : ""}`).catch(imgErr => {
            log.debug("Vehicle image send failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
          });
        }
      }).catch(e => log.debug("Vehicle image URL lookup failed", { error: String(e?.message || e) }));
      await sendWhatsAppInteractiveButtons(fromWa, buildVehicleOnlyText(vehicle), [
        { id: "confirm_vehicle_yes", title: "✅ Oui, c'est bon" },
        { id: "confirm_vehicle_no", title: "❌ Non" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      return true;
    } catch (err) {
      const emsg = String(err?.message || err || "");
      log.error("Erreur lookup véhicule", { wa_id: fromWa, intent, error: emsg });

      if (emsg.includes("VEHICLE_NOT_FOUND")) {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas trouvé ce véhicule 😕\nVeuillez vérifier la plaque et la renvoyer (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      } else if (emsg.includes("OUT_OF_CREDIT") || emsg.includes("IMMATRICULATION_API_FAILED") || emsg.includes("NOT_CONFIGURED") || emsg.includes("INVALID_TOKEN")) {
        await setConversationState(fromWa, "WAITING_VEHICLE_MANUAL", intent, { plate });
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'arrive pas à identifier le véhicule automatiquement 😕\nVeuillez indiquer : Marque / Modèle / Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      } else {
        await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas pu récupérer les infos du véhicule 😕\nVeuillez vérifier votre plaque et réessayer (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      }
      return true;
    }
  }

  // --- Cas 2a : WAITING_VEHICLE_CONFIRM (confirmation du véhicule avant le prix) ---
  if (convState.state === "WAITING_VEHICLE_CONFIRM") {
    const t = String(text || "").trim().toLowerCase();
    const stateData = convState.data || {};
    const plate = stateData.plate;
    const vehicle = stateData.vehicle || {};

    if (t === "oui" || t === "1" || t === "yes" || t === "o" || buttonId === "confirm_vehicle_yes") {
      // --- E85: bloquer si véhicule diesel ---
      if (intent === "E85") {
        const fuelLower = (vehicle.fuel || "").toLowerCase();
        const isDiesel = /diesel|gazole|go\b/i.test(fuelLower);

        if (isDiesel) {
          await setConversationState(fromWa, "E85_DIESEL_REFUSED", "E85", { plate, vehicle });
          await sendWhatsAppInteractiveButtons(
            fromWa,
            `❌ Conversion E85 non compatible\n\n` +
            `Votre véhicule est un *${vehicle.make} ${vehicle.model}* motorisation *${vehicle.fuel}*.\n\n` +
            `La conversion E85 (bioéthanol) est réservée uniquement aux véhicules *essence*. ` +
            `Les moteurs diesel ne sont pas compatibles avec le bioéthanol.\n\n` +
            `💡 En revanche, nous pouvons vous proposer une *reprogrammation moteur* pour optimiser les performances de votre diesel !`,
            [
              { id: "e85_diesel_reprog", title: "🏎️ Reprog moteur" },
              { id: "e85_diesel_menu", title: "🏠 Menu principal" },
            ]
          );
          log.info("E85 refusé: véhicule diesel", { wa_id: fromWa, fuel: vehicle.fuel, plate });
          return true;
        }
      }

      // --- REPROG: lookup Shiftech stages first ---
      if (intent === "REPROG") {
        try {
          const stages = await lookupReprogStages(vehicle);
          if (stages.length > 0) {
            const displayStages = await buildAndSendStageSelection(fromWa, vehicle, plate, stages, intent);
            log.info("Reprog stages trouvés", { wa_id: fromWa, count: displayStages.length, total: stages.length, marque: slugify(vehicle.make) });
            return true;
          }
        } catch (err) {
          log.error("lookupReprogStages failed, fallback computeReprogPrice", { wa_id: fromWa, error: String(err?.message || err) });
        }
      }

      // Véhicule confirmé → calculer le prix (fallback ou non-REPROG)
      let priceCents;
      if (intent === "REPROG") {
        priceCents = computeReprogPrice(vehicle);
      } else if (intent === "E85") {
        priceCents = computeE85Price(vehicle);
      } else if (intent === "ADBLUE") {
        priceCents = computeAdbluePrice(vehicle);
      } else if (intent === "FAP") {
        priceCents = computeFapPrice(vehicle);
      } else {
        const tarif = await getPrestationTarif(prestationCode);
        priceCents = tarif?.prix_base_centimes || null;
      }

      // Prix null → devis personnalisé → collecte contact
      if (priceCents === null) {
        await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle });
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `Prestation : ${label}\n` +
          `Prix : Sur devis personnalisé\n\n` +
          `Votre véhicule semble nécessiter une attention particulière 🔍\n` +
          `Pas d'inquiétude, notre équipe va prendre en charge votre demande personnellement.\n\n` +
          `Merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
          [{ id: "btn_back_menu", title: "🏠 Menu" }]
        );
        log.info("Prix null → collecte contact", { wa_id: fromWa, intent, plate });
        return true;
      }

      // Créer le devis immédiatement
      try {
        const isTtc = TTC_INTENTS.has(intent);
        const devisRow = await createDevis({
          prestationCode,
          plate,
          waId: fromWa,
          vehicleYear: vehicle?.year || null,
          priceCentsOverride: priceCents,
          priceIsTtc: isTtc,
        });
        const devisId = devisRow?.id ?? "N/A";
        const htTxt = typeof devisRow?.total_ht_centimes === "number"
          ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€`
          : "(non dispo)";
        const ttcTxt = typeof devisRow?.total_ttc_centimes === "number"
          ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€`
          : "(non dispo)";

        // Add STAGE 1 for REPROG
        const displayLabel = intent === "REPROG" ? `${label} — STAGE 1` : label;

        await setConversationState(fromWa, "WAITING_QUOTE_CONFIRM", intent, {
          plate, vehicle, priceCents, devisId, htTxt, ttcTxt, prestationLabel: displayLabel,
        });

        // Send premium prestation card (best effort, non-blocking) for E85/FAP/ADBLUE
        if (intent === "E85" || intent === "FAP" || intent === "ADBLUE") {
          const cardUrl = buildPrestationCardUrl({ vehicle, intent, prestationLabel: displayLabel, priceTtc: ttcTxt });
          if (cardUrl) {
            sendWhatsAppImage(fromWa, cardUrl, `📋 Fiche technique — ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}`).catch(cardErr => {
              log.debug("Prestation card send failed (non-blocking)", { error: String(cardErr?.message || cardErr) });
            });
          }
        }

        await sendWhatsAppInteractiveButtons(fromWa, `✅ Devis généré\n` +
          `Référence : DEV-${devisId}\n` +
          `Prestation : ${displayLabel}\n` +
          `Durée d'intervention : 2h-4h\n` +
          `Total HT : ${htTxt}\n` +
          `Total TTC : ${ttcTxt}\n\n` +
          `Est-ce que ce devis vous convient ?`, [
          { id: "confirm_quote_yes", title: "✅ Oui" },
          { id: "confirm_quote_no", title: "❌ Non" },
          { id: "btn_back_menu", title: "🏠 Menu" },
        ]);

        // Notification garage
        if (devisRow.isNew) {
          broadcastDashboardEvent("new_devis", { devisId, plate: plate || "", wa_id: fromWa, prestation: label, ttc: ttcTxt });
          await notifyGarage(
            `📋 NOUVEAU DEVIS\n` +
            `Réf : DEV-${devisId}\n` +
            `Prestation : ${label}\n` +
            `Plaque : ${plate || "N/A"}\n` +
            `Client : ${fromWa}\n` +
            `HT : ${htTxt} | TTC : ${ttcTxt}\n` +
            `Date : ${new Date().toISOString()}`
          );
        }

        // PDF sent later, after collecting customer info (see WAITING_DEVIS_CONTACT)
        log.info("Devis créé après confirmation véhicule", { wa_id: fromWa, intent, devisId });
      } catch (err) {
        const emsg = String(err?.message || err || "");
        log.error("Erreur création devis", { wa_id: fromWa, intent, error: emsg });

        if (emsg.includes("NO_TARIF")) {
          await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle });
          await sendWhatsAppInteractiveButtons(
            fromWa,
            `Prestation : ${label}\n` +
            `Prix : Sur devis personnalisé\n\n` +
            `Merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
            [{ id: "btn_back_menu", title: "🏠 Menu" }]
          );
        } else {
          await sendWhatsAppInteractiveButtons(fromWa, "Désolé, j'ai eu un souci pour générer le devis 😕\nVeuillez réessayer dans quelques instants.", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
        }
      }
      return true;
    }

    if (t === "non" || t === "2" || t === "no" || t === "n" || t === "annuler" || buttonId === "confirm_vehicle_no") {
      // Véhicule refusé → redemander la plaque
      await setConversationState(fromWa, "WAITING_PLATE", intent, {});
      await sendWhatsAppInteractiveButtons(fromWa, "Pas de souci ! Veuillez renvoyer votre plaque d'immatriculation (format AA 123 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    await sendWhatsAppInteractiveButtons(fromWa, "Est-ce bien votre véhicule ? Répondez *oui* ou *non*.", [
      { id: "confirm_vehicle_yes", title: "✅ Oui, c'est bon" },
      { id: "confirm_vehicle_no", title: "❌ Non" },
    ]);
    return true;
  }


  // --- WAITING_STAGE_CHOICE (sélection du stage reprog) ---
  if (convState.state === "WAITING_STAGE_CHOICE") {
    const stateData = convState.data || {};
    const plate = stateData.plate;
    const vehicle = stateData.vehicle || {};
    const stages = stateData.stages || [];

    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    // Parse stage selection from button or text
    let selectedIdx = -1;
    if (buttonId && buttonId.startsWith("stage_choice_")) {
      selectedIdx = parseInt(buttonId.replace("stage_choice_", ""), 10) - 1;
    } else {
      const num = parseInt(String(text || "").trim(), 10);
      if (num >= 1 && num <= stages.length) selectedIdx = num - 1;
    }

    if (selectedIdx < 0 || selectedIdx >= stages.length) {
      await sendWhatsAppInteractiveButtons(fromWa, "Merci de choisir un des stages proposés.", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    const selectedStage = stages[selectedIdx];
    const stageLabel = formatStageLabel(selectedStage.stage);
    log.info("Stage selected", { wa_id: fromWa, stage: selectedStage.stage, idx: selectedIdx });

    const isE85Stage = /e85/i.test(selectedStage.stage);

    // Determine price
    let priceCents = null;
    if (selectedStage.stage === "stage1") {
      priceCents = STAGE1_FIXED_PRICE_CENTS;
    } else if (typeof selectedStage.prix_centimes === "number" && !CUSTOM_QUOTE_STAGES.has(selectedStage.stage)) {
      priceCents = selectedStage.prix_centimes;
    }

    // Custom quote → collect contact info
    if (priceCents === null) {
      await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle, stageLabel });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Prestation : Reprogrammation ${stageLabel}\n` +
        `Prix : Sur devis personnalisé\n\n` +
        `Ce stage nécessite une étude personnalisée \uD83D\uDD0D\n` +
        `Merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" }]
      );
      return true;
    }

    // Known price → create devis
    try {
      const isTtc = TTC_INTENTS.has(intent);
      const devisRow = await createDevis({
        prestationCode: intentToPrestationCode(intent),
        plate,
        waId: fromWa,
        vehicleYear: vehicle?.year || null,
        priceCentsOverride: priceCents,
        priceIsTtc: isTtc,
      });
      const devisId = devisRow?.id ?? "N/A";
      const htTxt = typeof devisRow?.total_ht_centimes === "number"
        ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}\u20AC`
        : "(non dispo)";
      const ttcTxt = typeof devisRow?.total_ttc_centimes === "number"
        ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}\u20AC`
        : "(non dispo)";

      const gainTxt = (!isE85Stage && selectedStage.gain_puissance)
        ? `\n\u26A1 +${selectedStage.gain_puissance}ch / +${selectedStage.gain_couple}Nm`
        : "";
      const stageGainTxtShort = (!isE85Stage && selectedStage.gain_puissance) ? `+${selectedStage.gain_puissance}ch / +${selectedStage.gain_couple}Nm` : null;

      await setConversationState(fromWa, "WAITING_QUOTE_CONFIRM", intent, {
        plate, vehicle, priceCents, devisId, htTxt, ttcTxt, stageLabel,
        prestationLabel: `Reprogrammation ${stageLabel}`,
        gainTxt: stageGainTxtShort,
      });

      // Send premium vehicle spec card (best effort, non-blocking)
      const cardUrl = buildVehicleCardUrl({ vehicle, stage: selectedStage, stageLabel, priceTtc: ttcTxt });
      if (cardUrl) {
        sendWhatsAppImage(fromWa, cardUrl, `📋 Fiche technique — ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}`).catch(cardErr => {
          log.debug("Vehicle card send failed (non-blocking)", { error: String(cardErr?.message || cardErr) });
        });
      }

      await sendWhatsAppInteractiveButtons(fromWa, `\u2705 Devis généré\n` +
        `Référence : DEV-${devisId}\n` +
        `Prestation : Reprogrammation ${stageLabel}${gainTxt}\n` +
        `Durée d'intervention : 2h-4h\n` +
        `Total HT : ${htTxt}\n` +
        `Total TTC : ${ttcTxt}\n\n` +
        `Est-ce que ce devis vous convient ?`, [
        { id: "confirm_quote_yes", title: "\u2705 Oui" },
        { id: "confirm_quote_no", title: "\u274C Non" },
        { id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" },
      ]);

      // Send PWA link for devis tracking (best effort, non-blocking)
      const waDigits = fromWa.replace(/\D/g, "");
      const clientPin = waDigits.slice(-4);
      const pwaUrl = `https://webhook.diagperf.com/app.html?wa=${encodeURIComponent(fromWa)}&pin=${clientPin}`;
      sendWhatsAppText(fromWa, `📱 Suivez vos devis en ligne :\n${pwaUrl}\n\n_Ajoutez cette page à votre écran d'accueil pour un accès rapide !_`).catch(e => {
        log.debug("PWA link send failed", { error: String(e?.message || e) });
      });

      if (devisRow.isNew) {
        broadcastDashboardEvent("new_devis", { devisId, plate: plate || "", wa_id: fromWa, prestation: `Reprogrammation ${stageLabel}`, ttc: ttcTxt });
        await notifyGarage(
          `\uD83D\uDCCB NOUVEAU DEVIS\n` +
          `Réf : DEV-${devisId}\n` +
          `Prestation : Reprogrammation ${stageLabel}\n` +
          `Plaque : ${plate || "N/A"}\n` +
          `Client : ${fromWa}\n` +
          `HT : ${htTxt} | TTC : ${ttcTxt}\n` +
          `Date : ${new Date().toISOString()}`
        );
      }

      // PDF sent later, after collecting customer info (see WAITING_DEVIS_CONTACT)
      log.info("Devis créé (stage choice)", { wa_id: fromWa, intent, devisId, stage: selectedStage.stage });
    } catch (err) {
      const emsg = String(err?.message || err || "");
      log.error("Erreur création devis (stage)", { wa_id: fromWa, error: emsg });

      if (emsg.includes("NO_TARIF")) {
        await setConversationState(fromWa, "WAITING_COORDINATES", intent, { plate, vehicle, stageLabel });
        await sendWhatsAppInteractiveButtons(
          fromWa,
          `Prestation : Reprogrammation ${stageLabel}\nPrix : Sur devis personnalisé\n\n` +
          `Merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
          [{ id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" }]
        );
      } else {
        await sendWhatsAppInteractiveButtons(fromWa, "Désolé, j'ai eu un souci pour générer le devis \uD83D\uDE15\nVeuillez réessayer dans quelques instants.", [{ id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" }]);
      }
    }
    return true;
  }

  // --- WAITING_QUOTE_CONFIRM (confirmation du devis) ---
  if (convState.state === "WAITING_QUOTE_CONFIRM") {
    const t = String(text || "").trim().toLowerCase();
    const stateData = convState.data || {};
    const plate = stateData.plate;
    const vehicle = stateData.vehicle || {};

    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    if (t === "oui" || t === "1" || t === "yes" || t === "o" || buttonId === "confirm_quote_yes") {
      // Update devis status to confirmed (sent) in Supabase
      if (stateData.devisId) {
        supabase.from("devis").update({ statut: "sent" }).eq("id", stateData.devisId).then(({ error }) => {
          if (error) log.error("Failed to update devis status", { devisId: stateData.devisId, error: String(error.message) });
          else {
            log.info("Devis confirmed by client", { devisId: stateData.devisId, wa_id: fromWa });
            broadcastDashboardEvent("devis_confirmed", { devisId: stateData.devisId, wa_id: fromWa, plate: stateData.plate || "" });
          }
        });
      }

      // Check for upsell options
      const upsellOptions = UPSELL_OPTIONS[intent] || [];
      if (upsellOptions.length > 0) {
        const firstOpt = upsellOptions[0];
        await setConversationState(fromWa, "WAITING_UPSELL", intent, {
          ...stateData,
          upsellType: intent,
          upsellStep: 0,
          addedOptions: [],
          baseTtcCents: stateData.priceCents,
          devisRef: `DEV-${stateData.devisId}`,
        });
        await sendWhatsAppInteractiveButtons(fromWa, firstOpt.message, [
          { id: "upsell_add", title: firstOpt.addBtnLabel },
          { id: "upsell_skip", title: firstOpt.skipBtnLabel },
          { id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" },
        ]);
        log.info("Quote confirmed → upsell started", { wa_id: fromWa, intent, upsellType: intent });
        return true;
      }

      // No upsell → ask for customer contact info, then send PDF, then post-quote choice
      await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, stateData);
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Parfait ! \uD83C\uDF89\n\nPour finaliser et recevoir votre devis en PDF, merci d'envoyer vos coordonnées :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" }]
      );
      log.info("Quote confirmed → asking for customer contact info", { wa_id: fromWa, intent });
      return true;
    }

    if (t === "non" || t === "2" || t === "no" || t === "n" || t === "annuler" || buttonId === "confirm_quote_no") {
      // Update devis status to refused in Supabase
      if (stateData.devisId) {
        supabase.from("devis").update({ statut: "refused" }).eq("id", stateData.devisId).then(({ error }) => {
          if (error) log.error("Failed to update devis status", { devisId: stateData.devisId, error: String(error.message) });
          else {
            log.info("Devis refused by client", { devisId: stateData.devisId, wa_id: fromWa });
            broadcastDashboardEvent("devis_refused", { devisId: stateData.devisId, wa_id: fromWa, plate: stateData.plate || "" });
          }
        });
      }

      await setConversationState(fromWa, "WAITING_POST_QUOTE_CHOICE", intent, { plate, vehicle });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        "Nous comprenons. Comment pouvons-nous vous aider ?",
        [
          { id: "post_quote_technicien", title: "Contacter technicien" },
          { id: "post_quote_accueil", title: "Retour accueil" },
        ]
      );
      return true;
    }

    await sendWhatsAppInteractiveButtons(fromWa, "Répondez par *oui* si le devis vous convient, ou *non* dans le cas contraire.", [
      { id: "confirm_quote_yes", title: "\u2705 Oui" },
      { id: "confirm_quote_no", title: "\u274C Non" },
      { id: "btn_back_menu", title: "\uD83C\uDFE0 Menu" },
    ]);
    return true;
  }

  // --- WAITING_UPSELL (propositions d'options supplémentaires FAP/ADBLUE) ---
  if (convState.state === "WAITING_UPSELL") {
    const stateData = convState.data || {};
    const upsellType = stateData.upsellType || intent;
    const options = UPSELL_OPTIONS[upsellType] || [];
    const step = stateData.upsellStep || 0;
    const addedOptions = [...(stateData.addedOptions || [])];

    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    if (buttonId === "upsell_add") {
      const currentOpt = options[step];
      if (currentOpt) addedOptions.push(currentOpt.id);
      log.info("Upsell accepted", { wa_id: fromWa, option: currentOpt?.id, step });
    } else if (buttonId === "upsell_skip") {
      log.info("Upsell skipped", { wa_id: fromWa, option: options[step]?.id, step });
    } else {
      // Unknown response → resend current proposal
      const currentOpt = options[step];
      if (currentOpt) {
        await sendWhatsAppInteractiveButtons(fromWa, currentOpt.message, [
          { id: "upsell_add", title: currentOpt.addBtnLabel },
          { id: "upsell_skip", title: currentOpt.skipBtnLabel },
          { id: "btn_back_menu", title: "🏠 Menu" },
        ]);
      }
      return true;
    }

    const nextStep = step + 1;

    if (nextStep < options.length) {
      // Send next upsell proposal
      const nextOpt = options[nextStep];
      const newStateData = { ...stateData, upsellStep: nextStep, addedOptions };
      await setConversationState(fromWa, "WAITING_UPSELL", intent, newStateData);
      await sendWhatsAppInteractiveButtons(fromWa, nextOpt.message, [
        { id: "upsell_add", title: nextOpt.addBtnLabel },
        { id: "upsell_skip", title: nextOpt.skipBtnLabel },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      log.info("Upsell next proposal", { wa_id: fromWa, intent, step: nextStep });
    } else {
      // All proposals done → show recap
      const baseLabel = intentToLabel(upsellType);
      const baseTtcCents = stateData.priceCents;
      const baseTtcTxt = typeof baseTtcCents === "number" ? `${(baseTtcCents / 100).toFixed(0)}€ TTC` : (stateData.ttcTxt || "N/A");
      const devisId = stateData.devisId || "N/A";
      const devisRef = `DEV-${devisId}`;

      let lines = `✅ ${baseLabel} : ${baseTtcTxt}\n`;
      let totalAddedTtc = 0;

      for (const opt of options) {
        if (addedOptions.includes(opt.id)) {
          lines += `✅ ${opt.label} : +${(opt.priceCents / 100).toFixed(0)}€ TTC\n`;
          totalAddedTtc += opt.priceCents;
        } else {
          lines += `❌ ${opt.label} : non retenu\n`;
        }
      }

      const tauxTva = 0.20;
      const newTtc = (typeof baseTtcCents === "number" ? baseTtcCents : 0) + totalAddedTtc;
      const newHt = Math.round(newTtc / (1 + tauxTva));
      const htTxt = `${(newHt / 100).toFixed(2)}€`;
      const ttcTxt = `${(newTtc / 100).toFixed(0)}€`;

      const msg =
        `📋 *Récapitulatif de votre devis :*\n\n` +
        `Référence : ${devisRef}\n` +
        lines +
        `\nDurée d'intervention : 2h-4h\n` +
        `Total HT : ${htTxt}\n` +
        `Total TTC : ${ttcTxt}\n\n` +
        `Ce devis vous convient-il ?`;

      await setConversationState(fromWa, "WAITING_UPSELL_CONFIRM", intent, {
        ...stateData, addedOptions, newTtcCents: newTtc, newHtCents: newHt, newHtTxt: htTxt, newTtcTxt: ttcTxt,
      });

      await sendWhatsAppInteractiveButtons(fromWa, msg, [
        { id: "upsell_confirm_yes", title: "✅ Confirmer" },
        { id: "upsell_confirm_no", title: "❌ Annuler" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      log.info("Upsell recap shown", { wa_id: fromWa, intent, addedOptions, totalAddedTtc, newTtc });
    }

    return true;
  }

  // --- WAITING_DEVIS_CONTACT (collecte coordonnées client pour PDF du devis) ---
  if (convState.state === "WAITING_DEVIS_CONTACT") {
    const stateData = convState.data || {};

    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    // Parse "Nom Prénom email@domaine.com"
    const raw = String(text || "").trim();
    const words = raw.split(/[\s\n]+/);
    const emailWord = words.find(w => w.includes("@"));
    const nameParts = words.filter(w => !w.includes("@"));
    const customerName = nameParts.join(" ").trim();
    const customerEmail = (emailWord || "").trim().toLowerCase();

    if (!customerName || customerName.length < 2) {
      await sendWhatsAppInteractiveButtons(
        fromWa,
        "Je n'ai pas pu identifier votre nom 😅\nMerci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com",
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      return true;
    }

    if (!customerEmail || !validateEmail(customerEmail)) {
      await sendWhatsAppInteractiveButtons(
        fromWa,
        "L'adresse email ne semble pas valide 😕\nMerci de réessayer au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com",
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      return true;
    }

    // Fetch latest devis row (in case upsell options updated the totals)
    let devisRow = null;
    if (stateData.devisId) {
      try {
        const { data } = await supabase
          .from("devis")
          .select("id, total_ht_centimes, total_ttc_centimes")
          .eq("id", stateData.devisId)
          .single();
        devisRow = data;
      } catch (e) {
        log.warn("WAITING_DEVIS_CONTACT: devis fetch failed", { error: String(e?.message || e) });
      }
    }

    // Send PDF with customer info (best effort)
    if (stateData.devisId) {
      sendQuotePdf(fromWa, {
        devisId: stateData.devisId,
        plate: stateData.plate,
        vehicle: stateData.vehicle,
        prestationLabel: stateData.prestationLabel || intentToLabel(intent),
        stageLabel: stateData.stageLabel,
        gainTxt: stateData.gainTxt,
        devisRow,
        customerName,
        customerEmail,
        customerPhone: fromWa,
      }).catch(() => {});
    }

    // Transition to post-quote choice, passing customer info so RDV/technicien steps can reuse them
    const nextData = { ...stateData, customerName, customerEmail };
    await setConversationState(fromWa, "WAITING_POST_QUOTE_CHOICE", intent, nextData);
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci ${customerName} ! 🙏\n\nVotre devis PDF a été envoyé. Que souhaitez-vous faire ensuite ?`,
      [
        { id: "post_quote_rdv", title: "Prendre RDV" },
        { id: "post_quote_technicien", title: "Question technicien" },
        { id: "post_quote_accueil", title: "Retour accueil" },
      ]
    );
    log.info("Customer contact collected → PDF sent → post-quote choice", { wa_id: fromWa, intent, customerName });
    return true;
  }

  // --- WAITING_UPSELL_CONFIRM (confirmation récapitulatif upsell) ---
  if (convState.state === "WAITING_UPSELL_CONFIRM") {
    const t = String(text || "").trim().toLowerCase();
    const stateData = convState.data || {};

    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    if (t === "oui" || t === "confirmer" || buttonId === "upsell_confirm_yes") {
      // Update devis in Supabase with added options
      const addedOptions = stateData.addedOptions || [];
      if (addedOptions.length > 0) {
        try {
          await addUpsellOptionsToDevis(stateData.devisId, addedOptions, stateData.upsellType || intent);
        } catch (err) {
          log.error("Failed to add upsell options to devis", { wa_id: fromWa, error: String(err?.message || err) });
        }
      }

      // Update stateData with new totals for downstream use
      const updatedData = {
        ...stateData,
        htTxt: stateData.newHtTxt || stateData.htTxt,
        ttcTxt: stateData.newTtcTxt || stateData.ttcTxt,
      };

      // Ask for customer contact info before sending PDF + going to post-quote choice
      await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, updatedData);
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Parfait ! 🎉\n\nPour finaliser et recevoir votre devis en PDF, merci d'envoyer vos coordonnées :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Upsell confirmed → asking for customer contact info", { wa_id: fromWa, intent, addedOptions: stateData.addedOptions });
      return true;
    }

    if (t === "non" || t === "annuler" || buttonId === "upsell_confirm_no") {
      // Même sans upsell, on demande les coordonnées pour envoyer le PDF du devis de base
      await setConversationState(fromWa, "WAITING_DEVIS_CONTACT", intent, stateData);
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Pas de souci ! 🙂\n\nPour finaliser et recevoir votre devis en PDF, merci d'envoyer vos coordonnées :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      return true;
    }

    // Fallback
    await sendWhatsAppInteractiveButtons(fromWa, "Merci de choisir une des options proposées.", [
      { id: "upsell_confirm_yes", title: "✅ Confirmer" },
      { id: "upsell_confirm_no", title: "❌ Annuler" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ]);
    return true;
  }

  // --- WAITING_POST_QUOTE_CHOICE (choix après devis) ---
  if (convState.state === "WAITING_POST_QUOTE_CHOICE") {
    const btnId = extractInteractiveId(rawMsg);
    const t = String(text || "").trim().toLowerCase();

    if (btnId === "post_quote_rdv" || t === "prendre rdv" || t === "rendez-vous" || t === "rdv") {
      const stateData = convState.data || {};
      await setConversationState(fromWa, "AWAITING_RDV_COORDINATES", intent, { ...stateData, contactReason: "rdv" });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Excellent choix ! 🎉 Pour finaliser votre prise en charge, merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Post-quote choice: RDV → collecte coordonnées", { wa_id: fromWa, intent });
      return true;
    }

    if (btnId === "post_quote_technicien" || t === "question technicien" || t === "contacter technicien" || t === "technicien") {
      const stateData = convState.data || {};
      await setConversationState(fromWa, "AWAITING_RDV_COORDINATES", intent, { ...stateData, contactReason: "technicien" });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Très bien ! Pour que notre technicien puisse vous recontacter, merci d'envoyer vos coordonnées au format :\n*Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Post-quote choice: technicien → collecte coordonnées", { wa_id: fromWa, intent });
      return true;
    }

    if (btnId === "post_quote_accueil" || t === "retour accueil" || t === "accueil" || t === "menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      log.info("Post-quote choice: retour accueil", { wa_id: fromWa, intent });
      return true;
    }

    // Fallback si le bouton n'est pas reconnu
    await sendWhatsAppInteractiveButtons(fromWa, "Merci de choisir une des options proposées.", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
    return true;
  }

  // --- AWAITING_RDV_COORDINATES (collecte Nom + Prénom + Email en une seule étape après devis) ---
  if (convState.state === "AWAITING_RDV_COORDINATES") {
    const parts = String(text || "").trim().split(/\s+/);
    const emailPart = parts.find(p => p.includes("@"));
    const email = validateEmail(emailPart);
    const nameParts2 = parts.filter(p => !p.includes("@"));
    const lastName = nameParts2[0] || "";
    const firstName = nameParts2.slice(1).join(" ") || "";

    if (!email || nameParts2.length < 2) {
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Je n'ai pas compris 😅\nVeuillez envoyer vos coordonnées au format : *Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      return true;
    }

    const stateData = convState.data || {};
    const plate = stateData.plate || "N/A";
    const vehicle = stateData.vehicle || {};
    const devisId = stateData.devisId || "N/A";
    const devisRef = `DEV-${devisId}`;
    const htTxt = stateData.htTxt || "N/A";
    const ttcTxt = stateData.ttcTxt || "N/A";
    const contactReason = stateData.contactReason || "rdv";

    const vNameParts = [vehicle.make, vehicle.model].filter(Boolean);
    const motorisation = [vehicle.fuel, vehicle.engine_cc ? `${vehicle.engine_cc}cc` : null, vehicle.power_hp ? `${vehicle.power_hp}ch` : null].filter(Boolean).join(" ");
    const yearTxt = vehicle.year ? `${vehicle.year}` : "";
    const vehicleDesc = [vNameParts.join(" "), motorisation, yearTxt].filter(Boolean).join(" — ");
    const engineCode = vehicle.engine_code || "Non disponible";

    // Build the prestation label: use stageLabel from Shiftech if available
    const emailPrestationLabel = stateData.stageLabel
      ? `Reprogrammation moteur — ${stateData.stageLabel}`
      : label;

    // Message WhatsApp de confirmation
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci pour votre confiance ! ✅\n\n` +
      `📧 Un récapitulatif de votre devis a été envoyé à ${email}.\n` +
      `Notre équipe vous recontactera dans les 24h pour répondre à vos questions.`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );

    // Envoi des 2 emails en parallèle (best effort)
    try {
      await Promise.all([
        sendRdvClientEmail({
          to: email,
          firstName,
          lastName,
          vehicleDesc,
          prestationLabel: emailPrestationLabel,
          devisRef,
          htTxt,
          ttcTxt,
          contactReason,
        }),
        sendRdvDiagperfEmail({
          firstName,
          lastName,
          clientEmail: email,
          waId: fromWa,
          vehicleDesc,
          engineCode,
          plate,
          prestationLabel: emailPrestationLabel,
          devisRef,
          htTxt,
          ttcTxt,
          contactReason,
        }),
      ]);
    } catch (err) {
      log.error("Erreur envoi emails RDV", { wa_id: fromWa, error: String(err?.message || err) });
    }

    // Proposer l'estimation de trajet (étape optionnelle)
    await setConversationState(fromWa, "AWAITING_CITY_FOR_TRAVEL", intent, {});
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `🗺️ Pour vous aider à planifier votre venue, indiquez votre *ville ou code postal* et je vous donnerai le temps de trajet estimé !`,
      [
        { id: "skip_travel", title: "⏭️ Passer" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]
    );
    log.info("RDV/technicien flow → travel estimate proposed", { wa_id: fromWa, intent, contactReason, email, devisRef });
    return true;
  }

  // --- AWAITING_CITY_FOR_TRAVEL (estimation trajet optionnelle) ---
  if (convState.state === "AWAITING_CITY_FOR_TRAVEL") {
    if (buttonId === "btn_back_menu") {
      await clearConversationState(fromWa);
      await sendMenuList(fromWa);
      return true;
    }

    // Skip → envoyer localisation + terminer
    if (buttonId === "skip_travel" || text.toLowerCase() === "passer") {
      sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => {
        log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) });
      });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `📍 Voici notre adresse ! À très bientôt chez DiagPerf 🚗`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      await clearConversationState(fromWa);
      log.info("Travel estimate skipped", { wa_id: fromWa });
      return true;
    }

    // Le client a envoyé une ville/code postal → estimer le trajet
    const travelMsg = await buildTravelEstimateMessage(text);
    if (travelMsg) {
      await sendWhatsAppInteractiveButtons(fromWa, travelMsg, [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      // Envoyer aussi la localisation GPS
      sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => {
        log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) });
      });
      log.info("Travel estimate sent", { wa_id: fromWa, query: text });
    } else {
      // Géocodage échoué → envoyer juste la localisation
      sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => {
        log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) });
      });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Je n'ai pas trouvé cette localisation 😅\nMais voici notre adresse ! À très bientôt chez DiagPerf 🚗`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      log.info("Travel estimate failed, location sent", { wa_id: fromWa, query: text });
    }

    await clearConversationState(fromWa);
    return true;
  }

  // ====== DIAG sub-flow ======

  // --- DIAG_CHOOSE : le client choisit un des 3 diagnostics ---
  if (convState.state === "DIAG_CHOOSE" && intent === "DIAG") {
    const listId = rawMsg?.interactive?.list_reply?.id || null;
    const selected = DIAG_OPTIONS.find(opt =>
      listId === opt.id || text === opt.id || text === opt.title || text.toLowerCase().includes(opt.title.toLowerCase())
    );

    if (!selected) {
      await sendWhatsAppList(
        fromWa,
        "Je n'ai pas compris votre choix 😅\nVeuillez sélectionner une option :",
        "🔍 Voir les options",
        [
          {
            title: "Nos diagnostics",
            rows: DIAG_OPTIONS.map(opt => ({
              id: opt.id,
              title: opt.title,
              description: `${opt.description} — ${(opt.priceTtcCents / 100).toFixed(0)}€ TTC`,
            })),
          },
        ]
      );
      return true;
    }

    await setConversationState(fromWa, "DIAG_DESCRIBE", "DIAG", {
      diagOption: selected.id,
      diagTitle: selected.title,
      diagDetail: selected.detail,
      diagPriceTtcCents: selected.priceTtcCents,
      diagDuration: selected.duration,
    });

    const priceTxt = `${(selected.priceTtcCents / 100).toFixed(0)}€ TTC`;
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `${selected.title} — ${priceTxt} (durée : ${selected.duration}) ✅\n\n` +
      `Pouvez-vous décrire votre problème en quelques lignes ? 📝\n` +
      `(ex: voyant moteur allumé, le véhicule ne démarre plus, bruit anormal...)`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );
    log.info("DIAG flow → option choisie, attente description", { wa_id: fromWa, option: selected.id });
    return true;
  }

  // --- DIAG_DESCRIBE : le client décrit son problème ---
  if (convState.state === "DIAG_DESCRIBE" && intent === "DIAG") {
    const description = String(text || "").trim();
    if (description.length < 5) {
      await sendWhatsAppText(
        fromWa,
        "Merci de décrire votre problème un peu plus en détail (au moins quelques mots) 🙏"
      );
      return true;
    }

    await setConversationState(fromWa, "DIAG_PLATE", "DIAG", {
      ...convState.data,
      problemDescription: description,
    });

    await sendWhatsAppText(
      fromWa,
      `Merci pour ces informations ! 📋\n\nVeuillez maintenant envoyer votre plaque d'immatriculation (format AA-123-CD).`
    );
    log.info("DIAG flow → description reçue, attente plaque", { wa_id: fromWa });
    return true;
  }

  // --- DIAG_PLATE : le client envoie sa plaque ---
  if (convState.state === "DIAG_PLATE" && intent === "DIAG") {
    const { valid, plate } = validatePlate(text);

    if (!valid) {
      await sendWhatsAppText(fromWa, "Je n'ai pas reconnu la plaque 😅\nEnvoie-la au format AA-123-CD.");
      return true;
    }

    // Appeler l'API véhicule (même logique que WAITING_PLATE des autres branches)
    let vehicle;
    try {
      vehicle = await lookupVehicleFromPlate(plate);
    } catch (err) {
      const emsg = String(err?.message || err || "");
      log.error("DIAG plate lookup error", { error: emsg, plate });

      if (emsg.includes("VEHICLE_NOT_FOUND")) {
        await sendWhatsAppText(fromWa, "Je n'ai pas trouvé ce véhicule 😕\nVérifie ta plaque et réessaie (format AA-123-CD).");
      } else if (emsg.includes("OUT_OF_CREDIT") || emsg.includes("IMMATRICULATION_API_FAILED") || emsg.includes("NOT_CONFIGURED") || emsg.includes("INVALID_TOKEN")) {
        await sendWhatsAppText(fromWa, "Je n'arrive pas à identifier le véhicule automatiquement 😕\nVeuillez indiquer : Marque / Modèle / Année (ex: Peugeot 308 2016).");
      } else {
        await sendWhatsAppText(fromWa, "Je n'ai pas pu récupérer les infos du véhicule 😕\nVeuillez vérifier votre plaque et réessayer (format AA-123-CD).");
      }
      return true;
    }

    const data = convState.data;
    const priceTxt = `${(data.diagPriceTtcCents / 100).toFixed(0)}€ TTC`;

    // Construire le texte d'identification véhicule (réutiliser le même format que les autres branches)
    const vehicleName = [vehicle.make, vehicle.model].filter(Boolean).join(" ");
    const detailParts = [];
    if (vehicle.fuel) detailParts.push(vehicle.fuel);
    if (vehicle.engine_cc) detailParts.push(`${vehicle.engine_cc}cc`);
    if (vehicle.power_hp) detailParts.push(`${vehicle.power_hp}ch`);
    else if (vehicle.power_kw) detailParts.push(`${vehicle.power_kw}kW`);
    const detailsTxt = detailParts.length ? ` (${detailParts.join(" | ")})` : "";
    const yearTxt = vehicle.year ? ` - ${vehicle.year}` : "";

    await setConversationState(fromWa, "DIAG_CONFIRM", "DIAG", {
      ...data,
      plate,
      vehicle: { make: vehicle.make, model: vehicle.model, trim: vehicle.trim, fuel: vehicle.fuel, engine_cc: vehicle.engine_cc, power_hp: vehicle.power_hp, power_kw: vehicle.power_kw, year: vehicle.year, engine_code: vehicle.engine_code },
    });

    // Send vehicle image (best effort, non-blocking)
    getVehicleImageUrl(vehicle).then(diagImgUrl => {
      if (diagImgUrl) {
        sendWhatsAppImage(fromWa, diagImgUrl, `🚘 ${vehicleName}${yearTxt}`).catch(imgErr => {
          log.debug("DIAG vehicle image failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
        });
      }
    }).catch(e => log.debug("DIAG vehicle image URL lookup failed", { error: String(e?.message || e) }));

    // Send premium DIAG prestation card (best effort, non-blocking)
    const diagCardUrl = buildPrestationCardUrl({
      vehicle: { ...vehicle, plate },
      intent: "DIAG",
      prestationLabel: data.diagTitle,
      priceTtc: priceTxt,
    });
    if (diagCardUrl) {
      sendWhatsAppImage(fromWa, diagCardUrl, `📋 Fiche technique — ${vehicleName}`).catch(cardErr => {
        log.debug("DIAG prestation card send failed (non-blocking)", { error: String(cardErr?.message || cardErr) });
      });
    }

    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Véhicule détecté :\n` +
      `🚘 ${vehicleName}${detailsTxt}${yearTxt}\n` +
      `🔧 Code moteur : ${vehicle.engine_code || "Non disponible"}\n\n` +
      `Prestation : ${data.diagTitle}\n` +
      `Détail : ${data.diagDetail}\n` +
      `Prix : ${priceTxt}\n` +
      `Durée estimée : ${data.diagDuration}\n\n` +
      `Confirmer ?`,
      [
        { id: "diag_confirm_yes", title: "✅ Confirmer" },
        { id: "diag_confirm_no", title: "❌ Annuler" },
      ]
    );
    log.info("DIAG flow → véhicule identifié, attente confirmation", { wa_id: fromWa, plate, vehicleName });
    return true;
  }

  // --- DIAG_CONFIRM : le client confirme le récap ---
  if (convState.state === "DIAG_CONFIRM" && intent === "DIAG") {
    const t = String(text || "").trim().toLowerCase();
    const isYes = ["oui", "yes", "ok", "confirmer", "✅ confirmer", "✅ Confirmer"].some(w => t.includes(w.toLowerCase())) || buttonId === "diag_confirm_yes";
    const isNo = ["non", "no", "annuler", "❌ annuler", "❌ Annuler"].some(w => t.includes(w.toLowerCase())) || buttonId === "diag_confirm_no";

    if (isNo) {
      await clearConversationState(fromWa);
      await sendWhatsAppText(fromWa, "Demande annulée. N'hésitez pas à revenir ! 🙂");
      return true;
    }

    if (!isYes) {
      await sendWhatsAppInteractiveButtons(
        fromWa,
        "Merci de confirmer ou annuler votre demande :",
        [
          { id: "diag_confirm_yes", title: "✅ Confirmer" },
          { id: "diag_confirm_no", title: "❌ Annuler" },
        ]
      );
      return true;
    }

    // Confirm → demander les coordonnées (nom + email, PAS de téléphone)
    await setConversationState(fromWa, "DIAG_EMAIL", "DIAG", convState.data);

    await sendWhatsAppText(
      fromWa,
      `Parfait ! ✅\n\nPour finaliser, merci d'envoyer votre nom et email :\n\n` +
      `(ex: Dupont Jean jean@mail.com)`
    );
    log.info("DIAG flow → confirmé, attente coordonnées", { wa_id: fromWa });
    return true;
  }

  // --- DIAG_EMAIL : collecte nom/prénom + email (pas de téléphone) ---
  if (convState.state === "DIAG_EMAIL" && intent === "DIAG") {
    const raw = String(text || "").trim();

    // Extraire l'email : chercher le mot qui contient un @
    const words = raw.split(/[\s\n]+/);
    const emailWord = words.find(w => w.includes("@"));
    // Le nom = tout ce qui n'est pas l'email
    const nameParts = words.filter(w => !w.includes("@"));
    const customerName = nameParts.join(" ").trim();
    const customerEmail = (emailWord || "").trim().toLowerCase();

    if (!customerName || customerName.length < 2) {
      await sendWhatsAppText(
        fromWa,
        "Je n'ai pas pu identifier votre nom. Merci d'envoyer votre nom et email :\n(ex: Dupont Jean jean@mail.com)"
      );
      return true;
    }

    if (!customerEmail || !validateEmail(customerEmail)) {
      await sendWhatsAppText(
        fromWa,
        "L'adresse email ne semble pas valide 😅\nMerci de réessayer :\n(ex: Dupont Jean jean@mail.com)"
      );
      return true;
    }

    const data = convState.data;
    const priceTxt = `${(data.diagPriceTtcCents / 100).toFixed(0)}€ TTC`;
    const v = data.vehicle || {};
    const vehicleTxt = `${v.make || ""} ${v.model || ""}`.trim();
    const vehicleDetails = [v.trim, v.fuel, v.year ? `${v.year}` : ""].filter(Boolean).join(" | ");

    // Create devis in Supabase so DIAG appears in the dashboard pipeline like other prestations
    let devisId = "N/A";
    let devisRow = null;
    let htTxt = priceTxt;
    let ttcTxt = priceTxt;
    try {
      devisRow = await createDevis({
        prestationCode: "diagnostic_complet",
        plate: data.plate,
        waId: fromWa,
        vehicleYear: v?.year || null,
        priceCentsOverride: data.diagPriceTtcCents,
        priceIsTtc: true,
      });
      devisId = devisRow?.id ?? "N/A";
      htTxt = typeof devisRow?.total_ht_centimes === "number"
        ? `${(devisRow.total_ht_centimes / 100).toFixed(2)}€`
        : priceTxt;
      ttcTxt = typeof devisRow?.total_ttc_centimes === "number"
        ? `${(devisRow.total_ttc_centimes / 100).toFixed(2)}€`
        : priceTxt;
      log.info("DIAG devis created", { wa_id: fromWa, devisId, option: data.diagOption });
    } catch (devisErr) {
      log.error("DIAG createDevis failed (non-blocking)", { wa_id: fromWa, error: String(devisErr?.message || devisErr) });
    }

    await sendWhatsAppInteractiveButtons(
      fromWa,
      `✅ Demande de diagnostic enregistrée !\n\n` +
      `📋 *Récapitulatif :*\n` +
      (devisId !== "N/A" ? `• Référence : DEV-${devisId}\n` : "") +
      `• Prestation : ${data.diagTitle}\n` +
      `• Détail : ${data.diagDetail}\n` +
      `• Prix : ${priceTxt}\n` +
      `• Durée estimée : ${data.diagDuration}\n` +
      `• Véhicule : ${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""}\n` +
      `• Plaque : ${data.plate}\n` +
      `• Problème : ${data.problemDescription}\n\n` +
      `👤 *Vos coordonnées :*\n` +
      `• Nom : ${customerName}\n` +
      `• Email : ${customerEmail}\n\n` +
      `Notre équipe vous recontactera très rapidement pour fixer un créneau. 📞`,
      [
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]
    );

    // Broadcast SSE + send PDF if devis was created
    if (devisRow?.isNew) {
      broadcastDashboardEvent("new_devis", { devisId, plate: data.plate || "", wa_id: fromWa, prestation: data.diagTitle, ttc: ttcTxt });
    }
    if (devisId !== "N/A") {
      sendQuotePdf(fromWa, {
        devisId, plate: data.plate, vehicle: v, prestationLabel: data.diagTitle, devisRow,
        customerName, customerEmail, customerPhone: fromWa,
      }).catch(() => {});
    }

    // Notification email équipe
    try {
      const diagNameParts = customerName.split(/\s+/);
      const diagLastName = diagNameParts[0] || "";
      const diagFirstName = diagNameParts.slice(1).join(" ") || "";

      await sendContactRecapEmail({
        lastName: diagLastName,
        firstName: diagFirstName,
        contact: customerEmail || fromWa,
        prestation: `${data.diagTitle} (${priceTxt} — ${data.diagDuration})`,
        plate: data.plate,
        vehicleDesc: `${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""} — Problème : ${data.problemDescription}`,
      });
    } catch (emailErr) {
      log.error("Erreur envoi email notif diagnostic", { wa_id: fromWa, error: String(emailErr?.message || emailErr) });
    }

    // Notification WhatsApp garage
    try {
      await notifyGarage(
        `🔍 NOUVELLE DEMANDE DIAGNOSTIC\n` +
        `Prestation : ${data.diagTitle}\n` +
        `Prix : ${priceTxt}\n` +
        `Durée : ${data.diagDuration}\n` +
        `Véhicule : ${vehicleTxt}${vehicleDetails ? ` (${vehicleDetails})` : ""}\n` +
        `Plaque : ${data.plate}\n` +
        `Problème : ${data.problemDescription}\n\n` +
        `Client : ${customerName}\n` +
        `Email : ${customerEmail}\n` +
        `WhatsApp : ${fromWa}\n` +
        `Date : ${new Date().toISOString()}`
      );
    } catch (notifErr) {
      log.error("Erreur notif garage diagnostic", { wa_id: fromWa, error: String(notifErr?.message || notifErr) });
    }

    await clearConversationState(fromWa);
    log.info("DIAG flow → terminé", { wa_id: fromWa, option: data.diagOption, customerName });
    return true;
  }


  return false;
}

// ====== SAV flow handler ======
async function handleSavFlow(fromWa, text, rawMsg) {
  const convState = await getConversationState(fromWa);

  // --- Détection intent SAV (pas d'état en cours) ---
  if (!convState || !convState.state) {
    const intent = detectIntent(text);
    if (intent === "SAV") {
      await setConversationState(fromWa, "SAV_TOPIC", "SAV", {});
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `🛠️ SAV DiagPerf\n\nQuel est le sujet de votre demande ?`,
        [
          { id: "sav_topic_1", title: "Après prestation" },
          { id: "sav_topic_2", title: "Garantie" },
          { id: "sav_topic_3", title: "Autre" },
        ]
      );
      return true;
    }
    return false;
  }

  if (convState.intent !== "SAV") return false;

  const t = String(text || "").trim();

  // --- Étape 1 : Sujet ---
  if (convState.state === "SAV_TOPIC") {
    const buttonId = extractInteractiveId(rawMsg);
    const topicMap = {
      "sav_topic_1": "Problème après prestation",
      "sav_topic_2": "Garantie",
      "sav_topic_3": "Autre",
      "1": "Problème après prestation",
      "2": "Garantie",
      "3": "Autre",
    };
    const topic = topicMap[buttonId] || topicMap[t] || null;
    
    if (!topic) {
      await sendWhatsAppInteractiveButtons(fromWa, "Veuillez choisir une option dans la liste.", [
        { id: "sav_topic_1", title: "Après prestation" },
        { id: "sav_topic_2", title: "Garantie" },
        { id: "sav_topic_3", title: "Autre" },
      ]);
      return true;
    }
    await setConversationState(fromWa, "SAV_COORDINATES", "SAV", { topic });
    await sendWhatsAppInteractiveButtons(
      fromWa,
      `Veuillez saisir vos coordonnées en un seul message au format :\n\n*Nom Prénom Email*\n\nExemple : Dupont Jean jean.dupont@gmail.com`,
      [{ id: "btn_back_menu", title: "\ud83c\udfe0 Menu" }]
    );
    return true;
  }

  // --- Étape 2 : Coordonnées (Nom + Prénom + Email) ---
  if (convState.state === "SAV_COORDINATES") {
    const parts = t.split(/\s+/);
    const emailPart = parts.find(p => p.includes("@"));
    const email = validateEmail(emailPart);
    const nameParts = parts.filter(p => !p.includes("@"));
    const customerName = nameParts.join(" ") || "";

    if (!email || customerName.length < 2) {
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `Je n'ai pas compris 😅\nVeuillez envoyer au format : *Nom Prénom Email*\nExemple : Dupont Jean jean.dupont@gmail.com`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
      return true;
    }

    await setConversationState(fromWa, "SAV_PLATE", "SAV", {
      ...convState.data,
      customer_name: customerName,
      customer_email: email,
    });
    await sendWhatsAppInteractiveButtons(fromWa, "Veuillez envoyer la plaque d'immatriculation du véhicule concerné (ex: AA 001 BB).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
    return true;
  }

  // --- Étape 3 : Plaque d'immatriculation ---
  if (convState.state === "SAV_PLATE") {
    const { valid, plate } = validatePlate(t);

    if (!valid) {
      await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas reconnu la plaque 😅\nEnvoyez-la au format AA 123 BB (avec ou sans tirets).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    try {
      const vehicle = await lookupVehicleFromPlate(plate);
      await setConversationState(fromWa, "SAV_VEHICLE_CONFIRM", "SAV", { ...convState.data, plate, vehicle });
      // Send vehicle image (best effort, non-blocking)
      getVehicleImageUrl(vehicle).then(savImgUrl => {
        if (savImgUrl) {
          sendWhatsAppImage(fromWa, savImgUrl, `🚘 ${[vehicle.make, vehicle.model].filter(Boolean).join(" ")}${vehicle.year ? ` (${vehicle.year})` : ""}`).catch(imgErr => {
            log.debug("SAV vehicle image failed (non-blocking)", { error: String(imgErr?.message || imgErr) });
          });
        }
      }).catch(e => log.debug("SAV vehicle image URL lookup failed", { error: String(e?.message || e) }));
      await sendWhatsAppInteractiveButtons(fromWa, buildVehicleOnlyText(vehicle), [
        { id: "sav_vehicle_yes", title: "✅ Oui, c'est bon" },
        { id: "sav_vehicle_no", title: "❌ Non" },
        { id: "btn_back_menu", title: "🏠 Menu" },
      ]);
      return true;
    } catch (err) {
      log.error("SAV: erreur lookup véhicule", { wa_id: fromWa, error: String(err?.message || err) });
      await setConversationState(fromWa, "SAV_VEHICLE_MANUAL", "SAV", { ...convState.data, plate });
      await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas trouvé ce véhicule 😕\nVeuillez indiquer : Marque Modèle Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }
  }

  // --- Étape 3b : Confirmation véhicule détecté ---
  if (convState.state === "SAV_VEHICLE_CONFIRM") {
    const buttonId = extractInteractiveId(rawMsg);
    const tLow = t.toLowerCase();

    if (tLow === "oui" || tLow === "o" || tLow === "yes" || buttonId === "sav_vehicle_yes") {
      const vehicle = convState.data?.vehicle || {};
      const vDesc = [vehicle.make, vehicle.model, vehicle.fuel, vehicle.power_hp ? `${vehicle.power_hp}ch` : null, vehicle.year].filter(Boolean).join(" ");
      await setConversationState(fromWa, "SAV_DESCRIPTION", "SAV", {
        ...convState.data,
        vehicle: vDesc || "N/A",
      });
      await sendWhatsAppInteractiveButtons(fromWa, "Décrivez votre problème en quelques lignes :", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    if (tLow === "non" || tLow === "n" || tLow === "no" || buttonId === "sav_vehicle_no") {
      await setConversationState(fromWa, "SAV_VEHICLE_MANUAL", "SAV", { ...convState.data });
      await sendWhatsAppInteractiveButtons(fromWa, "Veuillez indiquer : Marque Modèle Année (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    await sendWhatsAppInteractiveButtons(fromWa, "Répondez par *oui* si c'est bien votre véhicule, ou *non* dans le cas contraire.", [
      { id: "sav_vehicle_yes", title: "✅ Oui, c'est bon" },
      { id: "sav_vehicle_no", title: "❌ Non" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ]);
    return true;
  }

  // --- Étape 3c : Saisie manuelle du véhicule (fallback) ---
  if (convState.state === "SAV_VEHICLE_MANUAL") {
    if (t.length < 2) {
      await sendWhatsAppInteractiveButtons(fromWa, "Merci d'indiquer le véhicule concerné (ex: Peugeot 308 2016).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }
    await setConversationState(fromWa, "SAV_DESCRIPTION", "SAV", {
      ...convState.data,
      vehicle: t,
    });
    await sendWhatsAppInteractiveButtons(fromWa, "Décrivez votre problème en quelques lignes :", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
    return true;
  }

  // --- Étape 5 : Description → insertion ticket ---
  if (convState.state === "SAV_DESCRIPTION") {
    if (t.length < 5) {
      await sendWhatsAppInteractiveButtons(fromWa, "Merci de décrire le problème un peu plus en détail (au moins quelques mots).", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
      return true;
    }

    const customerName = convState.data?.customer_name || "";
    const customerEmail = convState.data?.customer_email || "";
    const vehicleDesc = convState.data?.vehicle || "";
    const plate = convState.data?.plate || "";
    const nameParts = customerName.split(/\s+/);
    const savLastName = nameParts[0] || "";
    const savFirstName = nameParts.slice(1).join(" ") || "";

    const ticketData = {
      wa_id: fromWa,
      topic: convState.data?.topic || null,
      customer_name: customerName || null,
      customer_phone: customerEmail || "",
      customer_email: customerEmail || null,
      vehicle: vehicleDesc || null,
      description: t,
      last_message_at: new Date().toISOString(),
    };

    try {
      const { data: ticket, error: ticketErr } = await supabase
        .from("sav_tickets")
        .insert(ticketData)
        .select("id, reference")
        .single();

      if (ticketErr) throw ticketErr;

      await clearConversationState(fromWa);

      const savRef = `SAV-${ticket.id}`;
      const ref = ticket.reference || savRef;
      await sendWhatsAppInteractiveButtons(
        fromWa,
        `✅ Demande SAV enregistrée\n` +
        `Référence : ${ref}\n` +
        `Sujet : ${ticketData.topic}\n\n` +
        `📧 Un récapitulatif a été envoyé à ${customerEmail}.\n` +
        `Notre équipe vous recontactera dans les 24h.`,
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );

      // Emails + notification garage (best effort)
      try {
        await Promise.all([
          sendSavClientEmail({
            to: customerEmail,
            firstName: savFirstName,
            lastName: savLastName,
            savRef,
            topic: ticketData.topic || "N/A",
            vehicleDesc: vehicleDesc || "N/A",
            description: t,
          }),
          sendSavDiagperfEmail({
            firstName: savFirstName,
            lastName: savLastName,
            clientEmail: customerEmail,
            waId: fromWa,
            vehicleDesc: vehicleDesc || "N/A",
            plate: plate || "N/A",
            topic: ticketData.topic || "N/A",
            description: t,
            savRef,
          }),
          notifyGarage(
            `🛠️ NOUVEAU TICKET SAV\n` +
            `Réf : ${ref}\n` +
            `Sujet : ${ticketData.topic || "N/A"}\n` +
            `Client : ${customerName || "N/A"} (${fromWa})\n` +
            `Email : ${customerEmail || "N/A"}\n` +
            `Véhicule : ${vehicleDesc || "N/A"}\n` +
            `Description : ${t || "N/A"}\n` +
            `Date : ${new Date().toISOString()}`
          ),
        ]);
      } catch (emailErr) {
        log.error("SAV: erreur envoi emails/notification", { wa_id: fromWa, error: String(emailErr?.message || emailErr) });
      }
    } catch (err) {
      log.error("Erreur création ticket SAV", { wa_id: fromWa, error: String(err?.message || err) });
      await sendWhatsAppInteractiveButtons(
        fromWa,
        "Désolé, j'ai eu un souci pour enregistrer ta demande 😕\nRéessaie dans quelques instants.",
        [{ id: "btn_back_menu", title: "🏠 Menu" }]
      );
    }
    return true;
  }

  return false;
}

// ====== POST webhook events ======
app.post("/webhook", async (req, res) => {
  // ✅ répondre vite pour Meta
  res.sendStatus(200);
  log.info("🔥 WEBHOOK HIT", { hasBody: !!req.body });

  const verifyOn =
    (process.env.VERIFY_SIGNATURE || "false").toLowerCase() === "true";
  const sig = verifyMetaSignature(req);

  if (verifyOn && !sig.ok) {
    log.warn("Signature invalide", { reason: sig.reason });
    return;
  }

  try {
    const body = req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    // 1) Messages entrants
    const messages = value.messages;
    if (Array.isArray(messages) && messages.length > 0) {
      for (const msg of messages) {
        const fromWa = msg.from;
        const waMessageId = msg.id;
        const timestamp = msg.timestamp;
        let text = extractInboundText(msg);

        // ✅ Mark message as read (blue ticks) + typing indicator
        markAsRead(waMessageId).catch(() => {});
        sendTypingIndicator(fromWa).catch(() => {});

        // Map interactive list menu selections to menu numbers for detectIntent
        const listId = msg.interactive?.list_reply?.id || null;
        if (listId) {
          const listIdToMenu = {
            "menu_1": "1", "menu_2": "2", "menu_3": "3", "menu_4": "4",
            "menu_5": "5", "menu_6": "6", "menu_7": "7", "menu_8": "8",
          };
          if (listIdToMenu[listId]) {
            text = listIdToMenu[listId];
          }
        }

        // ====== Voice/audio messages → transcription Whisper ======
        if (VOICE_TYPES.has(msg.type) && GROQ_API_KEY) {
          const mediaId = msg.voice?.id || msg.audio?.id;
          if (mediaId) {
            try {
              log.info("Voice message received, transcribing...", { wa_id: fromWa, type: msg.type, mediaId });
              const { buffer, mimeType } = await downloadWhatsAppMedia(mediaId);
              const transcript = await transcribeAudio(buffer, mimeType);
              if (transcript && transcript.length > 1) {
                log.info("Voice transcribed successfully", { wa_id: fromWa, chars: transcript.length });
                text = `[Message vocal transcrit] ${transcript}`;
                // Continue to normal text processing below (don't skip)
              } else {
                log.warn("Voice transcription empty", { wa_id: fromWa });
                await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas compris votre message vocal 😅\nPouvez-vous le réécrire en texte ?", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
                continue;
              }
            } catch (voiceErr) {
              log.error("Voice transcription failed", { wa_id: fromWa, error: String(voiceErr?.message || voiceErr) });
              await sendWhatsAppInteractiveButtons(fromWa, "Je n'ai pas pu transcrire votre message vocal 😕\nPouvez-vous l'écrire en texte ?", [{ id: "btn_back_menu", title: "🏠 Menu" }]);
              continue;
            }
          }
        }

        // ====== Non-text messages (appels manqués, médias, etc.) ======
        if (NON_TEXT_TYPES.has(msg.type)) {
          const convState = await getConversationState(fromWa);
          if (!convState || !convState.state) {
            const now = Date.now();
            const lastReply = await getNonTextCooldown(fromWa);
            if (now - lastReply < NON_TEXT_COOLDOWN_MS) {
              log.debug("Non-text auto-reply cooldown active, skip", { wa_id: fromWa, type: msg.type });
              continue;
            }
            await setNonTextCooldown(fromWa);
            await sendWhatsAppText(
              fromWa,
              `Toutes nos excuses, nous sommes actuellement indisponibles. 🙏\n\n` +
              `Pour prendre rendez-vous ou obtenir un devis instantané, vous pouvez utiliser notre assistant automatique ci-dessous.\n\n` +
              `Nous vous recontacterons dans les plus brefs délais si nécessaire.`
            );
            await sendMenuList(fromWa, { showLogo: true });
            log.info("Non-text auto-reply sent", { wa_id: fromWa, type: msg.type });
          } else {
            log.debug("Non-text message ignored (flow in progress)", { wa_id: fromWa, type: msg.type, state: convState.state });
          }
          continue;
        }

        const conversationId = await getOrCreateConversation(fromWa);

        const ins = await insertInboundMessage({
          conversationId,
          waMessageId,
          text,
          timestamp,
          raw: body,
        });
        if (!ins.inserted) continue;

        // ✅ Bouton "Menu" global
        const btnId = msg.interactive?.button_reply?.id || null;
        if (btnId === "btn_back_menu") {
          await resetConversationContext(conversationId);
          await clearConversationState(fromWa);
          await sendMenuList(fromWa);
          continue;
        }

        // ✅ reset/menu (clear both conversation contexts)
        if (isGreetingOrReset(text)) {
          await resetConversationContext(conversationId);
          await clearConversationState(fromWa);
          await sendMenuList(fromWa, { showLogo: true });
          continue;
        }

        // ✅ Commande garage "DONE [plaque]" → créer demande d'avis
        const doneHandled = await handleGarageDoneCommand(fromWa, text);
        if (doneHandled) continue;

        // ✅ Flow avis client (réponse à la demande de notation)
        const reviewHandled = await handleReviewRating(fromWa, text, msg);
        if (reviewHandled) continue;

        // ✅ Flow prestations 1-7 (conversation_state table)
        const prestaHandled = await handlePrestationFlow(fromWa, text, msg);
        if (prestaHandled) continue;

        // ✅ Flow SAV 8 (conversation_state table)
        const savHandled = await handleSavFlow(fromWa, text, msg);
        if (savHandled) continue;

        // ✅ LLM fallback : interprétation intelligente avant menu
        try {
          const llmResult = await askLLM(text, fromWa);
          if (llmResult) {
            // Cas 1 : intent détecté → re-router vers le bon flow
            if (llmResult.type === "intent" && llmResult.intent) {
              const menuMap = { REPROG: "1", E85: "2", FAP: "3", EGR: "4", ADBLUE: "5", DIAG: "6", AUTRES: "7", SAV: "8" };
              const mappedText = menuMap[llmResult.intent];
              if (mappedText) {
                log.info("LLM → intent détecté, re-routing", { wa_id: fromWa, intent: llmResult.intent });
                const prestaRetry = await handlePrestationFlow(fromWa, mappedText, msg);
                if (prestaRetry) continue;
                const savRetry = await handleSavFlow(fromWa, mappedText, msg);
                if (savRetry) continue;
              }
            }

            // Cas 2 : question → réponse FAQ + bouton Menu
            if (llmResult.type === "answer" && llmResult.message) {
              log.info("LLM → réponse FAQ", { wa_id: fromWa, msgLen: llmResult.message.length });
              await sendWhatsAppInteractiveButtons(
                fromWa,
                llmResult.message,
                [{ id: "btn_back_menu", title: "🏠 Menu" }]
              );
              // Send location pin if LLM flagged it
              if (llmResult.sendLocation) {
                sendWhatsAppLocation(fromWa, DIAGPERF_LOCATION.latitude, DIAGPERF_LOCATION.longitude, DIAGPERF_LOCATION.name, DIAGPERF_LOCATION.address).catch(locErr => {
                  log.debug("Location send failed (non-blocking)", { error: String(locErr?.message || locErr) });
                });
              }
              continue;
            }
          }
        } catch (llmErr) {
          log.error("LLM fallback error", { wa_id: fromWa, error: String(llmErr?.message || llmErr) });
        }

        // fallback final → menu
        await sendMenuList(fromWa);
      }
      return;
    }

    // 2) Statuts
    const statuses = value.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      for (const st of statuses) {
        log.debug("Status reçu", { id: st.id, status: st.status, recipient_id: st.recipient_id });
      }
      return;
    }
  } catch (err) {
    log.error("Erreur traitement webhook", { error: String(err?.message || err), stack: err?.stack });
  }
});

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
