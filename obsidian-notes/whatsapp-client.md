---
path: lib/whatsapp-client.js
tags: [diagperf-webhook, source-code]
---

# whatsapp-client

> `lib/whatsapp-client.js`

## Rôle

Wrapper minimaliste de la WhatsApp Cloud API : envoi texte, boutons interactifs, listes, images, documents, upload media. Retry automatique (2 tentatives, 600 ms). Persiste chaque outbound via `insertOutboundMessage`.

## Exports

initWhatsAppClient, sendWhatsAppText, sendWhatsAppInteractiveButtons, sendWhatsAppList, sendWhatsAppImage, sendWhatsAppDocument, uploadWhatsAppMedia.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
