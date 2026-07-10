/**
 * Cause racine (logs prod 09/07) : le LLM répond souvent en TEXTE BRUT au lieu du JSON
 * demandé → "LLM JSON parse failed" → askLLM null → fallback déterministe qui MAL-ROUTE
 * (voyant AdBlue → flow EGR). Fix : un texte non-JSON est traité comme une réponse "answer".
 */
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "sk-test-dummy";
const assert = require("assert");
const { initLlmService, askLLM } = require("../lib/llm-service");

let passed = 0, failed = 0;
function check(label, fn) {
  return Promise.resolve().then(fn)
    .then(() => { console.log(`  ✅ ${label}`); passed++; })
    .catch(e => { console.error(`  ❌ ${label} — ${e.message}`); failed++; });
}

// Init avec un LLM mocké renvoyant un contenu configurable ; DB/RAG échouent (cachés)
function initWithLlmReply(replyText) {
  initLlmService({
    supabase: { from: () => { throw new Error("no-db"); } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    fetchFn: async (url) => {
      if (String(url).includes("anthropic.com")) {
        return { ok: true, json: async () => ({ content: [{ text: replyText }], usage: {} }) };
      }
      throw new Error("no-net"); // embeddings etc. → échec caché
    },
    getRecentMessages: async () => [],
    getConversationState: async () => null,
  });
}

(async () => {
  console.log("🧪 Réponse LLM en TEXTE BRUT → traitée comme answer (plus jetée)");
  {
    initWithLlmReply("Pas de panique ! 🟢 Un voyant AdBlue fixe signale un défaut du système SCR (capteur NOx, pompe...).");
    const r = await askLLM("j'ai un voyant adblue au tableau de bord", "33600000000");
    await check("askLLM ne renvoie PLUS null", () => assert.ok(r, "askLLM a renvoyé null"));
    await check("type = answer", () => assert.strictEqual(r.type, "answer"));
    await check("le message texte est conservé", () => assert.ok(/voyant AdBlue/i.test(r.message)));
  }

  console.log("🧪 Réponse JSON normale → toujours parsée correctement");
  {
    initWithLlmReply('{"type":"answer","message":"Bonjour, comment puis-je vous aider ?"}');
    const r = await askLLM("bonjour", "33600000001");
    await check("type = answer", () => assert.strictEqual(r.type, "answer"));
    await check("message JSON extrait", () => assert.strictEqual(r.message, "Bonjour, comment puis-je vous aider ?"));
  }

  console.log("🧪 JSON dans du texte parasite → toujours extrait");
  {
    initWithLlmReply('Voici ma réponse : {"type":"intent","intent":"ADBLUE"} voilà');
    const r = await askLLM("je veux une suppression adblue", "33600000002");
    await check("intent ADBLUE extrait malgré le texte autour", () => assert.ok(r && r.type === "intent" && r.intent === "ADBLUE"));
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
  process.exit(failed === 0 ? 0 : 1);
})();
