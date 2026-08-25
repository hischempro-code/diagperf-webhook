---
path: sql/migrate_devis_generic.sql
tags: [diagperf-webhook, source-code]
---

# migrate_devis_generic

> `sql/migrate_devis_generic.sql`

## Rôle

Migration : ajoute `prestation_code` et `wa_id` sur `devis` (+ index) pour supporter le flow générique multi-prestations.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
