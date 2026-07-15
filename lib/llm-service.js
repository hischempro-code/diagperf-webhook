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

// Rate limiting : max 40 appels LLM/minute par utilisateur (protection coûts + abus)
const _llmCallTimestamps = new Map();
const LLM_RATE_WINDOW_MS = 60_000;
const LLM_RATE_MAX = 40;

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
- +24 000 motorisations couvertes, outils pro, résultats prouvés.
- Honnête et transparent. Jamais de promesses exagérées.
- Longueur : 2-4 phrases pour réponse simple, 5-8 pour explication technique. Jamais de pavé.

PRESTATIONS & COMPATIBILITÉ :
- *Reprog Stage 1* (essence ET diesel) : optimisation cartographie, gains puissance/couple. Tous moteurs, idéalement 30k-200k km.
- *Conversion E85* : UNIQUEMENT essence. Diesel = incompatible → propose reprog diesel à la place.
- *Suppression FAP/EGR/AdBlue* : UNIQUEMENT diesel.
- *Diagnostic* : 3 niveaux — simple 50€ (20min), approfondi 80€ (35min), recherche panne 130€ (1h).
- *Options* : CarPlay, Virtual Cockpit, céramique, polissage, GPS/traceur, alarme (sur devis).
- Hybrides/électriques : aucune prestation compatible → orienter vers spécialiste.
- Déplacement : DiagPerf N'intervient PAS à domicile. Toutes les prestations se font UNIQUEMENT à l'atelier de Villenoy (77124). ⛔ INTERDIT ABSOLU : ne jamais suggérer ni mentionner déplacement à domicile, intervention groupée, partenariat local, organisation de trajet, ou tout arrangement géographique. Si le client évoque une distance ou une ville éloignée, répondre simplement qu'il faut venir à l'atelier et indiquer l'adresse.
- Garantie : ne JAMAIS annoncer de durée chiffrée — toujours renvoyer vers nos CGV (https://www.diagperf.com/conditions-generales-de-vente/). En cas de problème lié à la prestation, orienter vers le SAV.
- CT : Stage 1 et E85 n'affectent pas le contrôle technique.
- Assurance : aucune obligation légale de déclarer Stage 1 ou E85.

COMPATIBILITÉ PAR MODÈLE :
- Pour toute compatibilité précise (modèle / motorisation exacte), appuie-toi UNIQUEMENT sur le CONTEXTE récupéré de la base de connaissances ci-dessous. N'affirme JAMAIS une compatibilité de mémoire — en l'absence d'info fiable, propose un devis pour vérifier.
- Règles générales sûres : E85 = essence uniquement (diesel → propose reprog diesel à la place) ; Stage 1 = quasi tous les turbo essence/diesel.
- ⛔ HALLUCINATION MOTORISATION — INTERDIT ABSOLU : ne DÉDUIS et n'AFFIRME JAMAIS la motorisation (essence/diesel), la cylindrée, l'année ou le code moteur d'un véhicule à partir de son nom ou modèle. Un même modèle (ex: Citroën C1, Clio, 208…) existe souvent en essence ET en diesel. Ne dis JAMAIS "votre C1 est diesel/essence" de mémoire. La motorisation ne se connaît QUE par la lecture de plaque, que le SYSTÈME vérifie automatiquement.
- Si le client cite un véhicule + une prestation liée au carburant (E85, FAP, EGR, AdBlue) : NE JUGE PAS la compatibilité toi-même. Si la plaque est dans le message → route (Cas 4) pour l'identifier. Sinon → demande la plaque ("Envoyez-moi votre plaque et je vérifie instantanément la compatibilité + le prix exact.").
- ⛔ Ne propose JAMAIS FAP / EGR / AdBlue (diesel) tant que la plaque n'a pas CONFIRMÉ un moteur diesel. Une supposition ne suffit pas.

DIAGNOSTIC TECHNIQUE :
- Codes défauts OBD-II : explique en 1-2 phrases, propose la prestation adaptée.
  • P0400-P0409 → vanne EGR → suppression EGR ou diagnostic
  • P2002 / P242x-P245x / P20xx → FAP saturé → suppression FAP ou diagnostic
  • P20EE / P22xx / P204F-P208x → AdBlue/SCR → suppression AdBlue ou diagnostic
  • P0420/P0430 → catalyseur dégradé → diagnostic complet
  • P0014/P0011/P0012/P0013 → calage arbre à cames / VVT → diagnostic complet
  • P0171/P0172/P0174/P0175 → richesse mélange → diagnostic
  • P0234/P0299 → suralimentation turbo → diagnostic (puis reprog si moteur sain)
  • P0300-P0308 → ratés d'allumage → diagnostic urgent
  • P0087/P0088 → pression carburant → diagnostic
  • P0700/P0730 → boîte auto → on ne traite pas, oriente spécialiste BVA
  • P1xxx / C0xxx / U0xxx → codes constructeur / réseau CAN → diagnostic complet
- ⚠️ QUESTIONS DE SUIVI SUR UN CODE : "et pour le P0014 ?", "et ce code ?", "c'est quoi ce code ?", "et celui-là ?" → TOUJOURS Cas 2. Utilise l'historique pour contextualiser et explique le code demandé.
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
- "C'est fiable ?" → Stage 1 dans les tolérances constructeur, +24k motorisations ; garantie : se référer à nos CGV
- "C'est légal ?" → Pas de changement carte grise, CT normal, pas d'obligation assurance
- "C'est cher" → Rapport qualité/prix imbattable, devis gratuit et sans engagement
- "Ça abîme ?" → Non, on reste dans les marges mécaniques d'origine, diag pré-reprog recommandé
- "Ça va changer quoi ?" → Puissance, couple, agrément, parfois consommation réduite (diesel)
- "Combien de temps ?" → Stage 1 : 1h30-2h | E85 : 1h30 | FAP : 1h à 1h30 | EGR : 1h | AdBlue : 1h à 1h30 | Diag : 20min / 35min / 1h

INFOS PRATIQUES :
- Adresse : 38 Rue Jean Pierre Plicque, 77124 Villenoy (parking gratuit, 5 min gare Meaux ligne P)
- Google Maps : https://maps.google.com/?q=48.9583,2.8789
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
❌ JAMAIS Cas 1 pour : symptôme, voyant, code défaut, mode dégradé, perte de puissance, fumée, bruit, "est-ce que", "c'est quoi", "c'est grave", "combien", "ça vaut quoi", "j'hésite", "et pour le code", "et ce code", "et celui-là", toute question ou demande d'info.
❌ JAMAIS Cas 1 pour DIAG si le client pose une question sur un code ou symptôme — même si le mot "diagnostic" est utilisé.
⚠️ SAV = UNIQUEMENT client existant : réclamation ou problème lié à une prestation DÉJÀ réalisée par DiagPerf ("depuis la reprog", "suite à votre intervention", "ma conversion déconne"). Un problème, voyant ou panne sur un véhicule JAMAIS passé chez nous = prospect → Cas 2 (conseil + proposer le diagnostic 50-130€), JAMAIS SAV.

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
- "et si ça se passe mal ?" → rassure : prestations garanties (conditions dans nos CGV) + orienter vers le SAV
- "c'est long ?" / "ça prend combien de temps ?" → donne la durée de la prestation discutée
- "vous êtes ouverts quand ?" → horaires complets
- "vous êtes où ?" / "c'est loin ?" → adresse + carte
- "et pour le code P0014 ?" / "et ce code ?" / "et celui-là ?" → explique ce code OBD en utilisant le contexte précédent
- "c'est quoi ce code ?" / "c'est quoi ça ?" → explique le code ou symptôme évoqué juste avant
- "vous pouvez expliquer ?" / "tu peux m'expliquer ?" → développe le sujet déjà abordé
- "et si j'ai les deux ?" → réponds par rapport aux deux sujets évoqués dans l'historique
- "c'est lié ?" / "c'est la même chose ?" → explique le lien entre les sujets de l'historique
⚠️ Ne redemande JAMAIS de reformuler si l'historique donne le contexte.
⚠️ "et pour le code X?" est TOUJOURS Cas 2b — jamais Cas 1, même si X est un code diagnostic.

CAS 3 — Message vraiment ambigu même avec l'historique :
{ "type": "answer", "message": "Ce que j'ai compris + question de confirmation" }
Exemple : "Vous évoquez peut-être un mode dégradé (perte de puissance) ? Pouvez-vous confirmer ?"
⚠️ JAMAIS retourner { "type": "menu" } — cette valeur n'existe pas.

CAS 4 — Routing avancé (client a fourni SA PLAQUE + demande explicite de prestation) :
{ "type": "route", "target": "WAITING_QUOTE_CONFIRM", "intent": "REPROG", "data": { "plate": "AB-123-CD", "vehicle": { "make": "VW", "model": "Golf 7 GTI" }, "vehicleYear": 2018 }, "confidence": 0.95 }
❌ JAMAIS Cas 4 si symptôme, question ou ambiguïté — même si la plaque est connue.

CHAMP OPTIONNEL sendLocation :
Si le client demande l'adresse, comment venir, un lien Google Maps, ou les horaires :
{ "type": "answer", "message": "On est au 38 Rue Jean Pierre Plicque, Villenoy...\n📍 Google Maps : https://maps.google.com/?q=48.9583,2.8789", "sendLocation": true }
⚠️ Quand tu mets sendLocation:true, inclure TOUJOURS le lien Google Maps dans le message.

RÈGLES ABSOLUES :
- JSON brut uniquement — JAMAIS de backticks ni de blocs \`\`\`json
- ⛔ Ne génère JAMAIS toi-même un devis, une référence "DEV-xxx", ni un bloc "✅ Devis généré" : c'est le SYSTÈME qui crée les devis. Si le client veut lancer une prestation, renvoie le Cas 1 (intent) ; ne rédige pas un faux devis en texte.
- Ne donne JAMAIS un prix inconnu → "sur devis personnalisé"
- Symptôme / code / voyant / mode dégradé = TOUJOURS Cas 2
- SAV réservé aux suites d'une prestation DiagPerf ; le symptôme d'un prospect = Cas 2 avec proposition de diagnostic
- Cas 1 exige un verbe d'achat explicite dans le message actuel
- Utilise ACTIVEMENT l'historique pour Cas 2b — ne demande pas de répéter
- Salutations / remerciements → Cas 2 : réponse courte et chaleureuse
- Service non disponible → oriente vers ce qu'on sait faire, ou invite à contacter l'équipe
- ⛔ JAMAIS : déplacement à domicile, intervention groupée, partenariat local, optimisation de trajet, "malgré la distance", "on peut s'arranger", "déplacement possible", "garage proche de chez vous" — DiagPerf = atelier UNIQUEMENT à Villenoy. Si le client vient de loin : "Nos prestations se font exclusivement à l'atelier (Villenoy, 77124). Êtes-vous disponible pour vous déplacer ?"
- Si le client est frustré ou en colère → empathie d'abord, solution ensuite
- Toute question de suivi ("et pour...", "et ce code...", "c'est quoi...", "et si...") = Cas 2 SYSTÉMATIQUEMENT
- Si le message semble incomplet ou ambigu → Cas 2 avec question ouverte, JAMAIS Cas 1
- ⛔ JAMAIS deviner ni annoncer la motorisation (essence/diesel) d'un véhicule depuis son modèle — seule la plaque fait foi. Si une plaque est fournie, route (Cas 4) pour l'identifier au lieu de supposer. Ne propose pas FAP/EGR/AdBlue sur un diesel supposé.`;

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
        matchThreshold: 0.45,
        keywordWeight: 0.3,
        intentHint,
      });
      ragContext = formatContextForPrompt(chunks, 4800);
      _log.info("RAG retrieval", { query: userMessage.slice(0, 60), chunksFound: chunks.length, contextChars: ragContext.length, topScore: chunks[0]?.combinedScore?.toFixed(2) || "N/A" });
    } catch (ragErr) {
      _log.warn("RAG retrieval failed, continuing without context", { error: String(ragErr?.message || ragErr) });
    }

    // 2. Construire les blocs système avec prompt caching
    // Bloc statique (LLM_SYSTEM_PROMPT seul) — caché en priorité.
    // Les prix exacts et compatibilités viennent désormais du RAG (knowledge_base/tarifs/),
    // PAS du prompt : le benchmark (juge Opus 4.8) montre que baker la grille tarifaire dans
    // le prompt génère des hallucinations confiantes sur les prix, supprimées en passant tout
    // par le RAG. Repli sûr si le RAG ne retrouve rien : règle « prix inconnu → sur devis ».
    const systemBlocks = [
      {
        type: "text",
        text: LLM_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" }, // prompt statique — caché à chaque appel
      },
    ];

    // Bloc RAG — second point de cache (varie par requête mais coûteux)
    if (ragContext) {
      // Pas de cache_control ici — le contenu RAG change à chaque requête, le cache ne frapperait jamais
      systemBlocks.push({
        type: "text",
        text: `CONTEXTE RÉCUPÉRÉ DE LA BASE DE CONNAISSANCES (utilise ces infos en priorité pour répondre, elles sont fiables et à jour) :\n${ragContext}`,
      });
    } else {
      // RAG indisponible (embeddings en panne, aucun chunk pertinent) → garde-fou
      // anti-hallucination : les prix de base (reprog/E85/FAP/EGR/AdBlue) sont
      // conditionnels au véhicule et viennent UNIQUEMENT du RAG. Sans lui, ne JAMAIS
      // inventer de tarif. (Les prix diagnostic 50/80/130€ restent valables, ils sont
      // fixes et déjà dans tes règles.)
      systemBlocks.push({
        type: "text",
        text: `⚠️ AUCUNE donnée tarifaire récupérée pour cette requête. RÈGLE ABSOLUE : ne cite AUCUN prix pour reprogrammation, E85, suppression FAP/EGR/AdBlue (ils dépendent du véhicule). Pour ces prix, réponds : « Je vous établis un devis gratuit et instantané — envoyez simplement votre plaque d'immatriculation. » N'invente jamais un montant.`,
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
        const history = await _getRecentMessages(waId, 15);
        if (history.length > 0) {
          // On conserve TOUS les messages (l'API Messages de Claude accepte les rôles
          // consécutifs et les concatène). L'ancienne fusion « garder le plus récent de
          // chaque bloc » écrasait les messages assistant consécutifs — or le bot envoie
          // souvent 2-3 messages d'affilée (devis + CGV + lien) → on perdait le contexte
          // dont dépendent justement les réponses de suivi (« et pour ce code ? »).
          chatMessages = history.filter(m => m.content !== userMessage);
          // L'API Claude exige que le PREMIER message soit role "user" (sinon 400).
          // La fenêtre des N derniers messages commence souvent par un message sortant
          // du bot (assistant) → on retire les messages assistant en tête.
          while (chatMessages.length > 0 && chatMessages[0].role !== "user") {
            chatMessages.shift();
          }
          _log.info("LLM history loaded", { wa_id: waId, historyLen: chatMessages.length });
        }
      } catch (histErr) {
        _log.warn("LLM history load failed", { error: String(histErr?.message || histErr) });
      }
    }
    chatMessages.push({ role: "user", content: userMessage });

    // 4. Appeler Claude avec prompt caching activé (retry sur erreurs transitoires)
    const LLM_RETRY_STATUSES = new Set([500, 503, 529]);
    const LLM_TIMEOUT_MS = 20000; // évite un hang infini si la sortie réseau Render pend
    let resp;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Timeout par tentative + retry sur ERREUR RÉSEAU (pas seulement sur statut HTTP).
      // Avant : une erreur réseau (sortie Render flaky vers Anthropic) faisait remonter
      // l'exception → askLLM renvoyait null → "Je n'ai pas bien saisi" pour une vraie
      // question. Constaté en prod (09/07, "problème d'AdBlue").
      try {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
        try {
          resp = await _fetchFn("https://api.anthropic.com/v1/messages", {
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
              max_tokens: 900,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(to);
        }
      } catch (netErr) {
        if (attempt < 3) {
          _log.warn("LLM API erreur réseau, retry", { attempt, error: String(netErr?.message || netErr) });
          await new Promise(r => setTimeout(r, 1200 * attempt));
          continue;
        }
        _log.error("LLM API erreur réseau (abandon)", { error: String(netErr?.message || netErr) });
        return null;
      }
      if (resp.ok) break;
      if (attempt < 3 && LLM_RETRY_STATUSES.has(resp.status)) {
        _log.warn("LLM API transient error, retry", { status: resp.status, attempt });
        await new Promise(r => setTimeout(r, 1200 * attempt));
        continue;
      }
      const errBody = await resp.text().catch(() => "");
      _log.error("LLM API error", { status: resp.status, body: errBody.slice(0, 200) });
      return null;
    }

    const json = await resp.json();
    let content = json.content?.[0]?.text;
    if (!content) return null;

    // Strip markdown code blocks et texte parasite autour du JSON
    content = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Fallback : extraire le premier objet JSON trouvé dans la réponse
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch {}
      }
    }

    if (!parsed) {
      // Le LLM répond FRÉQUEMMENT en TEXTE BRUT au lieu du JSON demandé (Haiku ignore
      // le format). Avant : on jetait cette (bonne) réponse → askLLM null → le fallback
      // déterministe MAL-ROUTAIT (ex: "voyant AdBlue" → flow EGR). Désormais on traite
      // le texte comme une réponse conversationnelle : elle est envoyée au client.
      const plain = String(content || "").trim();
      const looksLikeJsonAttempt = plain.startsWith("{") || plain.startsWith("[");
      if (plain.length > 1 && /[a-zA-ZÀ-ÿ]/.test(plain) && !looksLikeJsonAttempt) {
        _log.warn("LLM réponse en texte brut (non-JSON) → traitée comme answer", { snippet: plain.slice(0, 120) });
        parsed = { type: "answer", message: plain };
      }
      // JSON TRONQUÉ (stop_reason max_tokens) : `{"type":"answer","message":"…` sans fin.
      // Salvage plutôt que de tout jeter : intent complet en priorité, sinon le message
      // partiel (coupé à la dernière phrase complète pour ne pas envoyer un texte haché).
      if (!parsed && looksLikeJsonAttempt) {
        const intentMatch = plain.match(/"intent"\s*:\s*"(REPROG|E85|FAP|EGR|ADBLUE|DIAG|AUTRES|SAV)"/);
        const msgMatch = plain.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
        if (intentMatch) {
          _log.warn("LLM JSON tronqué → intent récupéré", { intent: intentMatch[1], stop: json.stop_reason });
          parsed = { type: "intent", intent: intentMatch[1] };
        } else if (msgMatch && msgMatch[1].length >= 20) {
          let msg;
          try { msg = JSON.parse(`"${msgMatch[1].replace(/\\+$/, "")}"`); } catch { msg = msgMatch[1]; }
          // Couper à la dernière ponctuation forte pour ne pas finir en plein mot
          const lastStop = Math.max(msg.lastIndexOf("."), msg.lastIndexOf("!"), msg.lastIndexOf("?"));
          if (lastStop >= 20) msg = msg.slice(0, lastStop + 1);
          _log.warn("LLM JSON tronqué → message partiel récupéré", { len: msg.length, stop: json.stop_reason });
          parsed = { type: "answer", message: msg };
        }
      }
      if (!parsed) {
        _log.error("LLM JSON parse failed", { content: content.slice(0, 200) });
        return null;
      }
    }

    // Récupération partielle : si type manquant/inconnu, inférer depuis les champs présents.
    // Constaté en prod : le LLM invente parfois type:"menu" ou omet le type → retourner null
    // ici finissait en "Je n'ai pas bien saisi" alors que la réponse était exploitable.
    if (!VALID_LLM_TYPES.has(parsed.type)) {
      const VALID_INTENTS = new Set(["REPROG", "E85", "FAP", "EGR", "ADBLUE", "DIAG", "AUTRES", "SAV"]);
      if (typeof parsed.message === "string" && parsed.message.length > 0) {
        _log.warn("LLM type manquant, inféré answer", { content: content.slice(0, 100) });
        parsed.type = "answer";
      } else if (parsed.intent && VALID_INTENTS.has(parsed.intent)) {
        _log.warn("LLM type invalide mais intent valide, inféré intent", { type: parsed?.type, intent: parsed.intent });
        parsed.type = "intent";
      } else {
        _log.error("LLM returned unexpected type", { type: parsed?.type, content: content.slice(0, 100) });
        return null;
      }
    }

    // Filtre anti-faux-devis : Haiku écrit parfois un "✅ Devis généré / Réf : DEV-xxx"
    // en texte (interdit par le prompt, mais il désobéit). On ne l'envoie JAMAIS tel quel
    // (sinon le client reçoit un devis + une référence INVENTÉS). Si une seule prestation
    // est identifiable → on route vers le VRAI flow (qui génère le vrai devis) ; sinon
    // message sûr invitant à confirmer.
    if (parsed.type === "answer" && /DEV-\s*\d|devis\s+g[ée]n[ée]r|r[ée]f\s*[:.]?\s*dev/i.test(parsed.message || "")) {
      const { detectIntentsAll } = require("./intent-detector");
      const cited = detectIntentsAll(parsed.message).filter((i) => i !== "SAV");
      if (cited.length === 1) {
        _log.warn("LLM a halluciné un devis en texte → routé vers le vrai flow", { wa_id: waId, intent: cited[0] });
        parsed = { type: "intent", intent: cited[0] };
      } else {
        _log.warn("LLM a halluciné un devis en texte → message sûr (prestation ambiguë)", { wa_id: waId, cited });
        parsed = { type: "answer", message: "Pour établir votre devis officiel, indiquez-moi la prestation souhaitée et envoyez votre plaque d'immatriculation — je vous le génère instantanément. 🚗" };
      }
    }

    // Télémétrie anti-hallucination : un montant en € cité alors que le RAG n'a rien
    // fourni = risque que le LLM ait inventé un prix. On loggue pour mesurer (non bloquant).
    if (!ragContext && parsed.type === "answer" && /\d\s*(?:€|euros?)\b/i.test(parsed.message || "")) {
      _log.warn("Hallucination-risque: prix cité sans contexte RAG", { wa_id: waId, snippet: (parsed.message || "").slice(0, 140) });
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
