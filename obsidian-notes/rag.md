---
path: rag.js
tags: [diagperf-webhook, source-code]
---

# rag

> `rag.js`

## Rôle

Module de retrieval du bot. Génère les embeddings via Google Gemini, appelle Supabase pgvector + FTS pour retrouver les chunks pertinents, et formate le contexte pour injection dans le prompt système. Fournit aussi les synonymes FR/EN pour améliorer le rappel.

## Exports

retrieveContext, formatContextForPrompt, generateEmbedding, preloadEmbedder.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `@google/genai`

## Consommateurs (reverse)

- [[ingest]]
- [[llm-service]]
- [[run-benchmark]]
- [[server]]
- [[test-rag]]

## Notes

Consommé par [[server]], [[ingest]], [[llm-service]], [[test-rag]], [[run-benchmark]].
