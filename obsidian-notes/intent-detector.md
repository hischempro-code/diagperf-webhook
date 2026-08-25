---
path: lib/intent-detector.js
tags: [diagperf-webhook, source-code]
---

# intent-detector

> `lib/intent-detector.js`

## Rôle

Détection d'intent par mots-clés (REPROG, E85, FAP, EGR, ADBLUE, DIAG, AUTRES, SAV). Distingue prospect vs SAV (SAV = client existant, réclamation liée à une prestation déjà réalisée). Fournit aussi une variante « loose » pour matcher malgré fautes/formulations.

## Exports

INTENT_MAP, detectIntent, detectIntentLoose, detectIntentsAll, intentToPrestationCode, intentToLabel.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[event-handlers]]
- [[intent-ambiguity.test]]
- [[intent-detector.test]]
- [[llm-fallback-degrade.test]]
- [[prestation]]
- [[sav]]
- [[webhook]]
