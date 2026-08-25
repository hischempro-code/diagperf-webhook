---
path: lib/conversation-service.js
tags: [diagperf-webhook, source-code]
---

# conversation-service

> `lib/conversation-service.js`

## Rôle

CRUD léger sur la table `conversation_state` (état actif du flow conversationnel par `wa_id`). Applique un TTL de 2h : au-delà, l'état est effacé automatiquement.

## Exports

initConversationService, getConversationState, setConversationState, clearConversationState.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._
