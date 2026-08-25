---
path: lib/devis-service.js
tags: [diagperf-webhook, source-code]
---

# devis-service

> `lib/devis-service.js`

## Rôle

Persistance des devis dans Supabase (`devis`, `tarifs_prestations`, `prestations`). Lit le tarif par code prestation, crée un devis, gère les upsells, la conversion HT/TVA/TTC, la clé d'idempotence.

## Exports

initDevisService, getPrestationTarif, createDevis, addUpsellOptionsToDevis, etc.

## Dépendances internes

- [[text-helpers]]
- [[vehicle-service]]

## Consommateurs (reverse)

- [[prestation]]
