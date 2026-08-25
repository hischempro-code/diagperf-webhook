---
path: tests/vehicle-incompat-switch.test.js
tags: [diagperf-webhook, source-code]
---

# vehicle-incompat-switch.test

> `tests/vehicle-incompat-switch.test.js`

## Rôle

Test régression : quand l'intent choisi est incompatible avec le véhicule identifié (ex: E85 sur diesel), le flow doit proposer un switch au lieu de bloquer.

## Dépendances internes

- [[prestation]]
- [[vehicle-service]]

## Dépendances externes / stdlib

- `assert`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
