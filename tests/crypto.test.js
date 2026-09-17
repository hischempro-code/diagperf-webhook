/**
 * Tests du chiffrement des secrets clients (lib/crypto.js).
 *
 * Ce qu'on prouve : un secret chiffré se relit correctement, et TOUTE altération
 * (un octet du chiffré, du tag, de l'IV, ou une autre clé maîtresse) lève au lieu
 * de rendre silencieusement une valeur fausse. C'est ce qui distingue AES-GCM d'un
 * chiffrement sans authentification — et c'est important ici : un token WhatsApp
 * déchiffré « presque bien » produirait un bot muet, très long à diagnostiquer.
 */
const assert = require("assert");
const crypto = require("crypto");
const { encryptSecret, decryptSecret, generateMasterKey, getMasterKey } = require("../lib/crypto");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}\n     ${err.message}`); }
}

const KEY = generateMasterKey();
const AUTRE_KEY = generateMasterKey();
const TOKEN = "EAAG9ZClaireToken123|secret_whatsapp_du_client";

console.log("\n🔐 Aller-retour");
check("chiffrer puis déchiffrer rend la valeur d'origine", () => {
  assert.strictEqual(decryptSecret(encryptSecret(TOKEN, KEY), KEY), TOKEN);
});
check("les accents et l'UTF-8 survivent", () => {
  const v = "Château-Thierry · émoji 🚗 · clé#1";
  assert.strictEqual(decryptSecret(encryptSecret(v, KEY), KEY), v);
});
check("la chaîne vide est un secret valide", () => {
  assert.strictEqual(decryptSecret(encryptSecret("", KEY), KEY), "");
});
check("deux chiffrements de la même valeur diffèrent (IV aléatoire)", () => {
  assert.notStrictEqual(encryptSecret(TOKEN, KEY), encryptSecret(TOKEN, KEY));
});
check("le format stocké est versionné v1:iv:tag:data", () => {
  const parts = encryptSecret(TOKEN, KEY).split(":");
  assert.strictEqual(parts.length, 4);
  assert.strictEqual(parts[0], "v1");
});

console.log("\n🚫 Altérations → refus explicite, jamais de valeur fausse");
check("autre clé maîtresse → lève", () => {
  const enc = encryptSecret(TOKEN, KEY);
  assert.throws(() => decryptSecret(enc, AUTRE_KEY));
});
check("un octet du chiffré modifié → lève", () => {
  const [v, iv, tag, data] = encryptSecret(TOKEN, KEY).split(":");
  const buf = Buffer.from(data, "base64");
  buf[0] ^= 0x01;
  assert.throws(() => decryptSecret([v, iv, tag, buf.toString("base64")].join(":"), KEY));
});
check("tag d'authentification modifié → lève", () => {
  const [v, iv, tag, data] = encryptSecret(TOKEN, KEY).split(":");
  const buf = Buffer.from(tag, "base64");
  buf[0] ^= 0x01;
  assert.throws(() => decryptSecret([v, iv, buf.toString("base64"), data].join(":"), KEY));
});
check("IV modifié → lève", () => {
  const [v, iv, tag, data] = encryptSecret(TOKEN, KEY).split(":");
  const buf = Buffer.from(iv, "base64");
  buf[0] ^= 0x01;
  assert.throws(() => decryptSecret([v, buf.toString("base64"), tag, data].join(":"), KEY));
});
check("format tronqué → lève", () => {
  assert.throws(() => decryptSecret("v1:abc:def", KEY), /format invalide/);
});
check("version inconnue → lève", () => {
  const enc = encryptSecret(TOKEN, KEY).replace(/^v1:/, "v2:");
  assert.throws(() => decryptSecret(enc, KEY), /version inconnue/);
});
check("valeur vide/absente → lève", () => {
  assert.throws(() => decryptSecret("", KEY), /manquante/);
  assert.throws(() => decryptSecret(null, KEY), /manquante/);
});

console.log("\n🔑 Validation de la clé maîtresse");
check("clé absente → message actionnable", () => {
  const saved = process.env.TENANT_SECRET_KEY;
  delete process.env.TENANT_SECRET_KEY;
  try {
    assert.throws(() => getMasterKey(), /TENANT_SECRET_KEY absente/);
  } finally {
    if (saved !== undefined) process.env.TENANT_SECRET_KEY = saved;
  }
});
check("phrase de passe au lieu d'une clé 32 octets → refus explicite", () => {
  const passphrase = Buffer.from("mon-mot-de-passe").toString("base64");
  assert.throws(() => getMasterKey(passphrase), /32 attendus/);
});
check("clé de 32 octets → acceptée", () => {
  assert.strictEqual(getMasterKey(crypto.randomBytes(32).toString("base64")).length, 32);
});
check("la clé est lue depuis l'environnement si non fournie", () => {
  const saved = process.env.TENANT_SECRET_KEY;
  process.env.TENANT_SECRET_KEY = KEY;
  try {
    assert.strictEqual(decryptSecret(encryptSecret(TOKEN), ), TOKEN);
  } finally {
    if (saved === undefined) delete process.env.TENANT_SECRET_KEY;
    else process.env.TENANT_SECRET_KEY = saved;
  }
});

console.log(`\n${"═".repeat(40)}`);
console.log(`Résultat crypto : ${passed} ✅ / ${failed} ❌`);
if (failed > 0) process.exit(1);
console.log("Chiffrement des secrets clients : OK ✨");
