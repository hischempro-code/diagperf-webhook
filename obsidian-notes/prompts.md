---
path: benchmark/prompts.js
tags: [diagperf-webhook, source-code]
---

# prompts

> `benchmark/prompts.js`

## Rôle

Définit les 4 variantes de prompt système du mini-benchmark V1 vs V2 (A-V1, A-V2, B-noRAG, B-RAG). Réimporte le prompt actuel depuis `llm-service` pour rester en phase avec la prod.

## Exports

PROMPT_V1, PROMPT_V2, PROMPT_B_STRIPPED.

## Dépendances internes

- [[llm-service]]

## Consommateurs (reverse)

- [[run-benchmark]]
