---
path: lib/conversation-memory.js
tags: [diagperf-webhook, source-code]
---

# conversation-memory

> `lib/conversation-memory.js`

## Rôle

Mémoire long-terme par client stockée dans `conversations.contexte_json` (pas de nouvelle table). Gère le profil (véhicules, prestations discutées, objections, ton) et le résumé condensé des conversations longues. Best-effort : n'échoue jamais en cascade.

## Exports

getClientProfile, updateClientProfile, extractProfileSignals, buildMemoryContext, shouldSummarize, summarizeAndStore.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[llm-service]]
- [[server]]
- [[webhook]]

## Notes

Consommé par [[server]], [[webhook]], [[llm-service]].
