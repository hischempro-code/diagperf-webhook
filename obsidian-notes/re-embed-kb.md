---
path: scripts/re-embed-kb.js
tags: [diagperf-webhook, source-code]
---

# re-embed-kb

> `scripts/re-embed-kb.js`

## Rôle

Regénère tous les embeddings de `kb_chunks` avec Google `gemini-embedding-001` (384 dims). À lancer après changement de modèle d'embedding.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `dotenv`
- `@supabase/supabase-js`
- `@google/genai`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
