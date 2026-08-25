---
path: sql/add_idempotency_key.sql
tags: [diagperf-webhook, source-code]
---

# add_idempotency_key

> `sql/add_idempotency_key.sql`

## Rôle

Ajoute `idempotency_key` sur `devis` + index unique pour prévenir la double-création lors de retries webhook.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
