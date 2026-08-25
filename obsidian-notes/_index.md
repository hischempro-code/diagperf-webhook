---
tags: [diagperf-webhook, index]
---

# Index — diagperf-webhook

71 fichiers de code source cartographiés. Chaque note contient rôle, exports, dépendances internes ([[wikilinks]]), dépendances externes et consommateurs inverses.

## (racine)

- [[helpers]] — Aggregat historique de helpers purs (plaques, greetings, extraction texte WhatsApp, calculs de prix).
- [[ingest]] — Pipeline d'ingestion de la base de connaissances.
- [[rag]] — Module de retrieval du bot.
- [[server]] — Point d'entrée Express du webhook DiagPerf.
- [[test-rag]] — Script CLI de smoke-test du pipeline RAG complet (embed → pgvector → format).

## benchmark

- [[prompts]] — Définit les 4 variantes de prompt système du mini-benchmark V1 vs V2 (A-V1, A-V2, B-noRAG, B-RAG).
- [[rejudge]] — Recharge un `raw-*.json` de run existant et re-note UNIQUEMENT chaque réponse stockée avec un juge LLM plus fort (Opus 4.8 par défaut), sans rappeler Claude pour générer..
- [[run-benchmark]] — Runner du mini-benchmark V1 vs V2 (RAG) pour le mémoire.

## config

- [[config-index]] — Configuration centralisée.

## eval

- [[detectors]] — Détecteurs d'hallucination déterministes (fonctions pures, sans réseau).
- [[detectors.test]] — Tests hors-ligne des détecteurs d'hallucination.
- [[run-eval]] — Harnais de non-régression anti-hallucination en LIVE.

## flows

- [[prestation]] — Machine à états du parcours prospect (REPROG/E85/FAP/EGR/ADBLUE).
- [[sav]] — Machine à états du flow SAV pour clients existants (réclamations, tickets).

## lib

- [[conversation-memory]] — Mémoire long-terme par client stockée dans `conversations.contexte_json` (pas de nouvelle table).
- [[conversation-service]] — CRUD léger sur la table `conversation_state` (état actif du flow conversationnel par `wa_id`).
- [[creatomateVideo]] — Rendering de vidéos personnalisées via l'API Creatomate.
- [[devis-service]] — Persistance des devis dans Supabase (`devis`, `tarifs_prestations`, `prestations`).
- [[diagnostic-helper]] — Pré-analyse un message client : extrait les codes défauts OBD-II (DTC), le kilométrage et les symptômes courants (voyant moteur, fumée, perte puissance…).
- [[email-service]] — Client HTTP Brevo pour envoi d'emails (client + garage) : PDF devis, notifications SAV, confirmations.
- [[event-handlers]] — Handlers WhatsApp génériques : notification garage (email, WhatsApp désactivé par défaut à cause des templates Meta), escalade frustration/humain, gestion des boutons interactifs..
- [[intent-detector]] — Détection d'intent par mots-clés (REPROG, E85, FAP, EGR, ADBLUE, DIAG, AUTRES, SAV).
- [[intent-router]] — Parseur et validateur du routing automatique LLM → flows.
- [[llm-service]] — Cœur LLM : construit le prompt système (savoir baké + RAG + mémoire client + diagnostic), applique le rate-limiting par utilisateur (40 appels/min), appelle Claude Haiku via l'API Anthropic avec sortie structurée `{intent|answer|route}`, et journalise les hallucinations via les détecteurs..
- [[logger]] — Logger structuré centralisé, zéro dépendance.
- [[media-builders]] — Construit les payloads médias WhatsApp riches : image véhicule, liste menu, géocodage adresse (api-adresse.data.gouv.fr) et estimation de trajet vers le garage de Villenoy..
- [[pdf-service]] — Génère le PDF de devis via pdfkit (mise en page A4, couleurs de marque, tableau prestation, mentions légales) puis upload media WhatsApp + envoi document..
- [[plate-extractor]] — Extraction intelligente de plaques françaises SIV (`AA-123-AA`) dans du texte libre.
- [[plate-utils]] — Utilitaires plaques minimalistes (normalisation + validation stricte format SIV).
- [[relance-service]] — Cron de relances des devis « draft » créés depuis plus de 24h et non encore relancés.
- [[sentiment-detector]] — Détecte frustration, colère, urgence ou demandes explicites d'escalade humaine dans les messages entrants.
- [[sentry]] — Init Sentry conditionnel (no-op si `SENTRY_DSN` absent).
- [[signature]] — Vérifie la signature HMAC-SHA256 des webhooks Meta (`x-hub-signature-256`) contre le body BRUT et `META_APP_SECRET`.
- [[text-helpers]] — Helpers texte purs : détection greeting/reset, extraction du texte d'un message WhatsApp (text/button/interactive), extraction d'ID interactif, confirmation/déni, extraction de contact (email/téléphone/nom), normalisation plaque, validation email..
- [[vehicle-card]] — Génère la fiche performance véhicule affichée après identification de la plaque, et les messages « analyse en cours ».
- [[vehicle-service]] — Service véhicule central : lookup par plaque (API immatriculation), lookup stages reprog (Shiftech), calcul des prix par prestation, validation de compatibilité intent/véhicule (essence vs diesel, AdBlue SCR, année), options upsell..
- [[voice-handler]] — Gestion complète des messages vocaux : transcription Whisper via Groq (free tier), détection de langue, gestion des fichiers volumineux (max 20 MB), fallback erreur, formatage pour affichage/LLM et TTS optionnel..
- [[whatsapp-client]] — Wrapper minimaliste de la WhatsApp Cloud API : envoi texte, boutons interactifs, listes, images, documents, upload media.

