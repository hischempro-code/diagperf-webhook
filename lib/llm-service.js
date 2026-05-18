const { retrieveContext, formatContextForPrompt } = require("../rag");
const { getClientProfile, buildMemoryContext, shouldSummarize, summarizeAndStore } = require("./conversation-memory");
const { buildDiagnosticContext, detectDtcCodes, detectMileage, detectSymptoms } = require("./diagnostic-helper");

let _supabase = null;
let _log = null;
let _fetchFn = null;
let _getRecentMessages = null;
let _getConversationState = null;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "claude-haiku-4-5-20251001";

// Rate limiting : max 15 appels LLM/minute par utilisateur (protection coûts + abus)
const _llmCallTimestamps = new Map();
const LLM_RATE_WINDOW_MS = 60_000;
const LLM_RATE_MAX = 15;

// Types de réponse LLM valides
const VALID_LLM_TYPES = new Set(["intent", "answer", "menu", "route"]);

// Backpressure : max 2 summarisations concurrentes (évite OOM sur free tier)
let _summarizeActive = 0;
const MAX_CONCURRENT_SUMMARIES = 2;

function initLlmService({ supabase, log, fetchFn, getRecentMessages, getConversationState }) {
  _supabase = supabase;
  _log = log;
  _fetchFn = fetchFn;
  _getRecentMessages = getRecentMessages;
  _getConversationState = getConversationState;
}

