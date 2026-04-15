-- Table SAV tickets
-- À exécuter dans Supabase SQL Editor

CREATE TABLE IF NOT EXISTS sav_tickets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  status text DEFAULT 'open' NOT NULL,
  topic text,
  customer_name text,
  customer_phone text,
  vehicle text,
  description text,
  wa_id text NOT NULL,
  reference text
);

-- Trigger auto-génération de référence SAV-XXXXXX
CREATE OR REPLACE FUNCTION generate_sav_reference()
RETURNS trigger AS $$
BEGIN
  NEW.reference := 'SAV-' || LPAD(nextval('sav_tickets_ref_seq')::text, 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE SEQUENCE IF NOT EXISTS sav_tickets_ref_seq START 1;

CREATE OR REPLACE TRIGGER trg_sav_reference
  BEFORE INSERT ON sav_tickets
  FOR EACH ROW
  WHEN (NEW.reference IS NULL)
  EXECUTE FUNCTION generate_sav_reference();

-- Index pour recherche par wa_id
CREATE INDEX IF NOT EXISTS idx_sav_tickets_wa_id ON sav_tickets (wa_id);
