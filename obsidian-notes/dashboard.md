---
path: routes/dashboard.js
tags: [diagperf-webhook, source-code]
---

# dashboard

> `routes/dashboard.js`

## Rôle

Router Express du dashboard admin + API client. Expose SSE temps réel (`/api/dashboard/events`), CRUD devis/conversations, filtres, exports. Auth via `DASHBOARD_TOKEN`.

## Exports

createDashboardRouter (renvoie router, broadcastDashboardEvent, sseClients).

## Dépendances internes

- [[config-index]]

## Dépendances externes / stdlib

- `express`
- `node-fetch`

## Consommateurs (reverse)

- [[server]]
