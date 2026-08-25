---
path: benchmark/run-benchmark.js
tags: [diagperf-webhook, source-code]
---

# run-benchmark

> `benchmark/run-benchmark.js`

## Rôle

Runner du mini-benchmark V1 vs V2 (RAG) pour le mémoire. Passe chaque question de `benchmark/questions.json` dans les 4 conditions et mesure exactitude, hallucinations, latence, coût.

## Dépendances internes

- [[rag]]
- [[prompts]]

## Dépendances externes / stdlib

- `dotenv`
- `fs`
- `path`
- `@supabase/supabase-js`
- `node-fetch`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
