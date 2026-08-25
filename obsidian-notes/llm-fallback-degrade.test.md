---
path: tests/llm-fallback-degrade.test.js
tags: [diagperf-webhook, source-code]
---

# llm-fallback-degrade.test

> `tests/llm-fallback-degrade.test.js`

## Rôle

Tests de dégradation : quand le LLM échoue ou retourne du texte brut, le webhook doit fallback proprement sur `detectIntent` + `parseRoutingInstruction` + extraction plaque.

## Dépendances internes

- [[intent-router]]
- [[intent-detector]]
- [[plate-extractor]]

## Dépendances externes / stdlib

- `assert`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
