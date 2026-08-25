---
path: lib/relance-service.js
tags: [diagperf-webhook, source-code]
---

# relance-service

> `lib/relance-service.js`

## Rôle

Cron de relances des devis « draft » créés depuis plus de 24h et non encore relancés. Envoie un message WhatsApp de rappel puis marque `relance_sent_at`.

## Exports

initRelanceService, runRelances.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[server]]
