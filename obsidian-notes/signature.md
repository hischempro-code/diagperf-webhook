---
path: lib/signature.js
tags: [diagperf-webhook, source-code]
---

# signature

> `lib/signature.js`

## Rôle

Vérifie la signature HMAC-SHA256 des webhooks Meta (`x-hub-signature-256`) contre le body BRUT et `META_APP_SECRET`. Comparaison en temps constant (`timingSafeEqual`). Sans ça, n'importe qui peut injecter de faux messages.

## Exports

verifyMetaSignature.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `crypto`

## Consommateurs (reverse)

- [[server]]
- [[signature.test]]
