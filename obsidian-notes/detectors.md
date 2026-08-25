---
path: eval/detectors.js
tags: [diagperf-webhook, source-code]
---

# detectors

> `eval/detectors.js`

## Rôle

Détecteurs d'hallucination déterministes (fonctions pures, sans réseau). Chacun renvoie `{hit, evidence}` sur le texte d'une réponse `answer`. Attrape motorisation affirmée, faux devis, gains chiffrés, déplacement à domicile, garantie chiffrée. Précision > rappel.

## Exports

DETECTORS, runDetectors.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[detectors.test]]
- [[run-eval]]

## Notes

Consommé par [[detectors.test]] (offline) et [[run-eval]] (live). Alimente la télémétrie de [[llm-service]].
