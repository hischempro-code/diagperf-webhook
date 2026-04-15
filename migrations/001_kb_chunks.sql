-- Migration : Créer la table kb_chunks pour le RAG
-- Exécuter dans Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- S'assurer que pgvector est activé
CREATE EXTENSION IF NOT EXISTS vector;

-- Table des chunks de la base de connaissances
CREATE TABLE IF NOT EXISTS kb_chunks (
  id BIGSERIAL PRIMARY KEY,
  file_path TEXT NOT NULL,           -- chemin relatif du fichier source (ex: services/e85-flexfuel.md)
  category TEXT,                      -- catégorie du frontmatter (services, faq, infos, tarifs)
  tags TEXT[],                        -- tags du frontmatter pour filtrage
  intent TEXT,                        -- intent associé si applicable (REPROG, E85, FAP, etc.)
  chunk_index INTEGER NOT NULL,       -- position du chunk dans le fichier (0, 1, 2...)
  content TEXT NOT NULL,              -- contenu texte du chunk
  token_count INTEGER,                -- nombre estimé de tokens du chunk
  embedding VECTOR(384),              -- embedding généré par all-MiniLM-L6-v2 (384 dimensions)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index vectoriel pour la recherche par similarité cosinus
CREATE INDEX IF NOT EXISTS kb_chunks_embedding_idx
  ON kb_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

-- Index sur file_path pour l'ingestion idempotente (suppression + réinsertion)
CREATE INDEX IF NOT EXISTS kb_chunks_file_path_idx ON kb_chunks (file_path);

-- Index sur category et intent pour le filtrage optionnel
CREATE INDEX IF NOT EXISTS kb_chunks_category_idx ON kb_chunks (category);
CREATE INDEX IF NOT EXISTS kb_chunks_intent_idx ON kb_chunks (intent);

-- Fonction de recherche par similarité cosinus
CREATE OR REPLACE FUNCTION match_kb_chunks(
  query_embedding VECTOR(384),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id BIGINT,
  file_path TEXT,
  category TEXT,
  tags TEXT[],
  intent TEXT,
  content TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kb.id,
    kb.file_path,
    kb.category,
    kb.tags,
    kb.intent,
    kb.content,
    1 - (kb.embedding <=> query_embedding) AS similarity
  FROM kb_chunks kb
  WHERE 1 - (kb.embedding <=> query_embedding) > match_threshold
  ORDER BY kb.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
