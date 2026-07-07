const { extractInteractiveId } = require("./text-helpers");
const { detectSentiment } = require("./sentiment-detector");
const { normalizePlate } = require("./text-helpers");
const { intentToLabel } = require("./intent-detector");
const { INTENT_MAP } = require("./intent-detector");

let _log, _supabase;
let _sendWhatsAppText, _sendWhatsAppInteractiveButtons;
let _setConversationState, _clearConversationState, _getConversationState;
let _sendMenuList;

function initEventHandlers({ log, supabase, sendWhatsAppText, sendWhatsAppInteractiveButtons, setConversationState, clearConversationState, getConversationState, sendMenuList }) {
  _log = log;
  _supabase = supabase;
  _sendWhatsAppText = sendWhatsAppText;
  _sendWhatsAppInteractiveButtons = sendWhatsAppInteractiveButtons;
  _setConversationState = setConversationState;
  _clearConversationState = clearConversationState;
  _getConversationState = getConversationState;
  _sendMenuList = sendMenuList;
}

// ====== Garage internal notification (best effort) ======
async function notifyGarage(message) {
  const garageWaId = process.env.GARAGE_WA_ID;
  if (!garageWaId) {
    _log.debug("notifyGarage: GARAGE_WA_ID non configuré, skip");
    return;
  }
  try {
    _log.info("notifyGarage: envoi en cours", { to: garageWaId, preview: message.slice(0, 80) });
    await _sendWhatsAppText(garageWaId, message);
    _log.info("notifyGarage: envoi OK", { to: garageWaId });
  } catch (err) {
    _log.error("notifyGarage: échec envoi", { to: garageWaId, error: String(err?.message || err) });
  }
}

// ====== Frustration / human escalation ======
const ESCALATION_COOLDOWN_MS = 15 * 60 * 1000;
const _lastEscalationAt = new Map();

