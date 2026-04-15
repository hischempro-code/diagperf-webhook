-- Migration: add prestation_code and wa_id to devis table for generic flow
-- Run AFTER create_tarifs_prestations.sql

ALTER TABLE devis ADD COLUMN IF NOT EXISTS prestation_code TEXT;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS wa_id TEXT;

CREATE INDEX IF NOT EXISTS idx_devis_prestation_code ON devis (prestation_code);
CREATE INDEX IF NOT EXISTS idx_devis_wa_id ON devis (wa_id);
