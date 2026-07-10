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

  console.log("🧪 JSON TRONQUÉ (max_tokens) → salvage au lieu de null");
  {
    // answer coupé en plein vol : le message partiel est récupéré, coupé à la dernière phrase
    initWithLlmReply('{"type":"answer","message":"Un voyant AdBlue fixe signale un défaut du système SCR. Pas de panique ! Il faut le trai');
    const r = await askLLM("voyant adblue", "33600000010");
    await check("answer tronqué → salvage (plus null)", () => assert.ok(r, "askLLM a renvoyé null"));
    await check("message coupé à la dernière phrase complète", () => assert.ok(r.message.endsWith("!") || r.message.endsWith("."), "fin: " + r.message.slice(-30)));
    await check("le début du message est conservé", () => assert.ok(/voyant AdBlue fixe/i.test(r.message)));
  }
  {
    // route coupé : l'intent complet est récupéré → dégradé en intent
    initWithLlmReply('{"type":"route","target":"WAITING_QUOTE_CONFIRM","intent":"ADBLUE","data":{"plate":"BB-8');
    const r = await askLLM("je veux la suppression adblue sur ma BB-820-QV", "33600000011");
    await check("route tronqué → intent récupéré", () => assert.ok(r && r.type === "intent" && r.intent === "ADBLUE", JSON.stringify(r)));
  }
  {
    // JSON tronqué inexploitable (ni intent ni message assez long) → null (comportement sûr)
    initWithLlmReply('{"type":"answ');
    const r = await askLLM("test", "33600000012");
    await check("tronqué inexploitable → null (pas de contenu inventé)", () => assert.strictEqual(r, null));
  }

  console.log("🧪 Filtre anti-faux-devis (le LLM invente un devis en texte)");
  {
    // Une SEULE prestation citée → routé vers le vrai flow (intent)
    initWithLlmReply('{"type":"answer","message":"Voici le devis correct :\\n✅ Devis généré\\nRéf : DEV-235\\nPrestation : Suppression AdBlue\\nTotal TTC : 260€"}');
    const r = await askLLM("je veux l'adblue", "33600000020");
    await check("faux devis (1 presta) → converti en intent", () => assert.ok(r && r.type === "intent", JSON.stringify(r)));
    await check("intent = ADBLUE (le vrai flow générera le vrai devis)", () => assert.strictEqual(r.intent, "ADBLUE"));
    await check("aucun 'DEV-235' inventé renvoyé", () => assert.ok(!/DEV-235/.test(JSON.stringify(r))));
  }
  {
    // Prestations ambiguës → message sûr, pas de faux devis
    initWithLlmReply('{"type":"answer","message":"✅ Devis généré Réf : DEV-99 — vous vouliez AdBlue pas EGR, TTC 260€"}');
    const r = await askLLM("adblue pas egr", "33600000021");
    await check("faux devis (ambigu) → answer sûr", () => assert.ok(r && r.type === "answer"));
    await check("message ne contient PAS de DEV-xx", () => assert.ok(!/DEV-\d/.test(r.message), r.message));
  }
  {
    // Réponse normale mentionnant "devis gratuit" → PAS filtrée (faux positif évité)
    initWithLlmReply('{"type":"answer","message":"Bien sûr, le devis est gratuit et sans engagement !"}');
    const r = await askLLM("le devis est gratuit ?", "33600000022");
    await check("'devis gratuit' n'est PAS filtré", () => assert.ok(r && r.type === "answer" && /gratuit/.test(r.message)));
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} réussis, ${failed} échoués`);
  process.exit(failed === 0 ? 0 : 1);
})();
