/**
 * Tests de la route du chat du site (routes/web-chat.js).
 *
 * Cette route expose le « cerveau » du bot (RAG + LLM) à la fenêtre de
 * discussion du site. Trois choses doivent être prouvées avant de la laisser
 * en production :
 *
 *  1. Elle est FERMÉE tant que WEB_CHAT_TOKEN n'est pas défini, et refuse un
 *     mauvais jeton — sinon n'importe qui consomme les jetons du modèle.
 *  2. Elle ne transmet JAMAIS d'identifiant WhatsApp à askLLM, et lui passe
 *     l'historique reçu. C'est ce qui garantit qu'aucune conversation web
 *     n'est lue ni écrite en base, comme l'affirment les mentions légales.
 *  3. Une intention transactionnelle (devis, RDV) bascule sur WhatsApp au
 *     lieu de laisser le visiteur sans réponse, les flux correspondants
 *     n'existant pas côté web.
 *
 * askLLM est remplacé par un faux : ces tests ne doivent ni appeler
 * Anthropic, ni toucher Supabase.
 */
const assert = require("assert");
const http = require("http");
const express = require("express");
const { createWebChatRouter, HANDOFF_REPLY, MAX_HISTORY } = require("../routes/web-chat");

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.error(`  ❌ ${name}\n     ${err.message}`); }
}

const silentLog = { info() {}, warn() {}, error() {} };

/** Démarre un serveur jetable sur un port libre et renvoie une fonction post(). */
function startServer(askLLM) {
  const app = express();
  app.use(express.json());
  app.use(createWebChatRouter({ log: silentLog, askLLM }));
  const server = http.createServer(app);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        post(body, token) {
          return new Promise((res, rej) => {
            const payload = JSON.stringify(body);
            const req = http.request({
              host: "127.0.0.1", port, path: "/web-chat", method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            }, (r) => {
              let data = "";
              r.on("data", (c) => { data += c; });
              r.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* corps non JSON */ }
                res({ status: r.statusCode, body: json });
              });
            });
            req.on("error", rej);
            req.end(payload);
          });
        },
      });
    });
  });
}

const thread = (...contents) => ({
  messages: contents.map((c, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: c })),
});

