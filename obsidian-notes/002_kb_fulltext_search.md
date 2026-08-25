---
path: migrations/002_kb_fulltext_search.sql
tags: [diagperf-webhook, source-code]
---

# 002_kb_fulltext_search

> `migrations/002_kb_fulltext_search.sql`

## Rôle

Migration : ajoute la colonne `fts_content TSVECTOR` (français) sur `kb_chunks` pour la recherche full-text hybride combinée à pgvector.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Utilisée par le retrieval hybride de [[rag]].
