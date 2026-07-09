/**
 * Tests du fix "Je n'ai pas bien saisi" en boucle (constaté en prod le 08/07/2026) :
 * un routage LLM rejeté (cible inventée, confiance basse) jetait intent + plaque
 * et tombait dans le fallback final. Rejoue les 3 messages des captures d'écran.
 */
const assert = require("assert");
const { parseRoutingInstruction } = require("../lib/intent-router");
const { detectIntent } = require("../lib/intent-detector");
const { extractAndValidatePlate } = require("../lib/plate-extractor");

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); passed++; }
  catch (e) { console.error(`  ❌ ${label} — ${e.message}`); failed++; }
}

console.log("🧪 parseRoutingInstruction — dégradation au lieu de null");

check("cible inventée (QUOTE_CONFIRMED) + intent valide → rabattu sur WAITING_PLATE", () => {
  const r = parseRoutingInstruction({ type: "route", target: "QUOTE_CONFIRMED", intent: "REPROG", data: { plate: "DG-831-EQ" }, confidence: 0.85 });
  assert(r, "ne doit plus retourner null");
  assert.strictEqual(r.target, "WAITING_PLATE");
  assert.strictEqual(r.intent, "REPROG");
  assert.strictEqual(r.data.plate, "DG-831-EQ", "la plaque doit être conservée");
});

check("cible inventée + intent SAV → rabattu sur SAV_TOPIC", () => {
  const r = parseRoutingInstruction({ type: "route", target: "TICKET_DONE", intent: "SAV", data: {}, confidence: 0.8 });
  assert(r);
  assert.strictEqual(r.target, "SAV_TOPIC");
});

check("cible invalide ET intent invalide → null (rien d'exploitable)", () => {
  const r = parseRoutingInstruction({ type: "route", target: "FOO", intent: "BAR", data: {} });
  assert.strictEqual(r, null);
});

check("cible valide + confiance sous le plancher d'état → cap existant conservé", () => {
  const r = parseRoutingInstruction({ type: "route", target: "WAITING_QUOTE_CONFIRM", intent: "REPROG", data: { plate: "AB-123-CD" }, confidence: 0.6 });
  assert(r);
  assert.strictEqual(r.target, "WAITING_PLATE", "0.6 < plancher 0.8 de WAITING_QUOTE_CONFIRM → cap");
});

console.log("🧪 detectIntent — phrases de gain de puissance (capture 2)");

check("'Je voudrais augmenter la puissance du moteur' → REPROG", () => {
  assert.strictEqual(detectIntent("Je voudrais augmenter la puissance du moteur"), "REPROG");
});
check("'je veux plus de puissance' → REPROG", () => {
  assert.strictEqual(detectIntent("je veux plus de puissance"), "REPROG");
});
check("'perte de puissance' ≠ REPROG (symptôme → LLM/DIAG)", () => {
  assert.notStrictEqual(detectIntent("j'ai une perte de puissance sur autoroute"), "REPROG");
});

console.log("🧪 Filet plaque seule (captures 1 & 3)");

check("'Merci DG-831-EQ' → plaque extraite et valide", () => {
  const p = extractAndValidatePlate("Merci\nDG-831-EQ");
  assert(p?.valid && p?.plate, "plaque attendue");
});
check("'DG-831-EQ' seul → plaque extraite et valide", () => {
  const p = extractAndValidatePlate("DG-831-EQ");
  assert(p?.valid && p?.plate);
});
check("message sans plaque → filet inactif", () => {
  const p = extractAndValidatePlate("bonjour je voudrais des infos");
  assert(!(p?.valid && p?.plate));
});

console.log("🧪 detectIntentLoose — filet dégradé quand le LLM est indisponible (capture 09/07)");

const { detectIntentLoose } = require("../lib/intent-detector");

// Bug prod : "j'ai un problème d'AD blue" → askLLM null (réseau) → 2x "je n'ai pas
// bien saisi". Le filet souple route désormais vers le flow AdBlue.
check("'Bonjour j'ai un problème d'AD blue…' → ADBLUE (souple)", () => {
  assert.strictEqual(detectIntentLoose("Bonjour j'ai un problème d'AD blue. Est-ce que vous pouvez m'aider ?"), "ADBLUE");
});
check("… mais detectIntent STRICT reste null (une question va au LLM en temps normal)", () => {
  assert.strictEqual(detectIntent("Bonjour j'ai un problème d'AD blue. Est-ce que vous pouvez m'aider ?"), null);
});
check("'la reprog c'est fiable ?' → REPROG en souple (route si LLM mort)", () => {
  assert.strictEqual(detectIntentLoose("la reprog c'est fiable ?"), "REPROG");
});
check("anti-overfitting : 'ma voiture est en panne' → null même en souple", () => {
  assert.strictEqual(detectIntentLoose("ma voiture est en panne"), null);
});
check("anti-overfitting : 'bonjour' → null en souple", () => {
  assert.strictEqual(detectIntentLoose("bonjour"), null);
});
check("SAV préservé en souple : 'problème depuis la reprog' → SAV", () => {
  assert.strictEqual(detectIntentLoose("j'ai un problème depuis la reprog"), "SAV");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
process.exit(failed === 0 ? 0 : 1);
