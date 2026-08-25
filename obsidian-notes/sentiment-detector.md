---
path: lib/sentiment-detector.js
tags: [diagperf-webhook, source-code]
---

# sentiment-detector

> `lib/sentiment-detector.js`

## Rôle

Détecte frustration, colère, urgence ou demandes explicites d'escalade humaine dans les messages entrants. Renvoie score + signal structuré pour décider : continuer, proposer escalade, ou escalade auto immédiate.

## Exports

detectSentiment, FRUSTRATION_PATTERNS.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[event-handlers]]
- [[server]]
