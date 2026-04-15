-- Migration : Ajouter la recherche full-text (FTS) pour le RAG hybride
-- Exécuter dans Supabase SQL Editor (Dashboard → SQL Editor → New query)

-- Ajouter colonne tsvector pour la recherche full-text (français)
ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS fts_content TSVECTOR;

-- Générer les tsvectors pour les chunks existants
UPDATE kb_chunks
SET fts_content = to_tsvector('french', content)
WHERE fts_content IS NULL;

-- Index GIN pour la recherche full-text
CREATE INDEX IF NOT EXISTS kb_chunks_fts_idx ON kb_chunks USING gin(fts_content);

-- Trigger pour mettre à jour automatiquement fts_content à chaque INSERT/UPDATE
CREATE OR REPLACE FUNCTION kb_chunks_fts_trigger() RETURNS trigger AS $$
BEGIN
  NEW.fts_content := to_tsvector('french', NEW.content);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kb_chunks_fts_update ON kb_chunks;
CREATE TRIGGER kb_chunks_fts_update
  BEFORE INSERT OR UPDATE OF content ON kb_chunks
  FOR EACH ROW EXECUTE FUNCTION kb_chunks_fts_trigger();

-- Fonction de recherche hybride : vector + full-text
CREATE OR REPLACE FUNCTION match_kb_chunks_hybrid(
  query_embedding VECTOR(384),
  query_text TEXT,
  match_threshold FLOAT DEFAULT 0.2,
  match_count INT DEFAULT 10,
  keyword_weight FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id BIGINT,
  file_path TEXT,
  category TEXT,
  tags TEXT[],
  intent TEXT,
  content TEXT,
  similarity FLOAT,
  keyword_rank FLOAT,
  combined_score FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  ts_query TSQUERY;
BEGIN
  -- Construire la requête full-text (OR entre les mots, tolérant aux fautes)
  ts_query := plainto_tsquery('french', query_text);

  RETURN QUERY
  SELECT
    kb.id,
    kb.file_path,
    kb.category,
    kb.tags,
    kb.intent,
    kb.content,
    (1 - (kb.embedding <=> query_embedding))::FLOAT AS similarity,
    COALESCE(ts_rank_cd(kb.fts_content, ts_query), 0)::FLOAT AS keyword_rank,
    (
      (1 - keyword_weight) * (1 - (kb.embedding <=> query_embedding)) +
      keyword_weight * COALESCE(ts_rank_cd(kb.fts_content, ts_query), 0) * 10
    )::FLOAT AS combined_score
  FROM kb_chunks kb
  WHERE (1 - (kb.embedding <=> query_embedding)) > match_threshold
     OR kb.fts_content @@ ts_query
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
