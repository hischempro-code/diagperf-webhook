---
path: lib/intent-router.js
tags: [diagperf-webhook, source-code]
---

# intent-router

> `lib/intent-router.js`

## Rôle

Parseur et validateur du routing automatique LLM → flows. Autorise le LLM à cibler un état précis (`WAITING_PLATE`, `WAITING_VEHICLE_CONFIRM`, `WAITING_QUOTE_CONFIRM`…) avec des données pré-extraites, en garantissant sécurité et cohérence.

## Exports

parseRoutingInstruction, createInitialStateFromRoute, isRoutingSafe, canSkipStep, buildRoutingInstructions, VALID_INTENTS, VALID_STATES.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[intent-router.test]]
- [[llm-fallback-degrade.test]]
- [[llm-routing-integration.test]]
- [[llm-service]]
- [[server]]
- [[webhook]]
