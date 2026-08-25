---
path: migrations/001_devis_tracking.sql
tags: [diagperf-webhook, source-code]
---

# 001_devis_tracking

> `migrations/001_devis_tracking.sql`

## Rôle

Migration : enrichit la table `devis` avec le suivi client (customer_name, customer_email, rdv_date, admin_notes) et les colonnes de statut avancées.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Table consommée par [[devis-service]], [[dashboard]], [[relance-service]].
