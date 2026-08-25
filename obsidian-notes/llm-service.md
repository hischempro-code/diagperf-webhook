---
path: lib/llm-service.js
tags: [diagperf-webhook, source-code]
---

# llm-service

> `lib/llm-service.js`

## Rôle

Cœur LLM : construit le prompt système (savoir baké + RAG + mémoire client + diagnostic), applique le rate-limiting par utilisateur (40 appels/min), appelle Claude Haiku via l'API Anthropic avec sortie structurée `{intent|answer|route}`, et journalise les hallucinations via les détecteurs.

## Exports

initLlmService, askLLM, isLikelyQuestion, LLM_SYSTEM_PROMPT.

## Dépendances internes

- [[rag]]
- [[conversation-memory]]
- [[diagnostic-helper]]
- [[intent-router]]

## Consommateurs (reverse)

- [[guards-friction.test]]
- [[llm-plaintext-fallback.test]]
- [[prestation]]
- [[prompts]]
- [[run-eval]]
- [[sav]]
