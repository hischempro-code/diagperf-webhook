---
path: lib/pdf-service.js
tags: [diagperf-webhook, source-code]
---

# pdf-service

> `lib/pdf-service.js`

## Rôle

Génère le PDF de devis via pdfkit (mise en page A4, couleurs de marque, tableau prestation, mentions légales) puis upload media WhatsApp + envoi document.

## Exports

initPdfService, generateQuotePdf, sendQuotePdf.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `path`
- `fs`
- `pdfkit (lazy)`

## Consommateurs (reverse)

- [[server]]