(async () => {
  // ====== 1. Fermeture et authentification ======
  console.log("\n🔐 Jeton");

  {
    delete process.env.WEB_CHAT_TOKEN;
    const { server, post } = await startServer(async () => ({ type: "answer", message: "ok" }));

    await check("sans WEB_CHAT_TOKEN → 503, la route reste fermée", async () => {
      const r = await post(thread("bonjour"), "peu-importe");
      assert.strictEqual(r.status, 503);
    });

    server.close();
  }

  process.env.WEB_CHAT_TOKEN = "jeton-de-test";

  {
    const { server, post } = await startServer(async () => ({ type: "answer", message: "ok" }));

    await check("sans en-tête Authorization → 401", async () => {
      const r = await post(thread("bonjour"), null);
      assert.strictEqual(r.status, 401);
    });

    await check("mauvais jeton → 401", async () => {
      const r = await post(thread("bonjour"), "mauvais");
      assert.strictEqual(r.status, 401);
    });

    await check("bon jeton → 200", async () => {
      const r = await post(thread("bonjour"), "jeton-de-test");
      assert.strictEqual(r.status, 200);
    });

    server.close();
  }

  // ====== 2. Validation du fil ======
  console.log("\n📋 Validation");

  {
    const { server, post } = await startServer(async () => ({ type: "answer", message: "ok" }));
    const T = "jeton-de-test";

    await check("messages absent → 400", async () => {
      assert.strictEqual((await post({}, T)).status, 400);
    });

    await check("rôle inconnu → 400", async () => {
      const r = await post({ messages: [{ role: "system", content: "x" }] }, T);
      assert.strictEqual(r.status, 400);
    });

    await check("message vide → 400", async () => {
      const r = await post({ messages: [{ role: "user", content: "   " }] }, T);
      assert.strictEqual(r.status, 400);
    });

    await check("message de plus de 1000 caractères → 400", async () => {
      const r = await post({ messages: [{ role: "user", content: "a".repeat(1001) }] }, T);
      assert.strictEqual(r.status, 400);
    });

    await check(`fil de plus de ${MAX_HISTORY} messages → 400`, async () => {
      const r = await post(thread(...Array(MAX_HISTORY + 1).fill("x")), T);
      assert.strictEqual(r.status, 400);
    });

    await check("fil se terminant par l'assistant → 400 (rien à demander)", async () => {
      const r = await post(thread("bonjour", "je vous écoute"), T);
      assert.strictEqual(r.status, 400);
    });

    server.close();
  }

  // ====== 3. Ce qui est transmis à askLLM ======
  console.log("\n🧠 Appel du modèle");

  {
    let recu = null;
    const { server, post } = await startServer(async (msg, waId, options) => {
      recu = { msg, waId, options };
      return { type: "answer", message: "Le stage 1 apporte 15 à 30 % de puissance." };
    });

    await post(thread("bonjour", "je vous écoute", "c'est quoi un stage 1 ?"), "jeton-de-test");

    await check("le dernier message du visiteur est la question posée", () => {
      assert.strictEqual(recu.msg, "c'est quoi un stage 1 ?");
    });

    await check("waId est null → aucun accès Supabase, rien n'est enregistré", () => {
      assert.strictEqual(recu.waId, null);
    });

    await check("l'historique transmis exclut la question courante", () => {
      assert.deepStrictEqual(recu.options.history, [
        { role: "user", content: "bonjour" },
        { role: "assistant", content: "je vous écoute" },
      ]);
    });

    await check('channel vaut "web" → le prompt sait qu\'il n\'est pas sur WhatsApp', () => {
      assert.strictEqual(recu.options.channel, "web");
    });

    server.close();
  }

  // ====== 4. Formes de réponse ======
  console.log("\n💬 Réponses");

  {
    const { server, post } = await startServer(async () => ({ type: "answer", message: "  Bonjour !  " }));
    await check("type answer → le message est renvoyé, espaces retirés", async () => {
      const r = await post(thread("salut"), "jeton-de-test");
      assert.strictEqual(r.body.reply, "Bonjour !");
    });
    server.close();
  }

  {
    const { server, post } = await startServer(async () => ({ type: "route", intent: "REPROG", confidence: 0.95 }));
    await check("type route → bascule WhatsApp au lieu du silence", async () => {
      const r = await post(thread("je veux un devis pour ma Golf 7"), "jeton-de-test");
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.reply, HANDOFF_REPLY);
    });
    server.close();
  }

  {
    const { server, post } = await startServer(async () => ({ type: "intent", intent: "RDV", message: "Très bien." }));
    await check("type intent avec message → message PUIS bascule", async () => {
      const r = await post(thread("je veux un rendez-vous"), "jeton-de-test");
      assert.ok(r.body.reply.startsWith("Très bien."), "le message du modèle doit être conservé");
      assert.ok(r.body.reply.endsWith(HANDOFF_REPLY), "la bascule doit suivre");
    });
    server.close();
  }

  {
    const { server, post } = await startServer(async () => null);
    await check("askLLM indisponible → 503, pas de réponse inventée", async () => {
      const r = await post(thread("bonjour"), "jeton-de-test");
      assert.strictEqual(r.status, 503);
    });
    server.close();
  }

  {
    const { server, post } = await startServer(async () => { throw new Error("boom"); });
    await check("askLLM lève une erreur → 500, le détail reste côté serveur", async () => {
      const r = await post(thread("bonjour"), "jeton-de-test");
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.body.error, "internal");
      assert.ok(!JSON.stringify(r.body).includes("boom"), "le détail ne doit pas fuiter");
    });
    server.close();
  }

  console.log(`\n${"═".repeat(40)}`);
  console.log(`Résultat : ${passed} ✅ / ${failed} ❌`);
  if (failed > 0) process.exit(1);
  console.log("Chat du site : fermeture, validation et bascule prouvées ✨");
})();