async function handleFrustrationEscalation(fromWa, text, rawMsg) {
  if (!text || rawMsg?.interactive) return false;

  const signal = detectSentiment(text, {});
  if (!signal.shouldEscalate) return false;

  const last = _lastEscalationAt.get(fromWa) || 0;
  const now = Date.now();
  if (now - last < ESCALATION_COOLDOWN_MS) {
    _log.debug("Escalation cooldown active, skip", { wa_id: fromWa, score: signal.score });
    return false;
  }

  _lastEscalationAt.set(fromWa, now);

  _log.warn("Frustration détectée → escalade humaine", {
    wa_id: fromWa, score: signal.score, level: signal.level,
    critical: signal.critical, reasons: signal.reasons, preview: text.slice(0, 120),
  });

  const calmingMsg = signal.critical
    ? `🚨 J'ai bien noté une situation urgente. Notre équipe va être prévenue immédiatement.\n\nSouhaitez-vous être rappelé(e) ?`
    : signal.level === "angry"
      ? `Je comprends votre frustration et j'en suis désolé 🙏\nJe préfère passer la main à un conseiller humain de l'équipe DiagPerf pour vous aider correctement.\n\nSouhaitez-vous être rappelé(e) ?`
      : `Je sens que vous êtes un peu frustré(e), et c'est normal 🙏\nJe peux vous mettre en relation avec un conseiller humain de DiagPerf.\n\nSouhaitez-vous être rappelé(e) ?`;

  try {
    await _sendWhatsAppInteractiveButtons(fromWa, calmingMsg, [
      { id: "escalate_callback", title: "☎️ Être rappelé" },
      { id: "escalate_continue", title: "💬 Continuer ici" },
      { id: "btn_back_menu", title: "🏠 Menu" },
    ]);
  } catch (err) {
    _log.error("Escalation: erreur envoi message apaisement", { wa_id: fromWa, error: String(err?.message || err) });
  }

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

async function handleEscalationButtons(fromWa, text, rawMsg) {
  const buttonId = extractInteractiveId(rawMsg);
  if (!buttonId) return false;

  if (buttonId === "escalate_callback") {
    _log.info("Client demande un rappel via escalade", { wa_id: fromWa });
    await _sendWhatsAppInteractiveButtons(
      fromWa,
      `✅ C'est noté ! Un conseiller DiagPerf va vous rappeler dans les meilleurs délais.\n\nEntre-temps, vous pouvez aussi nous joindre au *06 75 54 70 85* (horaires : Mar-Ven 10h-18h, Sam 10h-16h).`,
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
    _log.info("Client choisit de continuer avec le bot", { wa_id: fromWa });
    _lastEscalationAt.delete(fromWa);
    await _sendWhatsAppInteractiveButtons(
      fromWa,
      `Parfait, on continue ensemble 👌\nDites-moi ce que vous souhaitez faire :`,
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
const GOOGLE_REVIEWS_URL = process.env.GOOGLE_REVIEWS_URL || "https://g.page/r/diagperf/review";
const REVIEW_CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function createReviewRequest({ waId, devisId, prestation, vehicleDesc, customerName, customerEmail }) {
  try {
    const { data, error } = await _supabase
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
    _log.info("Review request created", { wa_id: waId, devisId, id: data?.id });
    return data;
  } catch (err) {
    _log.error("createReviewRequest failed", { wa_id: waId, error: String(err?.message || err) });
    return null;
  }
}

async function processReviewRequests() {
  try {
    const { data: pending, error } = await _supabase
      .from("review_requests")
      .select("*")
      .eq("sent", false)
      .lte("send_at", new Date().toISOString())
      .limit(10);

    if (error) {
      _log.error("processReviewRequests: query failed", { error: error.message });
      return;
    }
    if (!pending || pending.length === 0) return;

    for (const req of pending) {
      try {
        // Ne JAMAIS écraser une conversation en cours (ex: client en plein devis) —
        // sinon son prochain message serait interprété comme une note d'avis.
        // On saute ce tick ; `sent` reste false → retenté au prochain passage (5 min).
        try {
          const cs = await _getConversationState(req.wa_id);
          if (cs && cs.state) {
            _log.info("Review request différée — conversation en cours", { wa_id: req.wa_id, state: cs.state });
            continue;
          }
        } catch { /* en cas de doute sur l'état, on tente l'envoi */ }

        const name = req.customer_name ? ` ${req.customer_name.split(" ")[0]}` : "";
        const prestaTxt = req.prestation ? `\n🛠️ Prestation : ${req.prestation}` : "";

        await _sendWhatsAppInteractiveButtons(
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

        await _setConversationState(req.wa_id, "AWAITING_REVIEW_RATING", null, {
          reviewRequestId: req.id,
          customerName: req.customer_name,
          customerEmail: req.customer_email,
        });

        await _supabase.from("review_requests").update({ sent: true }).eq("id", req.id);
        _log.info("Review request sent", { wa_id: req.wa_id, id: req.id });
      } catch (sendErr) {
        const emsg = String(sendErr?.message || sendErr);
        // Fenêtre 24h WhatsApp fermée (erreur Meta 131047) : le texte libre est refusé,
        // il faudrait un TEMPLATE approuvé. Réessayer toutes les 5 min ne sert à rien
        // → on marque comme traité pour arrêter la boucle.
        if (emsg.includes("131047") || /re-?engagement/i.test(emsg)) {
          await _supabase.from("review_requests").update({ sent: true }).eq("id", req.id);
          _log.warn("Review request hors fenêtre 24h — abandonnée (nécessite un template Meta approuvé)", { wa_id: req.wa_id, id: req.id });
        } else {
          _log.error("processReviewRequests: send failed", { wa_id: req.wa_id, id: req.id, error: emsg });
        }
      }
    }
  } catch (err) {
    _log.error("processReviewRequests: unexpected error", { error: String(err?.message || err) });
  }
}

async function handleReviewRating(fromWa, text, rawMsg) {
  const convState = await _getConversationState(fromWa);
  if (!convState || convState.state !== "AWAITING_REVIEW_RATING") return false;

  const buttonId = extractInteractiveId(rawMsg);
  const t = String(text || "").trim().toLowerCase();
  const stateData = convState.data || {};
  const reviewRequestId = stateData.reviewRequestId;

  if (buttonId === "btn_back_menu") {
    await _clearConversationState(fromWa);
    await _sendMenuList(fromWa);
    return true;
  }

  let rating = null;
  if (buttonId === "review_5" || t === "5" || t.includes("excellent")) rating = 5;
  else if (buttonId === "review_4" || t === "4" || t.includes("très bien") || t.includes("tres bien")) rating = 4;
  else if (buttonId === "review_low" || t === "1" || t === "2" || t === "3" || t.includes("améliorer") || t.includes("ameliorer") || t.includes("pas bien") || t.includes("mauvais") || t.includes("nul")) rating = parseInt(t, 10) || 2;

  if (rating === null) {
    await _sendWhatsAppInteractiveButtons(fromWa, `Merci de choisir une des options ci-dessous 😊`, [
      { id: "review_5", title: "⭐⭐⭐⭐⭐ Excellent" },
      { id: "review_4", title: "⭐⭐⭐⭐ Très bien" },
      { id: "review_low", title: "😕 À améliorer" },
    ]);
    return true;
  }

  if (reviewRequestId) {
    await _supabase.from("review_requests").update({ rating, responded_at: new Date().toISOString() }).eq("id", reviewRequestId);
  }

  if (rating >= 4) {
    await _sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci beaucoup ! 🙏 Nous sommes ravis que vous soyez satisfait !\n\n` +
      `Si vous avez 30 secondes, un avis Google nous aiderait énormément :\n` +
      `👉 ${GOOGLE_REVIEWS_URL}\n\n` +
      `Merci et à bientôt chez DiagPerf ! 🚗`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );
    _log.info("Review: positive rating", { wa_id: fromWa, rating });
  } else {
    await _sendWhatsAppInteractiveButtons(
      fromWa,
      `Merci pour votre retour honnête 🙏\n\n` +
      `Nous sommes désolés que votre expérience n'ait pas été à la hauteur.\n` +
      `Un technicien va vous recontacter rapidement pour résoudre le problème.\n\n` +
      `Votre satisfaction est notre priorité ! 💪`,
      [{ id: "btn_back_menu", title: "🏠 Menu" }]
    );
    const name = stateData.customerName || fromWa;
    await notifyGarage(
      `⚠️ AVIS NÉGATIF (${rating}⭐)\n` +
      `Client : ${name} (${fromWa})\n` +
      `Email : ${stateData.customerEmail || "N/A"}\n\n` +
      `🔴 Action requise : recontacter le client dans les plus brefs délais.`
    );
    _log.info("Review: negative rating → garage notified", { wa_id: fromWa, rating });
  }

  await _clearConversationState(fromWa);
  return true;
}

async function handleGarageDoneCommand(fromWa, text) {
  const garageWaId = process.env.GARAGE_WA_ID;
  if (!garageWaId || fromWa !== garageWaId) return false;

  const match = String(text || "").trim().match(/^DONE\s+(.+)/i);
  if (!match) return false;

  const plateOrRef = match[1].trim().toUpperCase();
  _log.info("Garage DONE command received", { plate: plateOrRef });

  try {
    const normalizedPlate = normalizePlate(plateOrRef);
    const { data: devis, error } = await _supabase
      .from("devis")
      .select("id, wa_id, prestation_code, plaque")
      .or(`plaque.eq.${normalizedPlate},plaque.eq.${plateOrRef}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!devis) {
      await _sendWhatsAppText(fromWa, `❌ Aucun devis trouvé pour "${plateOrRef}".`);
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
      await _sendWhatsAppText(fromWa,
        `✅ Intervention marquée comme terminée pour ${plateOrRef}.\n` +
        `📩 Demande d'avis programmée dans 48h pour le client ${devis.wa_id}.`
      );
    } else {
      await _sendWhatsAppText(fromWa, `⚠️ Intervention marquée mais erreur lors de la création de la demande d'avis.`);
    }
  } catch (err) {
    _log.error("handleGarageDoneCommand failed", { plate: plateOrRef, error: String(err?.message || err) });
    await _sendWhatsAppText(fromWa, `❌ Erreur : ${err?.message || "inconnue"}`);
  }

  return true;
}

module.exports = {
  initEventHandlers,
  notifyGarage,
  handleFrustrationEscalation,
  handleEscalationButtons,
  createReviewRequest,
  processReviewRequests,
  handleReviewRating,
  handleGarageDoneCommand,
  REVIEW_CHECK_INTERVAL_MS,
};
