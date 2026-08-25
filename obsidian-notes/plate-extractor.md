---
path: lib/plate-extractor.js
tags: [diagperf-webhook, source-code]
---

# plate-extractor

> `lib/plate-extractor.js`

## Rôle

Extraction intelligente de plaques françaises SIV (`AA-123-AA`) dans du texte libre. Gère plusieurs formats (collé, espacé, ponctué), extrait toutes les occurrences ou juste la première, valide/normalise le résultat.

## Exports

extractPlates, extractFirstPlate, extractAndValidatePlate, hasPlateMention, removePlateFromText, normalizePlate, isValidPlate.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[llm-fallback-degrade.test]]
- [[plate-extractor.test]]
- [[sav]]
- [[webhook]]
