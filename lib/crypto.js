/**
 * lib/crypto.js — Chiffrement des secrets par client (table tenant_secrets).
 *
 * En multi-tenant, chaque client a SES identifiants WhatsApp (token, phone_number_id,
 * app secret…). Ils ne peuvent plus vivre dans .env : il y en a autant que de clients,
 * et ils changent sans redéploiement. Ils vont donc en base — mais en clair, une fuite
 * de la base donnerait à l'attaquant le droit d'envoyer des messages WhatsApp au nom de
 * tous tes clients. D'où le chiffrement applicatif.
 *
 * AES-256-GCM : chiffre ET authentifie (le tag détecte toute altération du chiffré, ce
 * qu'un simple AES-CBC ne ferait pas — un octet modifié en base donnerait un déchiffrement
 * silencieusement faux au lieu d'une erreur).
 *
 * La clé maîtresse vit UNIQUEMENT dans l'environnement (TENANT_SECRET_KEY, 32 octets en
 * base64) : la base chiffrée et la clé ne sont jamais au même endroit. Une sauvegarde
 * Supabase qui fuite ne suffit donc pas à déchiffrer quoi que ce soit.
 *
 * Format stocké : "v1:<iv base64>:<tag base64>:<chiffré base64>". Le préfixe de version
 * permettra une rotation de clé plus tard sans deviner le format des anciennes valeurs.
 */
"use strict";
const crypto = require("crypto");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;   // 96 bits : taille recommandée pour GCM
const KEY_BYTES = 32;  // AES-256
const VERSION = "v1";

/**
 * Lit et valide la clé maîtresse.
 * @param {string} [keyB64] - clé explicite (tests) ; sinon process.env.TENANT_SECRET_KEY
 * @returns {Buffer}
 */
function getMasterKey(keyB64) {
  const raw = keyB64 || process.env.TENANT_SECRET_KEY;
  if (!raw) {
    throw new Error(
      "TENANT_SECRET_KEY absente — impossible de (dé)chiffrer les secrets clients. " +
      "Générer une clé : node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    );
  }
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("TENANT_SECRET_KEY invalide : base64 attendu");
  }
  // Garde-fou explicite : une clé trop courte (ex: passphrase collée telle quelle)
  // passerait silencieusement en AES-128 ou lèverait une erreur cryptique de Node.
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TENANT_SECRET_KEY invalide : ${key.length} octets décodés, ${KEY_BYTES} attendus ` +
      `(la clé doit être 32 octets aléatoires encodés en base64, pas une phrase de passe)`
    );
  }
  return key;
}

/**
 * Chiffre une valeur texte.
 * @param {string} plaintext
 * @param {string} [keyB64]
 * @returns {string} "v1:<iv>:<tag>:<chiffré>"
 */
function encryptSecret(plaintext, keyB64) {
  if (typeof plaintext !== "string") throw new Error("encryptSecret: chaîne attendue");
  const key = getMasterKey(keyB64);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

/**
 * Déchiffre une valeur produite par encryptSecret.
 * Lève si le chiffré a été altéré, tronqué, ou chiffré avec une autre clé.
 * @param {string} payload
 * @param {string} [keyB64]
 * @returns {string}
 */
function decryptSecret(payload, keyB64) {
  if (typeof payload !== "string" || !payload) {
    throw new Error("decryptSecret: valeur chiffrée manquante");
  }
  const parts = payload.split(":");
  if (parts.length !== 4) throw new Error("decryptSecret: format invalide");
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION) throw new Error(`decryptSecret: version inconnue « ${version} »`);

  const key = getMasterKey(keyB64);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES) throw new Error("decryptSecret: IV invalide");
  if (tag.length !== 16) throw new Error("decryptSecret: tag d'authentification invalide");

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // .final() lève si le tag ne correspond pas : c'est la détection d'altération.
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Génère une clé maîtresse utilisable comme TENANT_SECRET_KEY. */
function generateMasterKey() {
  return crypto.randomBytes(KEY_BYTES).toString("base64");
}

module.exports = { encryptSecret, decryptSecret, generateMasterKey, getMasterKey };
