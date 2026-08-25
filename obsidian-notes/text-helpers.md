---
path: lib/text-helpers.js
tags: [diagperf-webhook, source-code]
---

# text-helpers

> `lib/text-helpers.js`

## Rôle

Helpers texte purs : détection greeting/reset, extraction du texte d'un message WhatsApp (text/button/interactive), extraction d'ID interactif, confirmation/déni, extraction de contact (email/téléphone/nom), normalisation plaque, validation email.

## Exports

isGreeting, isGreetingOrReset, extractInboundText, extractInteractiveId, isConfirmation, isDenial, extractContactFromText, normalizePlate, validatePlate, validateEmail.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

- [[devis-service]]
- [[event-handlers]]
- [[guards-friction.test]]
- [[prestation]]
- [[sav]]
- [[vehicle-service]]
- [[webhook]]