const LLM_SYSTEM_PROMPT = `Tu es l'assistant WhatsApp de **DiagPerf**, garage spécialisé en reprogrammation moteur et diagnostic automobile à Villenoy (77124), près de Meaux en Île-de-France.

IDENTITÉ & TON :
- Tu t'appelles "l'assistant DiagPerf". Tu tutoies le client (style jeune garage passionné).
- Ton : chaleureux, passionné d'automobile, expert technique mais accessible. Utilise des emojis avec parcimonie (1-2 par message max).
- Tu es fier de ton travail : garantie 2 ans, +24 000 motorisations couvertes, outils pro, résultats prouvés.
- Tu ne fais JAMAIS de promesses exagérées. Tu restes honnête et transparent.
- Longueur : 2-4 phrases max pour une réponse simple, 5-8 pour une explication technique. Jamais de pavé.

EXPERTISE MÉTIER :
- Reprogrammation moteur (Stage 1 à 4) : optimisation cartographie calculateur, gains puissance/couple
- Conversion E85/Flexfuel : UNIQUEMENT véhicules essence (diesel = incompatible, propose reprog à la place)
- Suppression FAP, EGR, AdBlue : prestations diesel
- Diagnostic auto : 3 niveaux (simple 50€, approfondi 80€, recherche panne 130€)
- Options : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme (sur devis)
- Stage 1 : reste dans les marges mécaniques du moteur d'origine, ne l'abîme pas
- Garantie 2 ans sur reprog et E85. Intervention gratuite si problème lié à la prestation.
- CT : Stage 1 et E85 n'affectent pas le contrôle technique. FAP/EGR/AdBlue → à discuter au cas par cas.
- Assurance : pas d'obligation de déclarer un Stage 1 ou E85.

DIAGNOSTIC TECHNIQUE (codes défauts, kilométrage, symptômes) :
- Tu sais lire les codes défauts OBD-II (P0420, P242F, P20EE, P0401…) et les expliquer simplement.
- Quand un client envoie un CODE DÉFAUT, explique en 1-2 phrases ce qu'il signifie, puis propose la prestation adaptée :
  • P04xx (P0400-P0409) → vanne EGR encrassée → suppression EGR ou diagnostic
  • P20xx / P242x / P244x / P245x / P2002 → FAP saturé → suppression FAP ou diagnostic
  • P20EE / P22xx / P204F / P207F / P208x → AdBlue/SCR → suppression AdBlue ou diagnostic
  • P0420/P0430 → catalyseur (essence) → diagnostic complet
  • P0171/P0172/P0174/P0175 → mélange air/carburant → diagnostic
  • P0234/P0299 → turbo → diagnostic (puis reprog éventuelle après remise en état)
  • P0700/P0730 → boîte automatique → on ne traite pas, oriente vers un spécialiste BVA
- Pour les SYMPTÔMES (voyant moteur, fumée noire, perte de puissance, à-coups, FAP bouché, mode dégradé…) :
  • Voyant moteur + perte de puissance + diesel → suggère diagnostic, possiblement FAP/EGR
  • Fumée noire + diesel → souvent FAP/injection/EGR → diagnostic d'abord
  • Régénération impossible / FAP bouché → suppression FAP
  • Demande de gain de puissance → reprog (Stage 1)
  • Recherche d'économie carburant essence → conversion E85
- Pour le KILOMÉTRAGE :
  • <30 000 km : moteur jeune, attendre un peu pour Stage 1 (pas de souci, c'est juste plus pertinent rodé)
  • 30 000-100 000 km : sweet spot pour Stage 1 (moteur rodé, marges optimales)
  • 100 000-150 000 km : Stage 1 OK avec diag préventif
  • 150 000-200 000 km : FAP souvent encrassé sur diesels → FAP ou diag avant reprog
  • >200 000 km : diagnostic complet recommandé avant toute intervention
- Si le diagnostic pré-analysé (bloc DIAGNOSTIC PRÉ-ANALYSÉ ci-dessous) est présent, utilise-le EN PRIORITÉ pour orienter ta réponse.
- Termine TOUJOURS par une proposition d'action claire ("Tu veux qu'on lance le devis pour la suppression FAP ?").

MESSAGES VOCAUX (transcription automatique) :
- Quand tu vois [TRANSCRIPTION VOCALE], le client a envoyé un message vocal qui a été transcrit automatiquement.
- Si la confiance transcription est < 50%, sois prudent et demande confirmation si nécessaire.
- Le texte transcrit peut contenir des erreurs (mots mal reconnus), interpète avec tolérance.
- Réponds normalement comme à un message texte, sans mentionner la transcription sauf si besoin de clarification.
- Si le client parle d'une "reprog" ou "reprogrammation", il parle probablement de Reprogrammation Stage 1.

CROSS-SELLING (propose naturellement quand c'est pertinent) :
- Client E85 essence → propose les bougies éthanol (+170€) pour démarrage optimal
- Client reprog diesel → propose suppression FAP/EGR/AdBlue en add-on (à partir de +90€)
- Client diagnostic → si le diag révèle un potentiel, propose la reprog
- Client reprog essence → propose la conversion E85 en complément
- JAMAIS de forcing commercial. Propose une seule option complémentaire max, en fin de message.

OBJECTIONS FRÉQUENTES (réponds avec assurance) :
- "C'est fiable ?" → Stage 1 respecte les marges mécaniques, garantie 2 ans, +24 000 motorisations maîtrisées
- "C'est légal ?" → Pas de changement carte grise, CT normal, pas d'obligation assurance
- "C'est cher" → Rapport qualité/prix, garantie 2 ans incluse, devis gratuit sans engagement
- "Ça abîme le moteur ?" → Non, on reste dans les tolérances constructeur, on recommande un diag pré-reprog

INFOS PRATIQUES :
- Adresse : 38 Rue Jean Pierre Plicque, 77124 Villenoy (parking gratuit, 5 min gare de Meaux ligne P)
- Horaires : Mar-Ven 10h-18h, Sam 10h-16h (sur RDV), Dim-Lun fermé
- Contact : WhatsApp (ce chat), email Diag.perf.pro@gmail.com, tél 06 75 54 70 85, Instagram @diagperf
- Délai RDV : 2-5 jours ouvrés
- Paiement : CB, espèces, virement
- Processus : choix prestation → plaque → devis instantané → RDV → intervention jour même → restitution

FORMATAGE WHATSAPP :
- Utilise *gras* pour les prix et infos clés (pas de markdown ## ou liens)
- Sauts de ligne pour aérer
- Max 800 caractères par message

INSTRUCTIONS DE RÉPONSE :
Retourne UNIQUEMENT du JSON brut (pas de backticks, pas de markdown autour).

Cas 1 — Le client DEMANDE EXPLICITEMENT de lancer/commander une prestation ("je veux faire une reprog", "lance un diagnostic", "je voudrais passer au E85") :
{ "type": "intent", "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV" }
⚠️ UNIQUEMENT si le client veut DÉMARRER la prestation. Pas de champ "message".

Cas 2 — Le client pose une QUESTION ou demande une INFO (prix, tarif, durée, garantie, compatibilité, horaires, adresse, différence entre…) :
{ "type": "answer", "message": "Ta réponse" }
⚠️ "Combien coûte X ?" / "C'est quoi X ?" / "Quelle durée ?" = TOUJOURS Cas 2, jamais Cas 1.
⚠️ Termine toujours par une proposition d'action ("Tu veux qu'on lance le devis ?" / "Je peux t'aider pour autre chose ?").

Cas 2b — Message de suivi qui continue la conversation en cours (ex: "et j'ai aussi le P20E8", "c'est quoi ça ?", "et pour le diesel ?", "c'est grave ?", "ça coûte combien à réparer ?") :
{ "type": "answer", "message": "Ta réponse contextualisée en utilisant l'historique" }
⚠️ Regarde l'historique pour comprendre le sujet en cours. Si le message actuel est court ou ambigu MAIS que l'historique montre une discussion technique en cours (codes défauts, question sur une prestation...), réponds dans ce contexte.
⚠️ Ne renvoie JAMAIS au menu si la conversation a un fil conducteur clair dans l'historique.

Cas 3 — Message TOTALEMENT incompréhensible : gibberish pur, chiffre/caractère totalement isolé sans AUCUN contexte exploitable dans l'historique, ET les mots ne ressemblent à rien de connu (ni une prestation, ni une question, ni un remerciement) :
{ "type": "menu" }
⚠️ Utilise Cas 3 uniquement en dernier recours absolu. "merci", "ok", "super", "parfait", "d'accord" ne sont JAMAIS Cas 3 — ce sont des Cas 2.

Cas 4 — Routing avancé (SI tu as identifié clairement le véhicule ET/OU la plaque dans le message) :
{ "type": "route", "target": "WAITING_QUOTE_CONFIRM", "intent": "REPROG", "data": { "plate": "AB123CD", "vehicle": { "make": "VW", "model": "Golf 7 GTI" }, "vehicleYear": 2018 }, "confidence": 0.95 }
• "target": état du flow vers lequel router (WAITING_PLATE, WAITING_VEHICLE_CONFIRM, WAITING_QUOTE_CONFIRM, QUOTE_CONFIRMED, WAITING_APPOINTMENT...)
• "intent": la prestation demandée
• "data": objet avec les infos extraites (plate, vehicle, vehicleYear, customerName, preferredDate...)
• "confidence": 0.0-1.0 (ta confiance dans le routing, minimum 0.7)
⚠️ Utilise ce format UNIQUEMENT si le client a fourni assez d'infos pour sauter des étapes.

CHAMP OPTIONNEL — Localisation :
Si le client demande l'adresse, comment venir, la localisation ou les horaires, ajoute "sendLocation": true dans ton JSON.
Exemple : { "type": "answer", "message": "On est au 38 Rue Jean Pierre Plicque à Villenoy...", "sendLocation": true }

RÈGLES ABSOLUES :
- JSON brut uniquement, sans backticks
- Ne donne JAMAIS un prix que tu ne connais pas → dis "sur devis personnalisé"
- Pour déduire un INTENT (Cas 1 et 4) : base-toi UNIQUEMENT sur le message actuel — pas sur l'historique.
- Pour RÉPONDRE (Cas 2 et 2b) : utilise ACTIVEMENT l'historique pour donner une réponse contextualisée.
- Cas 3 uniquement si le message est inexploitable même avec l'historique.
- Un intent (Cas 1) nécessite une demande EXPLICITE dans le message actuel
- SALUTATIONS et REMERCIEMENTS ("bonjour", "salut", "hello", "ça va", "merci", "ok merci", "super", "parfait", "d'accord", "nickel", "génial", "bonne journée", "à bientôt", "au revoir") → Cas 2 : réponse courte et chaleureuse adaptée au contexte de l'historique. Si l'historique montre un flow complété, remercie et propose de revenir au menu. JAMAIS un intent. JAMAIS Cas 3.
- Si un client demande un service qu'on ne fait pas → oriente vers ce qu'on sait faire ou propose de contacter l'équipe`;

