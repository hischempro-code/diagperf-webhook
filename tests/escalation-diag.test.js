/**
 * Escalade : une urgence TECHNIQUE (panne, voyant) sans colère doit proposer un
 * diagnostic (bouton menu_6) au lieu de basculer direct en rappel humain.
 * Une vraie frustration (insultes, colère) garde l'escalade humaine.
 */
const assert = require("assert");
const { initEventHandlers, handleFrustrationEscalation } = require("../lib/event-handlers");

let passed = 0, failed = 0;
function check(label, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✅ ${label}`); passed++; })
    .catch(e => { console.error(`  ❌ ${label} — ${e.message}`); failed++; });
}

// Harnais : capture les boutons envoyés
function makeHandlers() {
  const sent = [];
  const noop = () => {};
  const asyncNoop = async () => {};
  initEventHandlers({
    log: { info: noop, warn: noop, error: noop, debug: noop },
    supabase: {},
    sendWhatsAppText: asyncNoop,
    sendWhatsAppInteractiveButtons: async (to, body, buttons) => { sent.push({ body, ids: (buttons || []).map(b => b.id) }); },
    setConversationState: asyncNoop,
    clearConversationState: asyncNoop,
    getConversationState: async () => null,
    sendMenuList: asyncNoop,
  });
  return { sent };
}
const txt = { type: "text", text: { body: "" } };

(async () => {
  console.log("🧪 Urgence technique (panne / voyant) → propose un diagnostic");
  {
    const { sent } = makeHandlers();
    const handled = await handleFrustrationEscalation("33600000001", "ma voiture ne démarre plus, voyant rouge allumé", txt);
    await check("escalade déclenchée", () => assert.strictEqual(handled, true));
    await check("bouton Diagnostic (menu_6) proposé", () => assert.ok(sent.some(m => m.ids.includes("menu_6")), JSON.stringify(sent)));
    await check("PAS de bouton 'continuer ici' (escalade humaine directe évitée)", () => assert.ok(!sent.some(m => m.ids.includes("escalate_continue"))));
    await check("option rappel conservée en second choix", () => assert.ok(sent.some(m => m.ids.includes("escalate_callback"))));
  }

  console.log("🧪 'en panne' seul → diagnostic proposé");
  {
    const { sent } = makeHandlers();
    await handleFrustrationEscalation("33600000002", "bonjour je suis en panne", txt);
    await check("Diagnostic proposé", () => assert.ok(sent.some(m => m.ids.includes("menu_6"))));
  }

  console.log("🧪 Vraie colère (insultes) → escalade humaine, PAS de diagnostic");
  {
    const { sent } = makeHandlers();
    const handled = await handleFrustrationEscalation("33600000003", "c'est de l'arnaque, bande de voleurs, je vais porter plainte", txt);
    await check("escalade déclenchée", () => assert.strictEqual(handled, true));
    await check("escalade humaine (continuer ici présent)", () => assert.ok(sent.some(m => m.ids.includes("escalate_continue"))));
    await check("PAS de bouton diagnostic", () => assert.ok(!sent.some(m => m.ids.includes("menu_6"))));
  }

  console.log("🧪 Message neutre → pas d'escalade du tout");
  {
    const { sent } = makeHandlers();
    const handled = await handleFrustrationEscalation("33600000004", "je voudrais une reprogrammation stage 1", txt);
    await check("pas d'escalade", () => assert.strictEqual(handled, false));
    await check("aucun bouton envoyé", () => assert.strictEqual(sent.length, 0));
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
  process.exit(failed === 0 ? 0 : 1);
})();
