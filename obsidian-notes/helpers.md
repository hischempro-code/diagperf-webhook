---
path: helpers.js
tags: [diagperf-webhook, source-code]
---

# helpers

> `helpers.js`

## Rôle

Aggregat historique de helpers purs (plaques, greetings, extraction texte WhatsApp, calculs de prix). Sert essentiellement à la suite de tests `tests/helpers.test.js` — le code de production a migré vers `lib/text-helpers`, `lib/plate-utils` et `lib/vehicle-service`.

## Exports

normalizePlate, validatePlate, isGreetingOrReset, extractInboundText, extractInteractiveId, detectIntent, computeReprogPrice, computeE85Price, computeFapPrice, computeAdbluePrice, validateEmail, STAGE1_FIXED_PRICE_CENTS.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[helpers.test]]

## Notes

Utilisé par [[helpers.test]].
