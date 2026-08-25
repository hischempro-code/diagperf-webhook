---
path: lib/creatomateVideo.js
tags: [diagperf-webhook, source-code]
---

# creatomateVideo

> `lib/creatomateVideo.js`

## Rôle

Rendering de vidéos personnalisées via l'API Creatomate. Deux entrées : `renderStageGainsVideo` (gains puissance/couple d'une reprog) et `renderPrestationVideo` (générique E85/FAP/AdBlue). Placeholders documentés en tête de fichier.

## Exports

renderStageGainsVideo, renderPrestationVideo.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[server]]

## Notes

Requiert `CREATOMATE_API_KEY` et un `CREATOMATE_TEMPLATE_ID`.
