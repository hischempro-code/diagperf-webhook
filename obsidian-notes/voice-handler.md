---
path: lib/voice-handler.js
tags: [diagperf-webhook, source-code]
---

# voice-handler

> `lib/voice-handler.js`

## Rôle

Gestion complète des messages vocaux : transcription Whisper via Groq (free tier), détection de langue, gestion des fichiers volumineux (max 20 MB), fallback erreur, formatage pour affichage/LLM et TTS optionnel.

## Exports

VOICE_TYPES, SUPPORTED_LANGUAGES, transcribeVoice, formatTranscriptForDisplay, prepareForLLM, isTranscriptValid, getErrorMessage, isTranscript, detectLanguageFromText, getLangFlag.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[voice-handler.test]]
