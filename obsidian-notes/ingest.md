---
path: ingest.js
tags: [diagperf-webhook, source-code]
---

# ingest

> `ingest.js`

## Rôle

Pipeline d'ingestion de la base de connaissances. Lit tous les Markdown de `knowledge_base/`, chunk (~400 tokens), génère les embeddings via Google Gemini (`gemini-embedding-001`, 384 dims) et remplit la table `kb_chunks` de Supabase (pgvector). Idempotent : purge les anciens chunks par fichier avant réinsertion.

## Dépendances internes

- [[rag]]

## Dépendances externes / stdlib

- `fs`
- `path`
- `dotenv`
- `@supabase/supabase-js`

## Consommateurs (reverse)

_Aucun module interne recensé ne l'importe._

## Notes

Doit utiliser le même embedder que [[rag]] pour aligner les espaces vectoriels.
