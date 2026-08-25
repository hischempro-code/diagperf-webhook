---
path: tests/llm-plaintext-fallback.test.js
tags: [diagperf-webhook, source-code]
---

# llm-plaintext-fallback.test

> `tests/llm-plaintext-fallback.test.js`

## Rôle

Test : quand Haiku répond en texte brut au lieu du JSON structuré, `askLLM` doit normaliser en `{type:'answer', text:...}` sans crasher.

## Dépendances internes

- [[llm-service]]

## Dépendances externes / stdlib

- `assert`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
