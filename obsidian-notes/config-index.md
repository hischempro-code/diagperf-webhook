---
path: config/index.js
tags: [diagperf-webhook, source-code]
---

# config-index

> `config/index.js`

## Rôle

Configuration centralisée. Charge `.env`, valide la présence des variables requises (SUPABASE_URL, WHATSAPP_TOKEN, etc.), avertit sur les recommandées, expose `config`, `MENU_MAP`, `NON_TEXT_TYPES`, `DIAG_OPTIONS`, `PRESTATION_DURATIONS`.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `dotenv`

## Consommateurs (reverse)

- [[dashboard]]
- [[prestation]]
- [[server]]

## Notes

Consommé par [[server]], [[dashboard]], [[prestation]].
