---
path: lib/event-handlers.js
tags: [diagperf-webhook, source-code]
---

# event-handlers

> `lib/event-handlers.js`

## Rôle

Handlers WhatsApp génériques : notification garage (email, WhatsApp désactivé par défaut à cause des templates Meta), escalade frustration/humain, gestion des boutons interactifs.

## Exports

initEventHandlers, notifyGarage, handleFrustrationEscalation, etc.

## Dépendances internes

- [[text-helpers]]
- [[sentiment-detector]]
- [[intent-detector]]

## Consommateurs (reverse)

- [[escalation-diag.test]]
