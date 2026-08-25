---
path: flows/sav.js
tags: [diagperf-webhook, source-code]
---

# sav

> `flows/sav.js`

## Rôle

Machine à états du flow SAV pour clients existants (réclamations, tickets). Détecte l'intent SAV, collecte plaque + coordonnées, notifie le garage par email et envoie une confirmation client.

## Exports

createSavFlow.

## Dépendances internes

- [[text-helpers]]
- [[intent-detector]]
- [[vehicle-service]]
- [[plate-extractor]]
- [[llm-service]]
- [[vehicle-card]]

## Consommateurs (reverse)

- [[server]]