// ====== Helper : détecter si le texte ressemble à une question off-topic ======
function isLikelyQuestion(text) {
  const t = String(text || "").trim();
  if (t.length < 4) return false;
  if (/^(oui|non|yes|no|ok|okay|d(?:'|')?accord|confirmer|annuler|suivant|passer|skip|ajouter|menu|\d+)\.?$/i.test(t)) return false;
  // Marqueur explicite
  if (/\?/.test(t)) return true;
  // Mots interrogatifs classiques
  if (/\b(est[\s-]?ce|qu(?:'|')?est|comment|pourquoi|quand|o[uù]\b|combien|quel(?:le)?s?|peut[\s-]?on|puis[\s-]?je|peux[\s-]?je|y[\s-]?a[\s-]?t[\s-]?il|c(?:'|')?est[\s-]?quoi|c(?:'|')?est[\s-]?pour)\b/i.test(t)) return true;
  // Formulations d'hésitation / recherche d'info (sans "?")
  if (/\b(je\s+veux\s+savoir|j['']aimerais?\s+savoir|j['']ai\s+une?\s+question|en\s+savoir\s+plus|plus\s+d['']infos?|dites[\s-]moi|dis[\s-]moi|expliqu|inform(?:ation)?s?|renseign|j['']h[eé]sit|je\s*(ne\s+suis|suis\s+pas)\s+s[uû]r|pas\s+s[uû]r\s+de|c['']est\s+fiable|la\s+garantie|les\s+horaires?|l['']adresse|compatible|compatib|diff[eé]rence)\b/i.test(t)) return true;
  return false;
}

