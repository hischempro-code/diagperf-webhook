// ====== Brevo HTTP API email sender ======
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
const SENDER = { name: "Diagperf", email: process.env.EMAIL_FROM_ADDR || "diag.perf.pro@gmail.com" };
const REPLY_TO = { email: "Diag.perf.pro@gmail.com" };

const fetchFn = global.fetch || require("node-fetch");
let _log = null;

function initEmailService({ log }) {
  _log = log;
}

async function _send({ to, subject, text, html }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return false;

  const body = {
    sender: SENDER,
    to: [{ email: to }],
    replyTo: REPLY_TO,
    subject,
    textContent: text,
    htmlContent: html,
  };

  const res = await fetchFn(BREVO_API_URL, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => String(res.status));
    throw new Error(`Brevo API ${res.status}: ${err}`);
  }
  return true;
}

// ====== Email devis au client (best effort) ======
async function sendQuoteEmail({ to, devis }) {
  if (!to || !process.env.BREVO_API_KEY) return;

  const ref = `DEV-${devis.id}`;
  const htTxt = typeof devis.total_ht_centimes === "number"
    ? `${(devis.total_ht_centimes / 100).toFixed(2)}€`
    : "N/A";
  const ttcTxt = typeof devis.total_ttc_centimes === "number"
    ? `${(devis.total_ttc_centimes / 100).toFixed(2)}€`
    : "N/A";

  try {
    await _send({
      to,
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
    });
    _log.info("sendQuoteEmail: envoi OK", { to, ref });
    return true;
  } catch (err) {
    _log.error("sendQuoteEmail: échec envoi", { to, ref, error: String(err?.message || err) });
    return false;
  }
}

// ====== Email contact recap (envoi à Diag.perf.pro@gmail.com) ======
async function sendContactRecapEmail({ lastName, firstName, contact, prestation, plate, vehicleDesc }) {
  if (!process.env.BREVO_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  try {
    await _send({
      to: toEmail,
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
    });
    _log.info("sendContactRecapEmail: envoi OK", { to: toEmail, prestation });
    return true;
  } catch (err) {
    _log.error("sendContactRecapEmail: échec envoi", { to: toEmail, error: String(err?.message || err) });
    return false;
  }
}

// ====== Email devis client (après RDV ou contact technicien) ======
async function sendRdvClientEmail({ to, firstName, lastName, vehicleDesc, prestationLabel, devisRef, htTxt, ttcTxt, contactReason }) {
  if (!to || !process.env.BREVO_API_KEY) return;

  const subjectPrefix = contactReason === "technicien" ? "Contact technicien" : "Votre devis Diagperf";
  const subject = `${subjectPrefix} - ${prestationLabel} - Ref. ${devisRef}`;

  try {
    await _send({
      to,
      subject,
      text:
        `Bonjour ${firstName} ${lastName},\n\n` +
        `Nous vous remercions pour votre confiance.\n\n` +
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
        `<table style="border-collapse:collapse;width:100%;margin:16px 0;">` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🚗 Véhicule</td><td style="padding:8px;border:1px solid #ddd;">${vehicleDesc}</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">🔧 Prestation</td><td style="padding:8px;border:1px solid #ddd;">${prestationLabel}</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">⏱️ Durée</td><td style="padding:8px;border:1px solid #ddd;">2h-4h</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence devis</td><td style="padding:8px;border:1px solid #ddd;">${devisRef}</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total HT</td><td style="padding:8px;border:1px solid #ddd;">${htTxt}</td></tr>` +
        `<tr style="background:#f5f5f5;"><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total TTC</td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${ttcTxt}</td></tr>` +
        `</table>` +
        `<p>Notre équipe vous recontactera dans les plus brefs délais pour convenir d'un rendez-vous.</p>` +
        `<p>Cordialement,<br><strong>L'équipe Diagperf</strong></p>` +
        `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
        `</div>`,
    });
    _log.info("sendRdvClientEmail: envoi OK", { to, devisRef });
    return true;
  } catch (err) {
    _log.error("sendRdvClientEmail: échec envoi", { to, devisRef, error: String(err?.message || err) });
    return false;
  }
}

// ====== Email notification Diagperf (après RDV ou contact technicien) ======
async function sendRdvDiagperfEmail({ firstName, lastName, clientEmail, waId, vehicleDesc, engineCode, plate, prestationLabel, devisRef, htTxt, ttcTxt, contactReason }) {
  if (!process.env.BREVO_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  const subjectPrefix = contactReason === "technicien" ? "Contact technicien" : "Nouvelle demande de RDV";
  const subject = `${subjectPrefix} - ${prestationLabel} - ${firstName} ${lastName}`;

  try {
    await _send({
      to: toEmail,
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
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">⏱️ Durée</td><td style="padding:8px;border:1px solid #ddd;">2h-4h</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">📋 Référence devis</td><td style="padding:8px;border:1px solid #ddd;">${devisRef}</td></tr>` +
        `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total HT</td><td style="padding:8px;border:1px solid #ddd;">${htTxt}</td></tr>` +
        `<tr style="background:#f5f5f5;"><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">💰 Total TTC</td><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">${ttcTxt}</td></tr>` +
        `</table>` +
        `<p style="color:#888;font-size:12px;">Diagperf – Reprogrammation & Diagnostic automobile</p>` +
        `</div>`,
    });
    _log.info("sendRdvDiagperfEmail: envoi OK", { to: toEmail, devisRef });
    return true;
  } catch (err) {
    _log.error("sendRdvDiagperfEmail: échec envoi", { to: toEmail, devisRef, error: String(err?.message || err) });
    return false;
  }
}

// ====== Email SAV client (confirmation demande SAV) ======
async function sendSavClientEmail({ to, firstName, lastName, savRef, topic, vehicleDesc, description }) {
  if (!to || !process.env.BREVO_API_KEY) return;

  try {
    await _send({
      to,
      subject: `DiagPerf - Confirmation demande SAV - Ref. ${savRef}`,
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
    });
    _log.info("sendSavClientEmail: envoi OK", { to, savRef });
    return true;
  } catch (err) {
    _log.error("sendSavClientEmail: échec envoi", { to, savRef, error: String(err?.message || err) });
    return false;
  }
}

// ====== Email SAV notification Diagperf ======
async function sendSavDiagperfEmail({ firstName, lastName, clientEmail, waId, vehicleDesc, plate, topic, description, savRef }) {
  if (!process.env.BREVO_API_KEY) return;

  const toEmail = "Diag.perf.pro@gmail.com";
  try {
    await _send({
      to: toEmail,
      subject: `Nouveau ticket SAV - ${topic} - ${firstName} ${lastName}`,
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
    });
    _log.info("sendSavDiagperfEmail: envoi OK", { to: toEmail, savRef });
    return true;
  } catch (err) {
    _log.error("sendSavDiagperfEmail: échec envoi", { to: toEmail, savRef, error: String(err?.message || err) });
    return false;
  }
}

module.exports = {
  initEmailService,
  sendQuoteEmail,
  sendContactRecapEmail,
  sendRdvClientEmail,
  sendRdvDiagperfEmail,
  sendSavClientEmail,
  sendSavDiagperfEmail,
};
