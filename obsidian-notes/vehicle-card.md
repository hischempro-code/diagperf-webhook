---
path: lib/vehicle-card.js
tags: [diagperf-webhook, source-code]
---

# vehicle-card

> `lib/vehicle-card.js`

## Rôle

Génère la fiche performance véhicule affichée après identification de la plaque, et les messages « analyse en cours ». Réplique la règle de compat AdBlue de [[vehicle-service]] pour ne pas promettre une prestation refusée ensuite par le flow.

## Exports

buildVehiclePerformanceCard, buildAnalysisStartMessage, buildAnalysisProgressMessage.

## Dépendances internes

- [[vehicle-service]]

## Consommateurs (reverse)

- [[prestation]]
- [[sav]]
