/**
 * lib/signature.js — Vérification de la signature HMAC des webhooks Meta (X-Hub-Signature-256).
 *
 * Meta signe chaque POST avec HMAC-SHA256(rawBody, APP_SECRET) et l'envoie dans l'en-tête
 * `x-hub-signature-256: sha256=<hex>`. Sans cette vérif, n'importe qui connaissant l'URL du
 * webhook peut injecter de faux messages (faux devis, spam garage, tokens brûlés).
 *
 * IMPORTANT : la vérif porte sur le corps BRUT (bytes reçus), pas sur le JSON re-sérialisé —
 * server.js capture `req.rawBody` via le callback `verify` d'express.json (une re-sérialisation
 * changerait les octets et casserait la signature). Comparaison en temps constant (timingSafeEqual)
 * pour ne pas fuiter d'information par timing.
 */
"use strict";
const crypto = require("crypto");

/**
 * @param {Buffer|string|null} rawBody - corps brut de la requête (req.rawBody)
 * @param {string|null} signatureHeader - en-tête x-hub-signature-256 ("sha256=...")
 * @param {string|null} appSecret - META_APP_SECRET
 * @returns {{ok: boolean, reason: string}}
 */
function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader) return { ok: false, reason: "missing_signature_header" };
  if (!appSecret) return { ok: false, reason: "missing_META_APP_SECRET" };
  if (!rawBody) return { ok: false, reason: "missing_raw_body" };

  const expected =
    "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  // Comparaison en temps constant sur des buffers de taille fixe (71 = "sha256=" + 64 hex).
  // On borne à SIG_LEN pour que timingSafeEqual reçoive deux buffers de même taille, puis on
  // exige l'égalité de longueur exacte (rejette une signature tronquée/rallongée).
  const SIG_LEN = 71;
  const sigBuf = Buffer.alloc(SIG_LEN, 0);
  const expBuf = Buffer.alloc(SIG_LEN, 0);
  Buffer.from(String(signatureHeader).slice(0, SIG_LEN), "utf8").copy(sigBuf);
  Buffer.from(expected.slice(0, SIG_LEN), "utf8").copy(expBuf);
  const bytesMatch = crypto.timingSafeEqual(sigBuf, expBuf);
  const ok = bytesMatch && String(signatureHeader).length === expected.length;
  return { ok, reason: ok ? "ok" : "bad_signature" };
}

module.exports = { verifyMetaSignature };
