#!/usr/bin/env node
/**
 * Génère un dossier obsidian-notes/ contenant une note Markdown par fichier de code source
 * du projet, avec liens croisés [[...]] correspondant aux imports internes.
 *
 * Usage: node scripts/generate-obsidian-notes.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "obsidian-notes");

// ────────────────────────────────────────────────────────────────────────
// Descripteurs par fichier
//   path      : chemin relatif au repo
//   role      : résumé court (1-3 phrases)
//   deps      : imports internes → [[wikilink]]
//   exports   : exports principaux (facultatif)
//   ext       : imports externes / stdlib (facultatif)
//   notes     : détails complémentaires (facultatif)
// ────────────────────────────────────────────────────────────────────────
const FILES = [
  // ── racine ─────────────────────────────────────────────────────────
  {
    path: "server.js",
    role: "Point d'entrée Express du webhook DiagPerf. Bootstrappe Sentry, la config, Supabase, le RAG, les services (LLM, PDF, email, WhatsApp, vidéo Creatomate, relances), branche les routes `/webhook` et `/api/dashboard`, orchestre la boucle de traitement d'un message entrant et démarre le cron des relances.",
    deps: [
      "sentry", "config/index", "rag", "creatomateVideo", "diagnostic-helper",
      "sentiment-detector", "conversation-memory", "intent-router",
      "signature", "dashboard", "relance-service",
      "prestation", "sav", "webhook", "pdf-service",
    ],
    ext: ["express", "@supabase/supabase-js", "fs", "path", "node-fetch"],
    exports: "Aucun (script long-running).",
    notes: "Sentry est chargé en tout premier pour capter les erreurs des autres `require`.",
  },
  {
    path: "helpers.js",
    role: "Aggregat historique de helpers purs (plaques, greetings, extraction texte WhatsApp, calculs de prix). Sert essentiellement à la suite de tests `tests/helpers.test.js` — le code de production a migré vers `lib/text-helpers`, `lib/plate-utils` et `lib/vehicle-service`.",
    deps: [],
    exports: "normalizePlate, validatePlate, isGreetingOrReset, extractInboundText, extractInteractiveId, detectIntent, computeReprogPrice, computeE85Price, computeFapPrice, computeAdbluePrice, validateEmail, STAGE1_FIXED_PRICE_CENTS.",
    notes: "Utilisé par [[helpers.test]].",
  },
  {
    path: "ingest.js",
    role: "Pipeline d'ingestion de la base de connaissances. Lit tous les Markdown de `knowledge_base/`, chunk (~400 tokens), génère les embeddings via Google Gemini (`gemini-embedding-001`, 384 dims) et remplit la table `kb_chunks` de Supabase (pgvector). Idempotent : purge les anciens chunks par fichier avant réinsertion.",
    deps: ["rag"],
    ext: ["fs", "path", "dotenv", "@supabase/supabase-js"],
    notes: "Doit utiliser le même embedder que [[rag]] pour aligner les espaces vectoriels.",
  },
  {
    path: "rag.js",
    role: "Module de retrieval du bot. Génère les embeddings via Google Gemini, appelle Supabase pgvector + FTS pour retrouver les chunks pertinents, et formate le contexte pour injection dans le prompt système. Fournit aussi les synonymes FR/EN pour améliorer le rappel.",
    deps: [],
    ext: ["@google/genai"],
    exports: "retrieveContext, formatContextForPrompt, generateEmbedding, preloadEmbedder.",
    notes: "Consommé par [[server]], [[ingest]], [[llm-service]], [[test-rag]], [[run-benchmark]].",
  },
  {
    path: "test-rag.js",
    role: "Script CLI de smoke-test du pipeline RAG complet (embed → pgvector → format). Prend une question en argument, imprime les chunks et la version formatée du contexte.",
    deps: ["rag"],
    ext: ["dotenv", "@supabase/supabase-js"],
  },

  // ── benchmark/ ────────────────────────────────────────────────────
  {
    path: "benchmark/prompts.js",
    role: "Définit les 4 variantes de prompt système du mini-benchmark V1 vs V2 (A-V1, A-V2, B-noRAG, B-RAG). Réimporte le prompt actuel depuis `llm-service` pour rester en phase avec la prod.",
    deps: ["llm-service"],
    exports: "PROMPT_V1, PROMPT_V2, PROMPT_B_STRIPPED.",
  },
  {
    path: "benchmark/rejudge.js",
    role: "Recharge un `raw-*.json` de run existant et re-note UNIQUEMENT chaque réponse stockée avec un juge LLM plus fort (Opus 4.8 par défaut), sans rappeler Claude pour générer.",
    deps: [],
    ext: ["dotenv", "fs", "path", "node-fetch"],
  },
  {
    path: "benchmark/run-benchmark.js",
    role: "Runner du mini-benchmark V1 vs V2 (RAG) pour le mémoire. Passe chaque question de `benchmark/questions.json` dans les 4 conditions et mesure exactitude, hallucinations, latence, coût.",
    deps: ["rag", "prompts"],
    ext: ["dotenv", "fs", "path", "@supabase/supabase-js", "node-fetch"],
  },

  // ── config/ ───────────────────────────────────────────────────────
  {
    path: "config/index.js",
    role: "Configuration centralisée. Charge `.env`, valide la présence des variables requises (SUPABASE_URL, WHATSAPP_TOKEN, etc.), avertit sur les recommandées, expose `config`, `MENU_MAP`, `NON_TEXT_TYPES`, `DIAG_OPTIONS`, `PRESTATION_DURATIONS`.",
    deps: [],
    ext: ["dotenv"],
    notes: "Consommé par [[server]], [[dashboard]], [[prestation]].",
  },

  // ── eval/ ─────────────────────────────────────────────────────────
  {
    path: "eval/detectors.js",
    role: "Détecteurs d'hallucination déterministes (fonctions pures, sans réseau). Chacun renvoie `{hit, evidence}` sur le texte d'une réponse `answer`. Attrape motorisation affirmée, faux devis, gains chiffrés, déplacement à domicile, garantie chiffrée. Précision > rappel.",
    deps: [],
    exports: "DETECTORS, runDetectors.",
    notes: "Consommé par [[detectors.test]] (offline) et [[run-eval]] (live). Alimente la télémétrie de [[llm-service]].",
  },
  {
    path: "eval/detectors.test.js",
    role: "Tests hors-ligne des détecteurs d'hallucination. Vérifie positifs (fire sur textes réellement hallucinatoires) et négatifs (ne fire pas sur réponses légitimes).",
    deps: ["detectors"],
  },
  {
    path: "eval/run-eval.js",
    role: "Harnais de non-régression anti-hallucination en LIVE. Rejoue chaque cas de `eval/cases.json` à travers le vrai `askLLM` (mêmes prompt, RAG, garde-fous), puis note la réponse via les détecteurs, required/forbidden, et type_in.",
    deps: ["detectors", "llm-service"],
    ext: ["fs", "path", "dotenv", "@supabase/supabase-js", "node-fetch"],
  },

  // ── flows/ ────────────────────────────────────────────────────────
  {
    path: "flows/prestation.js",
    role: "Machine à états du parcours prospect (REPROG/E85/FAP/EGR/ADBLUE). Enchaîne : détection intent → saisie plaque → lookup véhicule → validation compatibilité → devis (upsells) → contact → PDF + email. Factory : injecte toutes ses dépendances depuis `server.js`.",
    deps: [
      "text-helpers", "intent-detector", "llm-service", "vehicle-service",
      "vehicle-card", "devis-service", "config/index",
    ],
    exports: "createPrestationFlow.",
  },
  {
    path: "flows/sav.js",
    role: "Machine à états du flow SAV pour clients existants (réclamations, tickets). Détecte l'intent SAV, collecte plaque + coordonnées, notifie le garage par email et envoie une confirmation client.",
    deps: [
      "text-helpers", "intent-detector", "vehicle-service",
      "plate-extractor", "llm-service", "vehicle-card",
    ],
    exports: "createSavFlow.",
  },

  // ── lib/ ──────────────────────────────────────────────────────────
  {
    path: "lib/conversation-memory.js",
    role: "Mémoire long-terme par client stockée dans `conversations.contexte_json` (pas de nouvelle table). Gère le profil (véhicules, prestations discutées, objections, ton) et le résumé condensé des conversations longues. Best-effort : n'échoue jamais en cascade.",
    deps: [],
    exports: "getClientProfile, updateClientProfile, extractProfileSignals, buildMemoryContext, shouldSummarize, summarizeAndStore.",
    notes: "Consommé par [[server]], [[webhook]], [[llm-service]].",
  },
  {
    path: "lib/conversation-service.js",
    role: "CRUD léger sur la table `conversation_state` (état actif du flow conversationnel par `wa_id`). Applique un TTL de 2h : au-delà, l'état est effacé automatiquement.",
    deps: [],
    exports: "initConversationService, getConversationState, setConversationState, clearConversationState.",
  },
  {
    path: "lib/creatomateVideo.js",
    role: "Rendering de vidéos personnalisées via l'API Creatomate. Deux entrées : `renderStageGainsVideo` (gains puissance/couple d'une reprog) et `renderPrestationVideo` (générique E85/FAP/AdBlue). Placeholders documentés en tête de fichier.",
    deps: [],
    exports: "renderStageGainsVideo, renderPrestationVideo.",
    notes: "Requiert `CREATOMATE_API_KEY` et un `CREATOMATE_TEMPLATE_ID`.",
  },
  {
    path: "lib/devis-service.js",
    role: "Persistance des devis dans Supabase (`devis`, `tarifs_prestations`, `prestations`). Lit le tarif par code prestation, crée un devis, gère les upsells, la conversion HT/TVA/TTC, la clé d'idempotence.",
    deps: ["text-helpers", "vehicle-service"],
    exports: "initDevisService, getPrestationTarif, createDevis, addUpsellOptionsToDevis, etc.",
  },
  {
    path: "lib/diagnostic-helper.js",
    role: "Pré-analyse un message client : extrait les codes défauts OBD-II (DTC), le kilométrage et les symptômes courants (voyant moteur, fumée, perte puissance…). Mappe chaque famille DTC vers la prestation DiagPerf appropriée.",
    deps: [],
    exports: "buildDiagnosticContext, detectDtcCodes, detectMileage, detectSymptoms.",
    notes: "Injecte un contexte structuré dans le system prompt (`askLLM` — cf. [[llm-service]]).",
  },
  {
    path: "lib/email-service.js",
    role: "Client HTTP Brevo pour envoi d'emails (client + garage) : PDF devis, notifications SAV, confirmations. Best-effort : renvoie `false` si `BREVO_API_KEY` absent au lieu de lever.",
    deps: [],
    ext: ["node-fetch"],
    exports: "initEmailService, sendQuoteEmail, sendSavClientEmail, sendSavDiagperfEmail, etc.",
  },
  {
    path: "lib/event-handlers.js",
    role: "Handlers WhatsApp génériques : notification garage (email, WhatsApp désactivé par défaut à cause des templates Meta), escalade frustration/humain, gestion des boutons interactifs.",
    deps: ["text-helpers", "sentiment-detector", "intent-detector"],
    exports: "initEventHandlers, notifyGarage, handleFrustrationEscalation, etc.",
  },
  {
    path: "lib/intent-detector.js",
    role: "Détection d'intent par mots-clés (REPROG, E85, FAP, EGR, ADBLUE, DIAG, AUTRES, SAV). Distingue prospect vs SAV (SAV = client existant, réclamation liée à une prestation déjà réalisée). Fournit aussi une variante « loose » pour matcher malgré fautes/formulations.",
    deps: [],
    exports: "INTENT_MAP, detectIntent, detectIntentLoose, detectIntentsAll, intentToPrestationCode, intentToLabel.",
  },
  {
    path: "lib/intent-router.js",
    role: "Parseur et validateur du routing automatique LLM → flows. Autorise le LLM à cibler un état précis (`WAITING_PLATE`, `WAITING_VEHICLE_CONFIRM`, `WAITING_QUOTE_CONFIRM`…) avec des données pré-extraites, en garantissant sécurité et cohérence.",
    deps: [],
    exports: "parseRoutingInstruction, createInitialStateFromRoute, isRoutingSafe, canSkipStep, buildRoutingInstructions, VALID_INTENTS, VALID_STATES.",
  },
  {
    path: "lib/llm-service.js",
    role: "Cœur LLM : construit le prompt système (savoir baké + RAG + mémoire client + diagnostic), applique le rate-limiting par utilisateur (40 appels/min), appelle Claude Haiku via l'API Anthropic avec sortie structurée `{intent|answer|route}`, et journalise les hallucinations via les détecteurs.",
    deps: ["rag", "conversation-memory", "diagnostic-helper", "intent-router"],
    exports: "initLlmService, askLLM, isLikelyQuestion, LLM_SYSTEM_PROMPT.",
  },
  {
    path: "lib/logger.js",
    role: "Logger structuré centralisé, zéro dépendance. Format ISO + niveau + `[wa_id]` + JSON meta. Respecte `LOG_LEVEL` (debug/info/warn/error).",
    deps: [],
    exports: "log, LOG_LEVELS.",
  },
  {
    path: "lib/media-builders.js",
    role: "Construit les payloads médias WhatsApp riches : image véhicule, liste menu, géocodage adresse (api-adresse.data.gouv.fr) et estimation de trajet vers le garage de Villenoy.",
    deps: ["vehicle-service"],
    exports: "initMediaBuilders, sendVehicleCard, sendMenuList, geocodeAddress, etc.",
  },
  {
    path: "lib/pdf-service.js",
    role: "Génère le PDF de devis via pdfkit (mise en page A4, couleurs de marque, tableau prestation, mentions légales) puis upload media WhatsApp + envoi document.",
    deps: [],
    ext: ["path", "fs", "pdfkit (lazy)"],
    exports: "initPdfService, generateQuotePdf, sendQuotePdf.",
  },
  {
    path: "lib/plate-extractor.js",
    role: "Extraction intelligente de plaques françaises SIV (`AA-123-AA`) dans du texte libre. Gère plusieurs formats (collé, espacé, ponctué), extrait toutes les occurrences ou juste la première, valide/normalise le résultat.",
    deps: [],
    exports: "extractPlates, extractFirstPlate, extractAndValidatePlate, hasPlateMention, removePlateFromText, normalizePlate, isValidPlate.",
  },
  {
    path: "lib/plate-utils.js",
    role: "Utilitaires plaques minimalistes (normalisation + validation stricte format SIV). Version simplifiée sans extraction en contexte — voir [[plate-extractor]] pour l'extraction depuis texte libre.",
    deps: [],
    exports: "normalizePlate, validatePlate.",
  },
  {
    path: "lib/relance-service.js",
    role: "Cron de relances des devis « draft » créés depuis plus de 24h et non encore relancés. Envoie un message WhatsApp de rappel puis marque `relance_sent_at`.",
    deps: [],
    exports: "initRelanceService, runRelances.",
  },
  {
    path: "lib/sentiment-detector.js",
    role: "Détecte frustration, colère, urgence ou demandes explicites d'escalade humaine dans les messages entrants. Renvoie score + signal structuré pour décider : continuer, proposer escalade, ou escalade auto immédiate.",
    deps: [],
    exports: "detectSentiment, FRUSTRATION_PATTERNS.",
  },
  {
    path: "lib/sentry.js",
    role: "Init Sentry conditionnel (no-op si `SENTRY_DSN` absent). Sentry v10 auto-capture uncaughtException + unhandledRejection. Doit être requis en tout premier dans `server.js`.",
    deps: [],
    ext: ["@sentry/node (lazy)", "crypto"],
    exports: "initSentry, captureException, setupExpressErrorHandler.",
  },
  {
    path: "lib/signature.js",
    role: "Vérifie la signature HMAC-SHA256 des webhooks Meta (`x-hub-signature-256`) contre le body BRUT et `META_APP_SECRET`. Comparaison en temps constant (`timingSafeEqual`). Sans ça, n'importe qui peut injecter de faux messages.",
    deps: [],
    ext: ["crypto"],
    exports: "verifyMetaSignature.",
  },
  {
    path: "lib/text-helpers.js",
    role: "Helpers texte purs : détection greeting/reset, extraction du texte d'un message WhatsApp (text/button/interactive), extraction d'ID interactif, confirmation/déni, extraction de contact (email/téléphone/nom), normalisation plaque, validation email.",
    deps: [],
    exports: "isGreeting, isGreetingOrReset, extractInboundText, extractInteractiveId, isConfirmation, isDenial, extractContactFromText, normalizePlate, validatePlate, validateEmail.",
  },
  {
    path: "lib/vehicle-card.js",
    role: "Génère la fiche performance véhicule affichée après identification de la plaque, et les messages « analyse en cours ». Réplique la règle de compat AdBlue de [[vehicle-service]] pour ne pas promettre une prestation refusée ensuite par le flow.",
    deps: ["vehicle-service"],
    exports: "buildVehiclePerformanceCard, buildAnalysisStartMessage, buildAnalysisProgressMessage.",
  },
  {
    path: "lib/vehicle-service.js",
    role: "Service véhicule central : lookup par plaque (API immatriculation), lookup stages reprog (Shiftech), calcul des prix par prestation, validation de compatibilité intent/véhicule (essence vs diesel, AdBlue SCR, année), options upsell.",
    deps: ["text-helpers"],
    exports: "initVehicleService, lookupVehicleFromPlate, lookupReprogStages, computeReprogPrice/E85/Adblue/Egr/FapPrice, validateIntentForVehicle, getUpsellOptionsForVehicle, buildVehicleOnlyText, UPSELL_OPTIONS, INTENT_VEHICLE_REQUIREMENTS, STAGE1_FIXED_PRICE_CENTS, TTC_INTENTS, CUSTOM_QUOTE_STAGES, _isDieselVehicle, _isEssenceVehicle, _hasAdBlueSystem, formatStageLabel.",
  },
  {
    path: "lib/voice-handler.js",
    role: "Gestion complète des messages vocaux : transcription Whisper via Groq (free tier), détection de langue, gestion des fichiers volumineux (max 20 MB), fallback erreur, formatage pour affichage/LLM et TTS optionnel.",
    deps: [],
    exports: "VOICE_TYPES, SUPPORTED_LANGUAGES, transcribeVoice, formatTranscriptForDisplay, prepareForLLM, isTranscriptValid, getErrorMessage, isTranscript, detectLanguageFromText, getLangFlag.",
  },
  {
    path: "lib/whatsapp-client.js",
    role: "Wrapper minimaliste de la WhatsApp Cloud API : envoi texte, boutons interactifs, listes, images, documents, upload media. Retry automatique (2 tentatives, 600 ms). Persiste chaque outbound via `insertOutboundMessage`.",
    deps: [],
    exports: "initWhatsAppClient, sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppList, sendWhatsAppImage, sendWhatsAppDocument, uploadWhatsAppMedia.",
  },

  // ── memoire/ (scripts Python) ────────────────────────────────────
  {
    path: "memoire/build_annexes_doc.py",
    role: "Génère `Annexes_Hischem_DiagPerf.docx` — annexes complètes et autonomes du mémoire (schémas, tableaux, captures).",
    deps: [],
    ext: ["json", "python-docx", "Pillow"],
  },
  {
    path: "memoire/build_docx.py",
    role: "Convertit `memoire.md` → `Memoire_Hischem_DiagPerf.docx` (Calibri 12, interligne 1,25, sommaire auto, pagination, styles Word).",
    deps: [],
    ext: ["re", "python-docx", "Pillow"],
  },
  {
    path: "memoire/build_pdf.py",
    role: "Convertit un Markdown de soutenance en PDF via markdown → HTML → xhtml2pdf. Nettoie les emoji non rendus par le moteur PDF.",
    deps: [],
    ext: ["re", "os", "sys", "markdown", "xhtml2pdf", "reportlab"],
  },
  {
    path: "memoire/build_slides.py",
    role: "Génère la soutenance `Soutenance_Hischem_DiagPerf.pptx` : 17 diapos, figures intégrées, palette navy/teal.",
    deps: [],
    ext: ["python-pptx", "Pillow"],
  },

  // ── migrations/ ──────────────────────────────────────────────────
  {
    path: "migrations/001_devis_tracking.sql",
    role: "Migration : enrichit la table `devis` avec le suivi client (customer_name, customer_email, rdv_date, admin_notes) et les colonnes de statut avancées.",
    deps: [],
    notes: "Table consommée par [[devis-service]], [[dashboard]], [[relance-service]].",
  },
  {
    path: "migrations/001_kb_chunks.sql",
    role: "Migration : active l'extension pgvector et crée la table `kb_chunks` (id, file_path, content, embedding, intent…) pour le RAG.",
    deps: [],
    notes: "Alimentée par [[ingest]], requêtée par [[rag]].",
  },
  {
    path: "migrations/002_kb_fulltext_search.sql",
    role: "Migration : ajoute la colonne `fts_content TSVECTOR` (français) sur `kb_chunks` pour la recherche full-text hybride combinée à pgvector.",
    deps: [],
    notes: "Utilisée par le retrieval hybride de [[rag]].",
  },

  // ── public/ ──────────────────────────────────────────────────────
  {
    path: "public/sw.js",
    role: "Service worker PWA du dashboard client (`/app.html`). Précache l'app shell et le manifest, bypass les requêtes `/api/`, expulse les vieux caches à l'activation.",
    deps: [],
  },

  // ── routes/ ──────────────────────────────────────────────────────
  {
    path: "routes/dashboard.js",
    role: "Router Express du dashboard admin + API client. Expose SSE temps réel (`/api/dashboard/events`), CRUD devis/conversations, filtres, exports. Auth via `DASHBOARD_TOKEN`.",
    deps: ["config/index"],
    ext: ["express", "node-fetch"],
    exports: "createDashboardRouter (renvoie router, broadcastDashboardEvent, sseClients).",
  },
  {
    path: "routes/webhook.js",
    role: "Router `/webhook` Meta : verify challenge (GET) + réception (POST). Verrou par `wa_id` (60s) pour éviter les double-traitements sur POST concurrents. Route via LLM (`type=route`), applique les fallbacks intent, dispatch vers les flows prestation/sav.",
    deps: [
      "text-helpers", "intent-router", "conversation-memory",
      "plate-extractor", "intent-detector",
    ],
    exports: "createWebhookHandler.",
  },

  // ── scripts/ ─────────────────────────────────────────────────────
  {
    path: "scripts/generate-creatomate-templates.js",
    role: "Génère les 3 templates Creatomate (E85, FAP, ADBLUE) par dérivation du template REPROG premium. Structure partagée en 6 scènes documentée en tête.",
    deps: [],
    ext: ["fs", "path"],
  },
  {
    path: "scripts/re-embed-kb.js",
    role: "Regénère tous les embeddings de `kb_chunks` avec Google `gemini-embedding-001` (384 dims). À lancer après changement de modèle d'embedding.",
    deps: [],
    ext: ["dotenv", "@supabase/supabase-js", "@google/genai"],
  },

  // ── sql/ ─────────────────────────────────────────────────────────
  {
    path: "sql/add_idempotency_key.sql",
    role: "Ajoute `idempotency_key` sur `devis` + index unique pour prévenir la double-création lors de retries webhook.",
    deps: [],
  },
  {
    path: "sql/create_conversation_state.sql",
    role: "Crée la table `conversation_state` (wa_id PK, state, intent, data JSONB, updated_at) qui pilote la machine à états du flow.",
    deps: [],
    notes: "Manipulée par [[conversation-service]].",
  },
  {
    path: "sql/create_devis_table.sql",
    role: "Crée la table `devis` (id, devis_id, wa_id, prestation, plate, montants…). À exécuter seulement si absente.",
    deps: [],
  },
  {
    path: "sql/create_review_requests.sql",
    role: "Crée `review_requests` : file d'attente des demandes d'avis client envoyées 48h après une prestation terminée.",
    deps: [],
  },
  {
    path: "sql/create_sav_tickets.sql",
    role: "Crée la table `sav_tickets` (status, topic, coordonnées…) alimentée par le flow SAV.",
    deps: [],
    notes: "Écrite par [[sav]].",
  },
  {
    path: "sql/create_tarifs_prestations.sql",
    role: "Seed des lignes de `prestations` + `tarifs_prestations` (ne crée pas les tables). Source de vérité des prix consommée par [[devis-service]].",
    deps: [],
  },
  {
    path: "sql/migrate_devis_generic.sql",
    role: "Migration : ajoute `prestation_code` et `wa_id` sur `devis` (+ index) pour supporter le flow générique multi-prestations.",
    deps: [],
  },

  // ── tests/ ───────────────────────────────────────────────────────
  {
    path: "tests/escalation-diag.test.js",
    role: "Test unitaire : escalade frustration → notification garage sur un cas diagnostic.",
    deps: ["event-handlers"],
    ext: ["assert"],
  },
  {
    path: "tests/guards-friction.test.js",
    role: "Tests des garde-fous « friction » : `isConfirmation`, `isDenial`, `isLikelyQuestion` pour éviter les faux positifs dans les flows.",
    deps: ["text-helpers", "llm-service"],
    ext: ["assert"],
  },
  {
    path: "tests/helpers.test.js",
    role: "Tests unitaires du module racine [[helpers]] (plaques, greetings, calculs de prix, validation email).",
    deps: ["helpers"],
    ext: ["assert"],
  },
  {
    path: "tests/intent-ambiguity.test.js",
    role: "Tests d'ambiguïté d'intent : messages multi-intents, formulations floues, cas limites de `detectIntent` / `detectIntentLoose` / `detectIntentsAll`.",
    deps: ["intent-detector"],
    ext: ["assert"],
  },
  {
    path: "tests/intent-detector.test.js",
    role: "Tests unitaires de `detectIntent` — mapping mots-clés → intent (REPROG, E85, FAP, EGR, ADBLUE, DIAG, SAV, AUTRES).",
    deps: ["intent-detector"],
    ext: ["assert"],
  },
  {
    path: "tests/intent-router.test.js",
    role: "Tests unitaires du parseur de routing LLM → flow (`parseRoutingInstruction`, `isRoutingSafe`, `createInitialStateFromRoute`, `canSkipStep`).",
    deps: ["intent-router"],
  },
  {
    path: "tests/llm-fallback-degrade.test.js",
    role: "Tests de dégradation : quand le LLM échoue ou retourne du texte brut, le webhook doit fallback proprement sur `detectIntent` + `parseRoutingInstruction` + extraction plaque.",
    deps: ["intent-router", "intent-detector", "plate-extractor"],
    ext: ["assert"],
  },
  {
    path: "tests/llm-plaintext-fallback.test.js",
    role: "Test : quand Haiku répond en texte brut au lieu du JSON structuré, `askLLM` doit normaliser en `{type:'answer', text:...}` sans crasher.",
    deps: ["llm-service"],
    ext: ["assert"],
  },
  {
    path: "tests/llm-routing-integration.test.js",
    role: "Tests d'intégration LLM → routing : scénarios réels de messages clients (plaque + intent + année) → `parseRoutingInstruction` → `createInitialStateFromRoute`.",
    deps: ["intent-router"],
  },
  {
    path: "tests/plate-extractor.test.js",
    role: "Tests unitaires de [[plate-extractor]] (formats SIV avec/sans tirets/espaces, extraction en contexte, normalisation, validation).",
    deps: ["plate-extractor"],
  },
  {
    path: "tests/signature.test.js",
    role: "Tests unitaires de `verifyMetaSignature` — HMAC-SHA256, header absent, secret absent, signature invalide, timing-safe.",
    deps: ["signature"],
    ext: ["assert", "crypto"],
  },
  {
    path: "tests/vehicle-incompat-switch.test.js",
    role: "Test régression : quand l'intent choisi est incompatible avec le véhicule identifié (ex: E85 sur diesel), le flow doit proposer un switch au lieu de bloquer.",
    deps: ["prestation", "vehicle-service"],
    ext: ["assert"],
  },
  {
    path: "tests/vehicle-pricing.test.js",
    role: "Tests critiques des calculs de prix : `computeReprogPrice`, `computeE85Price`, `computeAdbluePrice`, `computeEgrPrice`, `computeFapPrice`, ainsi que les helpers `_isDieselVehicle`, `_isEssenceVehicle`, `_hasAdBlueSystem`.",
    deps: ["vehicle-service"],
  },
  {
    path: "tests/voice-handler.test.js",
    role: "Tests unitaires du module [[voice-handler]] : `VOICE_TYPES`, `SUPPORTED_LANGUAGES`, `formatTranscriptForDisplay`, `prepareForLLM`, `isTranscriptValid`, `getErrorMessage`, `detectLanguageFromText`, `getLangFlag`.",
    deps: ["voice-handler"],
  },
];

// ────────────────────────────────────────────────────────────────────────
// Normalisation des noms → basename sans extension pour le wikilink
// ────────────────────────────────────────────────────────────────────────
function toNoteName(refPath) {
  // Cas particulier : config/index.{js,} → nom non ambigu "config-index"
  if (refPath === "config/index" || refPath === "config/index.js") return "config-index";
  return path.basename(refPath).replace(/\.(js|py|sql|mjs|cjs)$/, "");
}

// Table des consommateurs (reverse deps)
const consumers = new Map();
for (const f of FILES) {
  for (const dep of f.deps || []) {
    const key = toNoteName(dep);
    if (!consumers.has(key)) consumers.set(key, new Set());
    consumers.get(key).add(toNoteName(f.path));
  }
}

function renderNote(f) {
  const noteName = toNoteName(f.path);
  const deps = (f.deps || []).map(toNoteName);
  const cons = [...(consumers.get(noteName) || [])].sort();

  const lines = [];
  lines.push("---");
  lines.push(`path: ${f.path}`);
  lines.push("tags: [diagperf-webhook, source-code]");
  lines.push("---");
  lines.push("");
  lines.push(`# ${noteName}`);
  lines.push("");
  lines.push(`> \`${f.path}\``);
  lines.push("");
  lines.push("## Rôle");
  lines.push("");
  lines.push(f.role);
  lines.push("");

  if (f.exports) {
    lines.push("## Exports");
    lines.push("");
    lines.push(f.exports);
    lines.push("");
  }

  lines.push("## Dépendances internes");
  lines.push("");
  if (deps.length === 0) {
    lines.push("_Aucune (module feuille)._");
  } else {
    for (const d of deps) lines.push(`- [[${d}]]`);
  }
  lines.push("");

  if (f.ext && f.ext.length) {
    lines.push("## Dépendances externes / stdlib");
    lines.push("");
    for (const e of f.ext) lines.push(`- \`${e}\``);
    lines.push("");
  }

  lines.push("## Consommateurs (reverse)");
  lines.push("");
  if (cons.length === 0) {
    lines.push("_Aucun module interne recensé ne l'importe._");
  } else {
    for (const c of cons) lines.push(`- [[${c}]]`);
  }
  lines.push("");

  if (f.notes) {
    lines.push("## Notes");
    lines.push("");
    lines.push(f.notes);
    lines.push("");
  }

  return lines.join("\n");
}

function renderIndex() {
  const groups = {};
  for (const f of FILES) {
    const dir = path.dirname(f.path) === "." ? "(racine)" : path.dirname(f.path);
    (groups[dir] = groups[dir] || []).push(f);
  }
  const dirs = Object.keys(groups).sort();

  const lines = [];
  lines.push("---");
  lines.push("tags: [diagperf-webhook, index]");
  lines.push("---");
  lines.push("");
  lines.push("# Index — diagperf-webhook");
  lines.push("");
  lines.push(`${FILES.length} fichiers de code source cartographiés. Chaque note contient rôle, exports, dépendances internes ([[wikilinks]]), dépendances externes et consommateurs inverses.`);
  lines.push("");
  for (const dir of dirs) {
    lines.push(`## ${dir}`);
    lines.push("");
    for (const f of groups[dir].sort((a, b) => a.path.localeCompare(b.path))) {
      const name = toNoteName(f.path);
      lines.push(`- [[${name}]] — ${f.role.split(". ")[0]}.`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────
// Écriture
// ────────────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const f of FILES) {
  const noteName = toNoteName(f.path);
  const outPath = path.join(OUT_DIR, `${noteName}.md`);
  fs.writeFileSync(outPath, renderNote(f), "utf8");
}
fs.writeFileSync(path.join(OUT_DIR, "_index.md"), renderIndex(), "utf8");

// Sanity check : chaque wikilink cible doit exister
const noteNames = new Set(FILES.map((f) => toNoteName(f.path)));
const broken = [];
for (const f of FILES) {
  for (const dep of f.deps || []) {
    const target = toNoteName(dep);
    if (!noteNames.has(target)) broken.push({ from: toNoteName(f.path), to: target });
  }
}
if (broken.length) {
  console.warn(`⚠️ ${broken.length} lien(s) brisé(s) :`);
  for (const b of broken) console.warn(`   [[${b.from}]] → [[${b.to}]]`);
} else {
  console.log("✅ Tous les wikilinks pointent vers une note existante");
}

console.log(`✅ ${FILES.length} notes générées dans ${OUT_DIR}/`);
