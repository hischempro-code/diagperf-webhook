/**
 * Tests de l'audit anti garde-fous (09/07/2026) : confirmations naturelles,
 * refus naturels, et questions jamais prises pour des confirmations.
 */
const assert = require("assert");
const { isConfirmation, isDenial } = require("../lib/text-helpers");
const { isLikelyQuestion } = require("../lib/llm-service");

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); passed++; }
  catch (e) { console.error(`  ❌ ${label} — ${e.message}`); failed++; }
}

console.log("🧪 isConfirmation — formulations naturelles");
check("'oui' → true", () => assert.strictEqual(isConfirmation("oui"), true));
check("'oui merci' → true", () => assert.strictEqual(isConfirmation("oui merci"), true));
check("'ouiii' → true", () => assert.strictEqual(isConfirmation("ouiii"), true));
check("'ok super' → true", () => assert.strictEqual(isConfirmation("ok super"), true));
check("'Oui c'est parfait' → true", () => assert.strictEqual(isConfirmation("Oui c'est parfait"), true));
check("'oui mais c'est cher' → false (réserve)", () => assert.strictEqual(isConfirmation("oui mais c'est cher"), false));
check("'oui ?' → false (question)", () => assert.strictEqual(isConfirmation("oui ?"), false));
check("'c'est bon ?' → false (question)", () => assert.strictEqual(isConfirmation("c'est bon ?"), false));
check("'oui pas maintenant' → false", () => assert.strictEqual(isConfirmation("oui pas maintenant"), false));

console.log("🧪 isDenial — formulations naturelles");
check("'non' → true", () => assert.strictEqual(isDenial("non"), true));
check("'non merci' → true", () => assert.strictEqual(isDenial("non merci"), true));
check("'non mais attends' → false (nuance)", () => assert.strictEqual(isDenial("non mais attends"), false));
check("'non ?' → false (question)", () => assert.strictEqual(isDenial("non ?"), false));

console.log("🧪 isLikelyQuestion — questions courtes (guards plaque/description)");
check("'prix ?' → true", () => assert.strictEqual(isLikelyQuestion("prix ?"), true));
check("'c'est gratuit le SAV ?' → true", () => assert.strictEqual(isLikelyQuestion("c'est gratuit le SAV ?"), true));
check("'AA-123-BB' → false (plaque, pas une question)", () => assert.strictEqual(isLikelyQuestion("AA-123-BB"), false));

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
process.exit(failed === 0 ? 0 : 1);
