/**
 * whatsapp-api.js — API WhatsApp centralisée
 * Tous les appels à l'API WhatsApp Business
 */

const { log } = require("./logger");
const { config } = require("../config");

const fetchFn = global.fetch || require("node-fetch");

// ====== Configuration API ======
const WHATSAPP_API_BASE = () => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${config.WA_API_VERSION}/${phoneNumberId}`;
};

const token = () => process.env.WHATSAPP_TOKEN;

// ====== Retry utility ======
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

// ====== Base API call ======
async function _callWhatsAppAPI(to, payload, { endpoint = "messages", logLabel = "WhatsApp" } = {}) {
  const url = `${WHATSAPP_API_BASE()}/${endpoint}`;

  const resp = await withRetry(
    () =>
      fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...payload, to }),
      }),
    { label: `${logLabel} API` }
  );

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    log.error(`${logLabel} API error`, { status: resp.status, body: errBody.slice(0, 200), to });
    throw new Error(`${logLabel} API ${resp.status}: ${errBody.slice(0, 100)}`);
  }

  const json = await resp.json();
  return json;
}

// ====== Message types ======
async function sendWhatsAppText(to, text) {
  return _callWhatsAppAPI(to, { type: "text", text: { body: text } }, { logLabel: "Text" });
}

async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  return _callWhatsAppAPI(
    to,
    {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    },
    { logLabel: "Buttons" }
  );
}

async function sendWhatsAppList(to, bodyText, buttonLabel, sections) {
  return _callWhatsAppAPI(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
          })),
        },
      },
    },
    { logLabel: "List" }
  );
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const imagePayload = { link: imageUrl };
  if (caption) imagePayload.caption = caption;
  return _callWhatsAppAPI(to, { type: "image", image: imagePayload }, { logLabel: "Image" });
}

async function sendWhatsAppVideo(to, videoUrl, caption = "") {
  const videoPayload = { link: videoUrl };
  if (caption) videoPayload.caption = caption;
  return _callWhatsAppAPI(to, { type: "video", video: videoPayload }, { logLabel: "Video" });
}

async function sendWhatsAppLocation(to, latitude, longitude, name, address) {
  return _callWhatsAppAPI(
    to,
    { type: "location", location: { latitude, longitude, name, address } },
    { logLabel: "Location" }
  );
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  return _callWhatsAppAPI(
    to,
    {
      type: "document",
      document: { id: mediaId, filename, caption: caption || undefined },
    },
    { logLabel: "Document" }
  );
}

// ====== Utility functions ======
async function markAsRead(messageId) {
  try {
    await fetchFn(`${WHATSAPP_API_BASE()}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        message_id: messageId,
        status: "read",
      }),
    });
  } catch (err) {
    log.debug("markAsRead failed (non-blocking)", { error: String(err?.message || err) });
  }
}

async function sendTypingIndicator(to) {
  try {
    await fetchFn(`${WHATSAPP_API_BASE()}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "typing_indicator",
        typing_indicator: { type: "text" },
      }),
    });
  } catch (err) {
    // Non-blocking
  }
}

// ====== Menu builder ======
async function sendMenuList(to, { showLogo = false } = {}) {
  const headerText = showLogo
    ? `👋 Bienvenue chez *DiagPerf* !\n\n🏎️ Spécialiste reprogrammation moteur & diagnostic\n\nPour commencer, choisissez une option :`
    : `🛠️ Que puis-je faire pour vous ?`;

  const logoImage = "https://diagperf.com/logo.png";

  if (showLogo) {
    await sendWhatsAppImage(to, logoImage, "DiagPerf — Reprogrammation & Diagnostic").catch(() => {});
  }

  return sendWhatsAppList(
    to,
    headerText,
    "📋 Nos prestations",
    [
      {
        title: "Nos prestations",
        rows: [
          { id: "menu_1", title: "🏎️ Reprogrammation moteur", description: "Stage 1 à 4 — à partir de 390€ TTC" },
          { id: "menu_2", title: "⛽ Conversion E85", description: "Flexfuel éthanol — à partir de 490€ TTC" },
          { id: "menu_3", title: "🔧 Suppression FAP", description: "Diesel uniquement — à partir de 260€ TTC" },
          { id: "menu_4", title: "🔧 Suppression EGR", description: "Tous diesels — sur devis" },
          { id: "menu_5", title: "🔧 Suppression AdBlue", description: "BlueHDi & autres — à partir de 260€ TTC" },
          { id: "menu_6", title: "🔍 Diagnostic", description: "Simple, approfondi, recherche panne" },
          { id: "menu_7", title: "🎨 Autres services", description: "CarPlay, céramique, alarme, etc." },
          { id: "menu_8", title: "🛠️ SAV / Support", description: "Problème après prestation ou garantie" },
        ],
      },
    ]
  );
}

module.exports = {
  sendWhatsAppText,
  sendWhatsAppInteractiveButtons,
  sendWhatsAppList,
  sendWhatsAppImage,
  sendWhatsAppVideo,
  sendWhatsAppLocation,
  sendWhatsAppDocument,
  markAsRead,
  sendTypingIndicator,
  sendMenuList,
  withRetry,
};
