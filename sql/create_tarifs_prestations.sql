-- ====== Schéma réel ======
-- prestations(id SERIAL PK, code TEXT UNIQUE, nom TEXT, ...)
-- tarifs_prestations(id SERIAL PK, prestation_id FK -> prestations.id, prix_base_centimes INT, actif BOOL)

-- ====== Seed prestations ======
-- Ne crée PAS les tables (elles existent déjà dans Supabase).
-- Exécuter uniquement si les lignes n'existent pas encore.

INSERT INTO prestations (code, nom) VALUES
  ('reprogrammation',      'Reprogrammation moteur - Stage 1'),
  ('conversion_e85',       'Conversion E85'),
  ('suppression_fap',      'Suppression FAP'),
  ('suppression_egr',      'Suppression EGR'),
  ('suppression_adblue',   'Suppression ADBlue'),
  ('diagnostic_complet',   'Diagnostic complet'),
  ('autres',               'Autres prestations')
ON CONFLICT (code) DO NOTHING;

-- ====== Seed tarifs ======
-- Adapter les montants (en centimes HT) selon vos tarifs réels.
-- "autres" n'a pas de tarif → "prix sur demande"

INSERT INTO tarifs_prestations (prestation_id, prix_base_centimes, actif)
SELECT p.id, val.prix, true
FROM (VALUES
  ('reprogrammation',      45000),   -- 450€ HT
  ('conversion_e85',       29900),   -- 299€ HT
  ('suppression_fap',      39900),   -- 399€ HT
  ('suppression_egr',      24900),   -- 249€ HT
  ('suppression_adblue',   34900),   -- 349€ HT
  ('diagnostic_complet',    8900)    -- 89€ HT
) AS val(code, prix)
JOIN prestations p ON p.code = val.code
WHERE NOT EXISTS (
  SELECT 1 FROM tarifs_prestations tp WHERE tp.prestation_id = p.id AND tp.actif = true
);