## memoire

- [[build_annexes_doc]] — Génère `Annexes_Hischem_DiagPerf.docx` — annexes complètes et autonomes du mémoire (schémas, tableaux, captures)..
- [[build_docx]] — Convertit `memoire.md` → `Memoire_Hischem_DiagPerf.docx` (Calibri 12, interligne 1,25, sommaire auto, pagination, styles Word)..
- [[build_pdf]] — Convertit un Markdown de soutenance en PDF via markdown → HTML → xhtml2pdf.
- [[build_slides]] — Génère la soutenance `Soutenance_Hischem_DiagPerf.pptx` : 17 diapos, figures intégrées, palette navy/teal..

## migrations

- [[001_devis_tracking]] — Migration : enrichit la table `devis` avec le suivi client (customer_name, customer_email, rdv_date, admin_notes) et les colonnes de statut avancées..
- [[001_kb_chunks]] — Migration : active l'extension pgvector et crée la table `kb_chunks` (id, file_path, content, embedding, intent…) pour le RAG..
- [[002_kb_fulltext_search]] — Migration : ajoute la colonne `fts_content TSVECTOR` (français) sur `kb_chunks` pour la recherche full-text hybride combinée à pgvector..

## public

- [[sw]] — Service worker PWA du dashboard client (`/app.html`).

## routes

- [[dashboard]] — Router Express du dashboard admin + API client.
- [[webhook]] — Router `/webhook` Meta : verify challenge (GET) + réception (POST).

## scripts

- [[generate-creatomate-templates]] — Génère les 3 templates Creatomate (E85, FAP, ADBLUE) par dérivation du template REPROG premium.
- [[re-embed-kb]] — Regénère tous les embeddings de `kb_chunks` avec Google `gemini-embedding-001` (384 dims).

## sql

- [[add_idempotency_key]] — Ajoute `idempotency_key` sur `devis` + index unique pour prévenir la double-création lors de retries webhook..
- [[create_conversation_state]] — Crée la table `conversation_state` (wa_id PK, state, intent, data JSONB, updated_at) qui pilote la machine à états du flow..
- [[create_devis_table]] — Crée la table `devis` (id, devis_id, wa_id, prestation, plate, montants…).
- [[create_review_requests]] — Crée `review_requests` : file d'attente des demandes d'avis client envoyées 48h après une prestation terminée..
- [[create_sav_tickets]] — Crée la table `sav_tickets` (status, topic, coordonnées…) alimentée par le flow SAV..
- [[create_tarifs_prestations]] — Seed des lignes de `prestations` + `tarifs_prestations` (ne crée pas les tables).
- [[migrate_devis_generic]] — Migration : ajoute `prestation_code` et `wa_id` sur `devis` (+ index) pour supporter le flow générique multi-prestations..

## tests

- [[escalation-diag.test]] — Test unitaire : escalade frustration → notification garage sur un cas diagnostic..
- [[guards-friction.test]] — Tests des garde-fous « friction » : `isConfirmation`, `isDenial`, `isLikelyQuestion` pour éviter les faux positifs dans les flows..
- [[helpers.test]] — Tests unitaires du module racine [[helpers]] (plaques, greetings, calculs de prix, validation email)..
- [[intent-ambiguity.test]] — Tests d'ambiguïté d'intent : messages multi-intents, formulations floues, cas limites de `detectIntent` / `detectIntentLoose` / `detectIntentsAll`..
- [[intent-detector.test]] — Tests unitaires de `detectIntent` — mapping mots-clés → intent (REPROG, E85, FAP, EGR, ADBLUE, DIAG, SAV, AUTRES)..
- [[intent-router.test]] — Tests unitaires du parseur de routing LLM → flow (`parseRoutingInstruction`, `isRoutingSafe`, `createInitialStateFromRoute`, `canSkipStep`)..
- [[llm-fallback-degrade.test]] — Tests de dégradation : quand le LLM échoue ou retourne du texte brut, le webhook doit fallback proprement sur `detectIntent` + `parseRoutingInstruction` + extraction plaque..
- [[llm-plaintext-fallback.test]] — Test : quand Haiku répond en texte brut au lieu du JSON structuré, `askLLM` doit normaliser en `{type:'answer', text:...}` sans crasher..
- [[llm-routing-integration.test]] — Tests d'intégration LLM → routing : scénarios réels de messages clients (plaque + intent + année) → `parseRoutingInstruction` → `createInitialStateFromRoute`..
- [[plate-extractor.test]] — Tests unitaires de [[plate-extractor]] (formats SIV avec/sans tirets/espaces, extraction en contexte, normalisation, validation)..
- [[signature.test]] — Tests unitaires de `verifyMetaSignature` — HMAC-SHA256, header absent, secret absent, signature invalide, timing-safe..
- [[vehicle-incompat-switch.test]] — Test régression : quand l'intent choisi est incompatible avec le véhicule identifié (ex: E85 sur diesel), le flow doit proposer un switch au lieu de bloquer..
- [[vehicle-pricing.test]] — Tests critiques des calculs de prix : `computeReprogPrice`, `computeE85Price`, `computeAdbluePrice`, `computeEgrPrice`, `computeFapPrice`, ainsi que les helpers `_isDieselVehicle`, `_isEssenceVehicle`, `_hasAdBlueSystem`..
- [[voice-handler.test]] — Tests unitaires du module [[voice-handler]] : `VOICE_TYPES`, `SUPPORTED_LANGUAGES`, `formatTranscriptForDisplay`, `prepareForLLM`, `isTranscriptValid`, `getErrorMessage`, `detectLanguageFromText`, `getLangFlag`..
