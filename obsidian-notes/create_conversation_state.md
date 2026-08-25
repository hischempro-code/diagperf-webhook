---
path: sql/create_conversation_state.sql
tags: [diagperf-webhook, source-code]
---

# create_conversation_state

> `sql/create_conversation_state.sql`

## Rôle

Crée la table `conversation_state` (wa_id PK, state, intent, data JSONB, updated_at) qui pilote la machine à états du flow.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Manipulée par [[conversation-service]].
