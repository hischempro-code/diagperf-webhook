/**
 * Tests de vérification de signature Meta (lib/signature.js).
 *
 * Prouve qu'une signature valide est ACCEPTÉE et que toute altération
 * (mauvais secret, corps modifié, en-tête absent/tronqué) est REJETÉE.
 * C'est le filet qui donne confiance avant d'activer VERIFY_SIGNATURE=true
 * en prod : si le secret Render est faux, ces tests montrent que le bot
 * rejetterait TOUT (→ muet) — donc on vérifie le secret AVANT d'activer.
 */
const assert = require("assert");
const crypto = require("crypto");
const { verifyMetaSignature } = require("../lib/signature");

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}\n     ${err.message}`); }
}

const SECRET = "test_app_secret_123";
const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "33600000000", text: { body: "bonjour" } }] } }] }] }), "utf8");
const sign = (buf, secret) => "sha256=" + crypto.createHmac("sha256", secret).update(buf).digest("hex");

console.log("\n🔐 Signature valide → acceptée");
check("HMAC correct sur le corps brut → ok:true", () => {
  const r = verifyMetaSignature(body, sign(body, SECRET), SECRET);
  assert.strictEqual(r.ok, true, `attendu ok:true, obtenu ${JSON.stringify(r)}`);
});

console.log("\n🚫 Altérations → rejetées");
check("mauvais secret → rejeté", () => {
  const r = verifyMetaSignature(body, sign(body, "mauvais_secret"), SECRET);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "bad_signature");
});
check("corps modifié d'un octet → rejeté", () => {
  const goodSig = sign(body, SECRET);
  const tampered = Buffer.concat([body, Buffer.from("x")]);
  const r = verifyMetaSignature(tampered, goodSig, SECRET);
  assert.strictEqual(r.ok, false);
});
check("en-tête signature absent → missing_signature_header", () => {
  const r = verifyMetaSignature(body, null, SECRET);
  assert.deepStrictEqual(r, { ok: false, reason: "missing_signature_header" });
});
check("META_APP_SECRET absent → missing_META_APP_SECRET", () => {
  const r = verifyMetaSignature(body, sign(body, SECRET), null);
  assert.deepStrictEqual(r, { ok: false, reason: "missing_META_APP_SECRET" });
});
check("corps brut absent → missing_raw_body", () => {
  const r = verifyMetaSignature(null, sign(body, SECRET), SECRET);
  assert.deepStrictEqual(r, { ok: false, reason: "missing_raw_body" });
});
check("signature tronquée (même préfixe) → rejetée", () => {
  const good = sign(body, SECRET);
  const r = verifyMetaSignature(body, good.slice(0, 40), SECRET);
  assert.strictEqual(r.ok, false);
});
check("signature rallongée → rejetée", () => {
  const good = sign(body, SECRET);
  const r = verifyMetaSignature(body, good + "00", SECRET);
  assert.strictEqual(r.ok, false);
});
check("en-tête sans préfixe 'sha256=' → rejeté", () => {
  const hexOnly = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const r = verifyMetaSignature(body, hexOnly, SECRET);
  assert.strictEqual(r.ok, false);
});

console.log("\n🧪 Non-régression : identique au corps re-sérialisé ≠ corps brut");
check("re-sérialiser le JSON change les octets → signature invalide", () => {
  // Simule le piège classique : signer le JSON.stringify(req.body) au lieu de req.rawBody.
  // Meta signe les octets EXACTS reçus ; un espace de sérialisation en plus casse tout.
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString())) + " ", "utf8");
  const r = verifyMetaSignature(reserialized, sign(body, SECRET), SECRET);
  assert.strictEqual(r.ok, false);
});

console.log(`\n${"═".repeat(40)}`);
console.log(`Résultat : ${passed} ✅ / ${failed} ❌`);
if (failed > 0) process.exit(1);
console.log("Signature Meta : accept/reject prouvés ✨");