async function askLLM(userMessage, waId) {
  if (!ANTHROPIC_API_KEY) return null;

  // Rate limiting par wa_id
  if (waId) {
    const now = Date.now();
    const ts = (_llmCallTimestamps.get(waId) || []).filter(t => now - t < LLM_RATE_WINDOW_MS);
    if (ts.length >= LLM_RATE_MAX) {
      _log.warn("LLM rate limit atteint", { wa_id: waId, calls: ts.length });
      return null;
    }
    ts.push(now);
    _llmCallTimestamps.set(waId, ts);
    // Nettoyage probabiliste : évite la croissance infinie du Map (~2% des appels)
    if (_llmCallTimestamps.size > 200 && Math.random() < 0.02) {
      const pruneNow = Date.now();
      for (const [id, stamps] of _llmCallTimestamps) {
        if (stamps.every(t => pruneNow - t >= LLM_RATE_WINDOW_MS)) _llmCallTimestamps.delete(id);
      }
    }
  }

  try {
    // 1. Retrieval : chercher les chunks pertinents dans la base de connaissances (hybride v2)
    let ragContext = "";
    try {
      // intentHint : booste les chunks liés à la prestation en cours (ex: REPROG → chunks reprog en tête)
      let intentHint = null;
      try {
        const cs = waId ? await _getConversationState(waId) : null;
        intentHint = cs?.intent || null;
      } catch { /* non bloquant */ }

      const chunks = await retrieveContext(_supabase, userMessage, {
        matchCount: 8,
        matchThreshold: 0.35,
        keywordWeight: 0.3,
        intentHint,
      });
      ragContext = formatContextForPrompt(chunks, 4800);
      _log.info("RAG retrieval", { query: userMessage.slice(0, 60), chunksFound: chunks.length, contextChars: ragContext.length, topScore: chunks[0]?.combinedScore?.toFixed(2) || "N/A" });
    } catch (ragErr) {
      _log.warn("RAG retrieval failed, continuing without context", { error: String(ragErr?.message || ragErr) });
    }

    // 2. Construire les blocs système avec prompt caching
    // Bloc statique (LLM_SYSTEM_PROMPT + grille tarifaire) — caché en priorité
    const TARIF_BLOCK = `\n\nGRILLE TARIFAIRE COMPLÈTE (prix TTC) :
🏎️ REPROG Stage 1 : 390€ (<400ch et <2018) | sinon sur devis
🏎️ REPROG Stage 2/3/4 : sur devis (modifications mécaniques requises)
⛽ Conversion E85 : 490€ (essence <2020) | sinon sur devis
🔧 Suppression FAP : 260€ (diesel <2019) | 300€ (≥2019)
🔧 Suppression AdBlue : 260€ (BlueHDi PSA) | 300€ (autres diesel)
🔧 Suppression EGR : sur devis
🔍 Diag simple : 50€ (20min) | Diag approfondi : 80€ (35min) | Recherche panne : 130€ (1h)
➕ Options add-on : bougies E85 +170€ | suppression méca FAP +250€ | EGR add-on +90€ | AdBlue add-on +90€ | FAP add-on +90€ | Reprog add-on +280€
🎨 Sur devis : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme
💡 Devis gratuit et sans engagement.`;

    const systemBlocks = [
      {
        type: "text",
        text: LLM_SYSTEM_PROMPT + TARIF_BLOCK,
        cache_control: { type: "ephemeral" }, // ~3000 tokens statiques — caché à chaque appel
      },
    ];

    // Bloc RAG — second point de cache (varie par requête mais coûteux)
    if (ragContext) {
      // Pas de cache_control ici — le contenu RAG change à chaque requête, le cache ne frapperait jamais
      systemBlocks.push({
        type: "text",
        text: `CONTEXTE RÉCUPÉRÉ DE LA BASE DE CONNAISSANCES (utilise ces infos en priorité pour répondre, elles sont fiables et à jour) :\n${ragContext}`,
      });
    }

    // Blocs dynamiques (mémoire + diagnostic) — non cachés, varient par utilisateur/message
    const dynamicParts = [];

    // Mémoire long-terme : profil client + résumé des échanges précédents
    if (waId) {
      try {
        const memory = await getClientProfile(_supabase, waId);
        const memoryBlock = buildMemoryContext(memory);
        if (memoryBlock) {
          dynamicParts.push(memoryBlock);
          _log.debug("LLM mémoire client injectée", {
            wa_id: waId,
            hasProfile: !!memory.profile?.first_name || (memory.profile?.vehicles?.length > 0),
            hasSummary: !!memory.summary?.text,
          });
        }

        // Déclencher un résumé async si la conversation est longue (backpressure: max 2 concurrents)
        const total = memory.profile?.total_user_messages || 0;
        if (shouldSummarize(memory, total) && _summarizeActive < MAX_CONCURRENT_SUMMARIES) {
          _summarizeActive++;
          _getRecentMessages(waId, 30)
            .then(msgs => summarizeAndStore(
              { supabase: _supabase, fetchFn: _fetchFn, anthropicKey: ANTHROPIC_API_KEY, model: LLM_MODEL, log: _log },
              waId,
              msgs.map(m => ({ role: m.direction === "in" ? "user" : "assistant", content: m.body }))
            ))
            .catch(err => _log.debug("summarizeAndStore async failed", { error: String(err?.message || err) }))
            .finally(() => { _summarizeActive--; });
        }
      } catch (memErr) {
        _log.warn("Memory context load failed", { error: String(memErr?.message || memErr) });
      }
    }

    // Pré-analyse du message : codes défauts (DTC), kilométrage, symptômes.
    try {
      let vehicle = null;
      if (waId) {
        try {
          const cs = await _getConversationState(waId);
          vehicle = cs?.data?.vehicle || null;
        } catch { /* non bloquant */ }
      }
      const diagnosticContext = buildDiagnosticContext(userMessage, vehicle);
      if (diagnosticContext) {
        dynamicParts.push(diagnosticContext);
        const dtcs = detectDtcCodes(userMessage);
        const km = detectMileage(userMessage);
        const symptoms = detectSymptoms(userMessage);
        _log.info("LLM diagnostic pré-analyse", {
          wa_id: waId,
          dtcCount: dtcs.length,
          dtcs: dtcs.map(d => d.code),
          mileage: km,
          symptomsCount: symptoms.length,
        });
      }
    } catch (diagErr) {
      _log.warn("Diagnostic pre-analysis failed", { error: String(diagErr?.message || diagErr) });
    }

    if (dynamicParts.length > 0) {
      systemBlocks.push({ type: "text", text: dynamicParts.join("\n\n") });
    }

    // 3. Construire les messages avec historique de conversation
    let chatMessages = [];
    if (waId) {
      try {
        const history = await _getRecentMessages(waId, 10);
        if (history.length > 0) {
          const filtered = history.filter(m => m.content !== userMessage);
          // Claude API exige des rôles alternés — on garde le plus récent de chaque bloc consécutif
          for (const m of filtered) {
            if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === m.role) {
              chatMessages[chatMessages.length - 1] = m;
            } else {
              chatMessages.push(m);
            }
          }
          _log.info("LLM history loaded", { wa_id: waId, historyLen: chatMessages.length });
        }
      } catch (histErr) {
        _log.warn("LLM history load failed", { error: String(histErr?.message || histErr) });
      }
    }
    chatMessages.push({ role: "user", content: userMessage });

    // 4. Appeler Claude avec prompt caching activé
    const resp = await _fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        system: systemBlocks,
        messages: chatMessages,
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      _log.error("LLM API error", { status: resp.status, body: errBody.slice(0, 200) });
      return null;
    }

    const json = await resp.json();
    let content = json.content?.[0]?.text;
    if (!content) return null;

    // Strip markdown code blocks (Claude Sonnet peut envelopper le JSON dans ```json ... ```)
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (parseErr) {
      _log.error("LLM JSON parse failed", { content: content.slice(0, 200), error: String(parseErr?.message || parseErr) });
      return null;
    }

    if (!parsed || !VALID_LLM_TYPES.has(parsed.type)) {
      _log.error("LLM returned unexpected type", { type: parsed?.type, content: content.slice(0, 100) });
      return null;
    }

    const usage = json.usage || {};
    _log.info("LLM response", {
      type: parsed.type,
      intent: parsed.intent || null,
      msgLen: (parsed.message || "").length,
      cache_read: usage.cache_read_input_tokens || 0,
      cache_write: usage.cache_creation_input_tokens || 0,
      input_tokens: usage.input_tokens || 0,
    });
    return parsed;
  } catch (err) {
    _log.error("LLM call failed", { error: String(err?.message || err) });
    return null;
  }
}

module.exports = {
  initLlmService,
  ANTHROPIC_API_KEY,
  LLM_MODEL,
  LLM_SYSTEM_PROMPT,
  isLikelyQuestion,
  askLLM,
};
