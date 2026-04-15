-- Ajout de la colonne idempotency_key sur la table devis
-- À exécuter dans Supabase SQL Editor

ALTER TABLE devis
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Index unique pour empêcher les doublons
CREATE UNIQUE INDEX IF NOT EXISTS idx_devis_idempotency_key
  ON devis (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
