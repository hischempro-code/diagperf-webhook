/**
 * WhatsApp Cloud API client.
 * All functions need log, fetchFn, WA_API_VERSION and insertOutboundMessage passed via init.
 */

let _log, _fetchFn, _WA_API_VERSION, _insertOutboundMessage;

function initWhatsAppClient({ log, fetchFn, WA_API_VERSION, insertOutboundMessage }) {
  _log = log;
  _fetchFn = fetchFn;
  _WA_API_VERSION = WA_API_VERSION;
  _insertOutboundMessage = insertOutboundMessage;
}

const WHATSAPP_API_BASE = () => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${_WA_API_VERSION}/${phoneNumberId}`;
};

async function _callWhatsAppAPI(to, payload, { endpoint = "messages", logLabel = "WhatsApp" } = {}) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token) throw new Error("Missing WHATSAPP_TOKEN in env");
  if (!phoneNumberId) throw new Error("Missing WHATSAPP_PHONE_NUMBER_ID in env");

  const url = `${WHATSAPP_API_BASE()}/${endpoint}`;

  const resp = await _fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      ...payload,
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    _log.error(`${logLabel} API error`, { status: resp.status, to, body: json });
    throw new Error(`${logLabel} failed: ${resp.status} – ${JSON.stringify(json.error || json)}`);
  }

  if (json.error) {
    _log.error(`${logLabel} API returned error in 200`, { to, error: json.error });
    throw new Error(`${logLabel} API error: ${JSON.stringify(json.error)}`);
  }

  return json;
}

async function markAsRead(messageId) {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return;
    await _fetchFn(`https://graph.facebook.com/${_WA_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
    });
  } catch (err) {
    _log.debug("markAsRead failed", { messageId, error: String(err?.message || err) });
  }
}

async function sendTypingIndicator(to) {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) return;
    await _fetchFn(`https://graph.facebook.com/${_WA_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, recipient_type: "individual", typing_action: "typing_on" }),
    });
  } catch (err) {
    _log.debug("sendTypingIndicator failed", { to, error: String(err?.message || err) });
  }
}

async function sendWhatsAppText(to, text, { preview_url = false } = {}) {
  const json = await _callWhatsAppAPI(to, { type: "text", text: { preview_url, body: text } }, { logLabel: "Text" });
  _insertOutboundMessage(to, text).catch(() => {});
  return json;
}

async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  const json = await _callWhatsAppAPI(
    to,
    {
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
    },
    { logLabel: "Interactive" }
  );
  _insertOutboundMessage(to, bodyText).catch(() => {});
  return json;
}

async function sendWhatsAppList(to, bodyText, buttonLabel, sections) {
  const json = await _callWhatsAppAPI(
    to,
    {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections,
        },
      },
    },
    { logLabel: "List" }
  );
  _insertOutboundMessage(to, bodyText).catch(() => {});
  return json;
}

async function sendWhatsAppImage(to, imageUrl, caption = "") {
  const imagePayload = { link: imageUrl };
  if (caption) imagePayload.caption = caption;
  const json = await _callWhatsAppAPI(to, { type: "image", image: imagePayload }, { logLabel: "Image" });
  _insertOutboundMessage(to, caption || "[image]").catch(() => {});
  return json;
}

async function sendWhatsAppVideo(to, videoUrl, caption = "") {
  const videoPayload = { link: videoUrl };
  if (caption) videoPayload.caption = caption;
  const json = await _callWhatsAppAPI(to, { type: "video", video: videoPayload }, { logLabel: "Video" });
  _insertOutboundMessage(to, caption || "[video]").catch(() => {});
  return json;
}

async function sendWhatsAppLocation(to, latitude, longitude, name, address) {
  const json = await _callWhatsAppAPI(
    to,
    { type: "location", location: { latitude, longitude, name, address } },
    { logLabel: "Location" }
  );
  _insertOutboundMessage(to, `[📍 ${name}] ${address}`).catch(() => {});
  return json;
}

async function sendWhatsAppDocument(to, mediaId, filename, caption) {
  const json = await _callWhatsAppAPI(
    to,
    { type: "document", document: { id: mediaId, filename, caption: caption || "" } },
    { logLabel: "Document" }
  );
  _insertOutboundMessage(to, caption || `[📄 ${filename}]`).catch(() => {});
  return json;
}

async function uploadWhatsAppMedia(buffer, filename, mimeType) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error("Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  const resp = await fetch(`${WHATSAPP_API_BASE()}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.error) {
    _log.error("WhatsApp Media Upload error", { status: resp.status, body: json });
    throw new Error(`Media upload failed: ${JSON.stringify(json.error || json)}`);
  }
  return json.id;
}

module.exports = {
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
};
