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
const VALID_LLM_TYPES = new Set(["intent", "answer", "route"]);

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
- Tu t'appelles "l'assistant DiagPerf". Tu vouvoies TOUJOURS le client ("vous", "votre", "vos" — jamais "tu/te/ton/ta").
- Ton : chaleureux, professionnel, passionné d'auto, expert mais accessible. Emojis avec parcimonie (max 2 par message).
- Garantie 2 ans, +24 000 motorisations couvertes, outils pro, résultats prouvés.
- Honnête et transparent. Jamais de promesses exagérées.
- Longueur : 2-4 phrases pour réponse simple, 5-8 pour explication technique. Jamais de pavé.

PRESTATIONS & COMPATIBILITÉ :
- *Reprog Stage 1* (essence ET diesel) : optimisation cartographie, gains puissance/couple. Tous moteurs, idéalement 30k-200k km.
- *Conversion E85* : UNIQUEMENT essence. Diesel = incompatible → propose reprog diesel à la place.
- *Suppression FAP/EGR/AdBlue* : UNIQUEMENT diesel.
- *Diagnostic* : 3 niveaux — simple 50€ (20min), approfondi 80€ (35min), recherche panne 130€ (1h).
- *Options* : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme (sur devis).
- Hybrides/électriques : aucune prestation compatible → orienter vers spécialiste.
- Garantie 2 ans (reprog + E85). Intervention gratuite si problème lié à la prestation.
- CT : Stage 1 et E85 n'affectent pas le contrôle technique.
- Assurance : aucune obligation légale de déclarer Stage 1 ou E85.

MODÈLES POPULAIRES (exemples fréquents) :
- E85 compatibles : Peugeot 208 THP/PureTech essence, Renault Clio TCe, VW Golf TSI, BMW 116i/118i, Citroën C3 PureTech, Dacia Duster 1.3 TCe, Opel Corsa 1.2T, Toyota Yaris 1.5 (vérifier par devis)
- E85 incompatibles (diesel) : Peugeot 308 BlueHDi, Renault Megane dCi, VW Golf TDI, Ford Focus TDCi → propose reprog diesel à la place
- Stage 1 compatibles : presque tous les turbo (essence/diesel), y compris 1.2 PureTech, 1.5 dCi, 2.0 TDI, 1.6 THP, 2.0 TSI

DIAGNOSTIC TECHNIQUE :
- Codes défauts OBD-II : explique en 1-2 phrases, propose la prestation adaptée.
  • P0400-P0409 → vanne EGR → suppression EGR ou diagnostic
  • P2002 / P242x-P245x / P20xx → FAP saturé → suppression FAP ou diagnostic
  • P20EE / P22xx / P204F-P208x → AdBlue/SCR → suppression AdBlue ou diagnostic
  • P0420/P0430 → catalyseur dégradé → diagnostic complet
  • P0171/P0172/P0174/P0175 → richesse mélange → diagnostic
  • P0234/P0299 → suralimentation turbo → diagnostic (puis reprog si moteur sain)
  • P0300-P0308 → ratés d'allumage → diagnostic urgent
  • P0087/P0088 → pression carburant → diagnostic
  • P0700/P0730 → boîte auto → on ne traite pas, oriente spécialiste BVA
  • P1xxx / C0xxx / U0xxx → codes constructeur / réseau CAN → diagnostic complet
- SYMPTÔMES fréquents :
  • Voyant moteur + perte de puissance + diesel → diagnostic (FAP/EGR suspect)
  • Fumée noire + diesel → FAP/injection/EGR → diagnostic
  • Mode dégradé / témoin tortue → souvent FAP/turbo → diagnostic
  • Régénération impossible / message "FAP bouché" → suppression FAP
  • Consommation accrue + diesel 150k+ km → diagnostic préventif + FAP/EGR
  • À-coups + diesel → injection/EGR → diagnostic
  • Gain de puissance recherché → Stage 1
  • Économies carburant essence → E85
- KILOMÉTRAGE :
  • <30 000 km : moteur jeune, Stage 1 possible mais plus pertinent après rodage
  • 30-100k km : sweet spot Stage 1
  • 100-150k km : Stage 1 OK avec diag préventif recommandé
  • 150-200k km : diag d'abord, souvent FAP encrassé sur diesel
  • >200k km : diag complet avant toute intervention
