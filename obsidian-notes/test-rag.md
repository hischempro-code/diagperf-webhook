---
path: test-rag.js
tags: [diagperf-webhook, source-code]
---

# test-rag

> `test-rag.js`

## Rôle

Script CLI de smoke-test du pipeline RAG complet (embed → pgvector → format). Prend une question en argument, imprime les chunks et la version formatée du contexte.

## Dépendances internes

- [[rag]]

## Dépendances externes / stdlib

- `dotenv`
- `@supabase/supabase-js`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
