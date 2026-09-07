const express = require("express");

/**
 * Chat du SITE (fenêtre de discussion de la page d'accueil).
 *
 * Le navigateur n'appelle JAMAIS cette route : le site passe par son propre
 * relais `/api/chat`, qui valide, applique un quota par visiteur et ajoute le
 * jeton. Ici, l'appelant est donc toujours un serveur.
 *
 * Contrat (identique à `lib/chat.ts` côté site) :
 *   POST /web-chat
 *   Authorization: Bearer $WEB_CHAT_TOKEN
 *   { "messages": [ { "role": "user"|"assistant", "content": "…" } ] }
 *   → 200 { "reply": "…" }
 *
 * Périmètre volontairement limité au « cerveau » : RAG + LLM. Les flux
 * WhatsApp (devis chiffré, prise de RDV, SAV, PDF, boutons) ne sont PAS
 * exposés ici — ils reposent sur l'envoi de plusieurs messages et sur des
 * composants interactifs qui n'existent pas dans une fenêtre web. Quand le
 * LLM détecte une de ces intentions, on renvoie une invitation à poursuivre
 * sur WhatsApp, où le fil du visiteur est repris automatiquement.
 *
 * Rien n'est écrit en base : les mentions légales du site affirment que ces
 * échanges ne sont pas enregistrés.
 */

/** Bornes alignées sur celles du site (lib/chat.ts). */
const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY = 30;

/**
 * Plafond de coût, tous appelants confondus.
 *
 * Ce n'est PAS un quota par visiteur : le site en applique déjà un (30
 * messages / 10 min par visiteur). Celui-ci protège la facture Anthropic si
 * ce garde-fou saute ou si le jeton fuite. Le dupliquer par « session »
 * donnerait une fausse assurance, l'identifiant venant du client.
 */
const GLOBAL_MAX_CALLS = 120;
const GLOBAL_WINDOW_MS = 60_000;

/**
 * Retire la mise en forme WhatsApp d'une réponse.
 *
 * Le prompt l'interdit déjà sur ce canal, mais un modèle finit toujours par
 * glisser un `*gras*` — et la fenêtre du site l'afficherait tel quel,
 * astérisques comprises. Ce filet est déterministe, l'instruction ne l'est pas.
 *
 * Seules les PAIRES sur une même ligne sont retirées : un astérisque isolé
 * (multiplication, note de bas de page) et un underscore dans un mot restent
 * intacts.
 */
function stripWhatsAppMarkdown(text) {
  return text
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, "$1$2")
    .replace(/~([^~\n]+)~/g, "$1");
}

/** Réponse quand le LLM part sur un flux que le web ne sait pas jouer. */
const HANDOFF_REPLY =
  "Pour aller jusqu'au devis chiffré et au rendez-vous, le plus simple est de " +
  "poursuivre sur WhatsApp : j'y récupère votre demande et je vous réponds " +
  "avec une estimation. Le bouton se trouve juste en dessous de cette conversation.";

/**
 * @param {{ log: object, askLLM: Function }} deps
 * @returns {express.Router}
 */
function createWebChatRouter({ log, askLLM }) {
  const router = express.Router();

  const WEB_CHAT_TOKEN = process.env.WEB_CHAT_TOKEN || null;

  let callTimestamps = [];

  function overGlobalLimit() {
    const now = Date.now();
    callTimestamps = callTimestamps.filter((t) => now - t < GLOBAL_WINDOW_MS);
    if (callTimestamps.length >= GLOBAL_MAX_CALLS) return true;
    callTimestamps.push(now);
    return false;
  }

  /** Valide le corps de la requête. Renvoie `{ messages }` ou `{ error }`. */
  function parseBody(body) {
    if (!body || typeof body !== "object") return { error: "corps invalide" };

    const { messages } = body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return { error: "messages manquant" };
    }
    if (messages.length > MAX_HISTORY) {
      return { error: "fil trop long" };
    }

    for (const m of messages) {
      if (!m || typeof m !== "object") return { error: "message invalide" };
      if (m.role !== "user" && m.role !== "assistant") return { error: "rôle invalide" };
      if (typeof m.content !== "string") return { error: "contenu invalide" };
      const trimmed = m.content.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
        return { error: "contenu vide ou trop long" };
      }
    }

    return { messages: messages.map((m) => ({ role: m.role, content: m.content.trim() })) };
  }

  router.post("/web-chat", async (req, res) => {
    // Refus explicite si le jeton n'est pas configuré : sans ce garde, une
    // comparaison `undefined === undefined` ouvrirait la route à tous.
    if (!WEB_CHAT_TOKEN) {
      log.error("[web-chat] WEB_CHAT_TOKEN non configuré — route fermée.");
      return res.status(503).json({ error: "unconfigured" });
    }
    if (req.headers.authorization !== `Bearer ${WEB_CHAT_TOKEN}`) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const parsed = parseBody(req.body);
    if (parsed.error) {
      log.warn("[web-chat] Requête rejetée", { reason: parsed.error });
      return res.status(400).json({ error: "bad_request" });
    }

    if (overGlobalLimit()) {
      log.error("[web-chat] Plafond global atteint — trafic anormal.");
      return res.status(429).json({ error: "rate_limited" });
    }

    // Le dernier message du visiteur est la question ; ce qui précède est le
    // contexte. Un fil se terminant par un message assistant n'a rien à
    // demander au modèle.
    const messages = parsed.messages;
    const last = messages[messages.length - 1];
    if (last.role !== "user") {
      return res.status(400).json({ error: "bad_request" });
    }

    try {
      // `waId` à null : aucun accès Supabase lié à une conversation WhatsApp.
      // L'historique vient du fil transmis par le site.
      const result = await askLLM(last.content, null, {
        history: messages.slice(0, -1),
        channel: "web",
      });

      if (!result) {
        log.warn("[web-chat] askLLM n'a rien renvoyé");
        return res.status(503).json({ error: "llm_unavailable" });
      }

      if (result.type === "answer" && typeof result.message === "string" && result.message.trim()) {
        return res.json({ reply: stripWhatsAppMarkdown(result.message.trim()) });
      }

      // `intent` / `route` : le modèle a reconnu une demande transactionnelle.
      // Sur WhatsApp, un flux prendrait le relais ; ici il n'y en a pas, donc
      // on bascule plutôt que de laisser le visiteur sans réponse.
      log.info("[web-chat] Bascule WhatsApp", { type: result.type, intent: result.intent || null });
      const lead = typeof result.message === "string" && result.message.trim()
        ? `${stripWhatsAppMarkdown(result.message.trim())}\n\n`
        : "";
      return res.json({ reply: `${lead}${HANDOFF_REPLY}` });
    } catch (err) {
      log.error("[web-chat] Échec de l'appel LLM", { error: String(err?.message || err) });
      return res.status(500).json({ error: "internal" });
    }
  });

  return router;
}

module.exports = { createWebChatRouter, stripWhatsAppMarkdown, MAX_MESSAGE_LENGTH, MAX_HISTORY, HANDOFF_REPLY };
