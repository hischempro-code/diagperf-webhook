---
path: migrations/001_kb_chunks.sql
tags: [diagperf-webhook, source-code]
---

# 001_kb_chunks

> `migrations/001_kb_chunks.sql`

## Rôle

Migration : active l'extension pgvector et crée la table `kb_chunks` (id, file_path, content, embedding, intent…) pour le RAG.

## Dépendances internes

_Aucune (module feuille)._

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Alimentée par [[ingest]], requêtée par [[rag]].
