---
path: lib/sentry.js
tags: [diagperf-webhook, source-code]
---

# sentry

> `lib/sentry.js`

## Rôle

Init Sentry conditionnel (no-op si `SENTRY_DSN` absent). Sentry v10 auto-capture uncaughtException + unhandledRejection. Doit être requis en tout premier dans `server.js`.

## Exports

initSentry, captureException, setupExpressErrorHandler.

## Dépendances internes

_Aucune (module feuille)._

## Dépendances externes / stdlib

- `@sentry/node (lazy)`
- `crypto`

## Consommateurs (reverse)

- [[server]]
