-- Table devis : stocke les devis générés (reprog et autres)
-- À exécuter SEULEMENT si la table n'existe pas déjà dans Supabase.
CREATE TABLE IF NOT EXISTS devis (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  devis_id        TEXT UNIQUE DEFAULT ('DEV-' || substr(gen_random_uuid()::text, 1, 8)),
  wa_id           TEXT NOT NULL,
  prestation      TEXT NOT NULL,
  plate           TEXT,
  vehicle         JSONB,
  total_ht_centimes INTEGER NOT NULL DEFAULT 0,
  status          TEXT DEFAULT 'pending',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devis_wa_id ON devis (wa_id);
