---
path: benchmark/rejudge.js
tags: [diagperf-webhook, source-code]
---

# rejudge

> `benchmark/rejudge.js`

## Rôle

Recharge un `raw-*.json` de run existant et re-note UNIQUEMENT chaque réponse stockée avec un juge LLM plus fort (Opus 4.8 par défaut), sans rappeler Claude pour générer.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `dotenv`
- `fs`
- `path`
- `node-fetch`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
