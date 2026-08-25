---
path: eval/run-eval.js
tags: [diagperf-webhook, source-code]
---

# run-eval

> `eval/run-eval.js`

## Rôle

Harnais de non-régression anti-hallucination en LIVE. Rejoue chaque cas de `eval/cases.json` à travers le vrai `askLLM` (mêmes prompt, RAG, garde-fous), puis note la réponse via les détecteurs, required/forbidden, et type_in.

## Dépendances internes

- [[detectors]]
- [[llm-service]]

## Dépendances externes / stdlib

- `fs`
- `path`
- `dotenv`
- `@supabase/supabase-js`
- `node-fetch`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
