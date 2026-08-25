---
path: lib/email-service.js
tags: [diagperf-webhook, source-code]
---

# email-service

> `lib/email-service.js`

## Rôle

Client HTTP Brevo pour envoi d'emails (client + garage) : PDF devis, notifications SAV, confirmations. Best-effort : renvoie `false` si `BREVO_API_KEY` absent au lieu de lever.

## Exports

initEmailService, sendQuoteEmail, sendSavClientEmail, sendSavDiagperfEmail, etc.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `node-fetch`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
