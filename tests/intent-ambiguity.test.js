/**
 * Bug prod (09/07, captures) : client à qui on a proposé un devis EGR alors qu'il
 * veut de l'AdBlue. Quand il corrige "vous m'avez proposé EGR et moi je veux AdBlue",
 * detectIntent prenait EGR (1er du map contenant "egr") → client bloqué sur EGR.
 * Fix : plusieurs prestations mentionnées → ambigu ; detectIntentsAll capte la vraie.
 */
const assert = require("assert");
const { detectIntent, detectIntentLoose, detectIntentsAll } = require("../lib/intent-detector");

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log(`  ✅ ${label}`); passed++; }
  catch (e) { console.error(`  ❌ ${label} — ${e.message}`); failed++; }
}

console.log("🧪 detectIntent — un seul intent reste fiable");
check("'je veux une suppression adblue' → ADBLUE", () => assert.strictEqual(detectIntent("je veux une suppression adblue"), "ADBLUE"));
check("'reprogrammation stage 1' → REPROG", () => assert.strictEqual(detectIntent("reprogrammation stage 1"), "REPROG"));
check("'suppression egr' → EGR", () => assert.strictEqual(detectIntent("suppression egr"), "EGR"));

console.log("🧪 detectIntent — DEUX prestations mentionnées → ambigu (null), plus de choix arbitraire");
check("'vous m'avez proposé egr et moi je veux adblue' → null (avant: EGR)", () => {
  assert.strictEqual(detectIntent("vous m'avez proposé un devis de suppression egr et moi j'ai un problème adblue"), null);
});
check("'egr ou fap ?' → null", () => assert.strictEqual(detectIntent("egr ou fap ?"), null));

console.log("🧪 detectIntentsAll — liste toutes les prestations (pour la correction mid-flow)");
check("egr + adblue → ['EGR','ADBLUE']", () => {
  const r = detectIntentsAll("vous m'avez proposé egr et moi je veux adblue");
  assert.deepStrictEqual(r.sort(), ["ADBLUE", "EGR"]);
});
check("correction : retirer l'intent courant EGR → reste ADBLUE", () => {
  const r = detectIntentsAll("vous m'avez proposé egr et moi je veux adblue").filter(i => i !== "EGR");
  assert.deepStrictEqual(r, ["ADBLUE"]);
});
check("une question ('adblue c'est quoi ?') → [] (pas de switch sur question)", () => {
  assert.deepStrictEqual(detectIntentsAll("adblue c'est quoi ?"), []);
});
check("un seul intent → correction directe : ['ADBLUE'] moins EGR courant = ADBLUE", () => {
  const r = detectIntentsAll("finalement je préfère l'adblue").filter(i => i !== "EGR");
  assert.deepStrictEqual(r, ["ADBLUE"]);
});

console.log("🧪 detectIntentLoose — même règle multi-intent");
check("'egr et adblue' → null (ambigu)", () => assert.strictEqual(detectIntentLoose("egr et adblue"), null));
check("'problème adblue' → ADBLUE (un seul)", () => assert.strictEqual(detectIntentLoose("j'ai un problème adblue"), "ADBLUE"));

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
process.exit(failed === 0 ? 0 : 1);
