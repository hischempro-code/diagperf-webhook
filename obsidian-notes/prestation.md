---
path: flows/prestation.js
tags: [diagperf-webhook, source-code]
---

# prestation

> `flows/prestation.js`

## Rôle

Machine à états du parcours prospect (REPROG/E85/FAP/EGR/ADBLUE). Enchaîne : détection intent → saisie plaque → lookup véhicule → validation compatibilité → devis (upsells) → contact → PDF + email. Factory : injecte toutes ses dépendances depuis `server.js`.

## Exports

createPrestationFlow.

## Dépendances internes

- [[text-helpers]]
- [[intent-detector]]
- [[llm-service]]
- [[vehicle-service]]
- [[vehicle-card]]
- [[devis-service]]
- [[config-index]]

## Consommateurs (reverse)

- [[server]]
- [[vehicle-incompat-switch.test]]