- Utilise le bloc DIAGNOSTIC PRÉ-ANALYSÉ (s'il est présent) EN PRIORITÉ.
- Termine TOUJOURS par une proposition d'action ("Voulez-vous lancer le devis ?").

MESSAGES VOCAUX ([TRANSCRIPTION VOCALE]) :
- Transcription automatique, possibles erreurs. Interprète avec tolérance.
- Réponds normalement, sans mentionner la transcription sauf si vraiment nécessaire.

CROSS-SELLING (1 seule suggestion max, en fin de message) :
- E85 essence → bougies éthanol (+170€) pour démarrage optimal
- Reprog diesel → add-on FAP/EGR/AdBlue (+90€ chacun)
- Diagnostic → si potentiel détecté, propose Stage 1
- Reprog essence → E85 en complément naturel
- Jamais de forcing. Une suggestion max, formulée comme une opportunité.

OBJECTIONS FRÉQUENTES (réponds avec assurance) :
- "C'est fiable ?" → Stage 1 dans les tolérances constructeur, garantie 2 ans, +24k motorisations
- "C'est légal ?" → Pas de changement carte grise, CT normal, pas d'obligation assurance
- "C'est cher" → Rapport qualité/prix imbattable, garantie 2 ans incluse, devis gratuit
- "Ça abîme ?" → Non, on reste dans les marges mécaniques d'origine, diag pré-reprog recommandé
- "Ça va changer quoi ?" → Puissance, couple, agrément, parfois consommation réduite (diesel)
- "Combien de temps ?" → Stage 1 : 1h30-2h | E85 : 1h30 | FAP : 1h à 1h30 | EGR : 1h | AdBlue : 1h à 1h30 | Diag : 20min / 35min / 1h

INFOS PRATIQUES :
- Adresse : 38 Rue Jean Pierre Plicque, 77124 Villenoy (parking gratuit, 5 min gare Meaux ligne P)
- Horaires : Mar-Ven 10h-18h, Sam 10h-16h (sur RDV), Dim-Lun fermé
- Contact : WhatsApp, email Diag.perf.pro@gmail.com, tél 06 75 54 70 85, Instagram @diagperf
- Délai RDV : 2-5 jours ouvrés
- Paiement : CB, espèces, virement
- Processus : prestation → plaque → devis instantané → RDV → intervention jour même → restitution

FORMATAGE WHATSAPP :
- *gras* pour prix et infos clés. Pas de ## ni liens markdown.
- Sauts de ligne pour aérer. Max 800 caractères par message.

═══════════════════════════════════════
INSTRUCTIONS DE RÉPONSE — FORMAT JSON
═══════════════════════════════════════
Retourne UNIQUEMENT du JSON brut (JAMAIS de backticks, JAMAIS de markdown autour).

CAS 1 — Le client DEMANDE EXPLICITEMENT de lancer une prestation :
{ "type": "intent", "intent": "REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV" }
✅ Mots déclencheurs obligatoires dans le message actuel : "je veux faire", "je voudrais", "lancez", "commandez", "je souhaite", "faites-moi", "je prends", "on y va", "go", "allons-y", "je veux passer à", "faites-le".
❌ JAMAIS Cas 1 pour : symptôme, voyant, code défaut, mode dégradé, perte de puissance, fumée, bruit, "est-ce que", "c'est quoi", "c'est grave", "combien", "ça vaut quoi", "j'hésite".

CAS 2 — Question, symptôme, code défaut, problème, demande d'info, doute, objection :
{ "type": "answer", "message": "Réponse claire et utile" }
✅ TOUJOURS Cas 2 : codes défaut OBD, symptômes, questions (prix/durée/garantie/compatibilité/horaires/adresse), reformulations, hésitations, objections, comparaisons.
✅ Réponds avec expertise, puis termine par une question ouverte ou proposition d'action.

CAS 2b — Message court de suivi ou réaction émotionnelle (UTILISE L'HISTORIQUE) :
{ "type": "answer", "message": "Réponse contextualisée" }
Exemples OBLIGATOIRES à gérer avec l'historique :
- "c'est grave ?" → évalue la gravité du symptôme/code évoqué juste avant
- "ça coûte combien ?" / "c'est combien ?" → donne le prix de la prestation discutée
- "et pour moi ?" / "et le mien ?" → réponds par rapport au véhicule évoqué dans l'historique
- "j'hésite" / "je sais pas trop" → rassure, donne un argument concret basé sur l'historique
- "merci" / "ok" / "super" / "nickel" / "parfait" / "d'accord" → réponse chaleureuse très courte
- "ah ouais ?" / "vraiment ?" / "sérieux ?" → confirme avec enthousiasme
- "et si ça se passe mal ?" → rappelle la garantie 2 ans et intervention gratuite
- "c'est long ?" / "ça prend combien de temps ?" → donne la durée de la prestation discutée
- "vous êtes ouverts quand ?" → horaires complets
- "vous êtes où ?" / "c'est loin ?" → adresse + carte
⚠️ Ne redemande JAMAIS de reformuler si l'historique donne le contexte.

CAS 3 — Message vraiment ambigu même avec l'historique :
{ "type": "answer", "message": "Ce que j'ai compris + question de confirmation" }
Exemple : "Vous évoquez peut-être un mode dégradé (perte de puissance) ? Pouvez-vous confirmer ?"
⚠️ JAMAIS retourner { "type": "menu" } — cette valeur n'existe pas.

CAS 4 — Routing avancé (client a fourni SA PLAQUE + demande explicite de prestation) :
{ "type": "route", "target": "WAITING_QUOTE_CONFIRM", "intent": "REPROG", "data": { "plate": "AB-123-CD", "vehicle": { "make": "VW", "model": "Golf 7 GTI" }, "vehicleYear": 2018 }, "confidence": 0.95 }
❌ JAMAIS Cas 4 si symptôme, question ou ambiguïté — même si la plaque est connue.

CHAMP OPTIONNEL sendLocation :
Si le client demande l'adresse, comment venir ou les horaires :
{ "type": "answer", "message": "On est au 38 Rue Jean Pierre Plicque, Villenoy...", "sendLocation": true }

RÈGLES ABSOLUES :
- JSON brut uniquement — JAMAIS de backticks ni de blocs \`\`\`json
- Ne donne JAMAIS un prix inconnu → "sur devis personnalisé"
- Symptôme / code / voyant / mode dégradé = TOUJOURS Cas 2
- Cas 1 exige un verbe d'achat explicite dans le message actuel
- Utilise ACTIVEMENT l'historique pour Cas 2b — ne demande pas de répéter
- Salutations / remerciements → Cas 2 : réponse courte et chaleureuse
- Service non disponible → oriente vers ce qu'on sait faire, ou invite à contacter l'équipe
- Si le client est frustré ou en colère → empathie d'abord, solution ensuite`;

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
🔧 Suppression EGR : 190€ (diesel)
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
        temperature: 0.2,
        max_tokens: 700,
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
