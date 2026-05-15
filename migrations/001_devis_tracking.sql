-- Migration 001 — Suivi des devis enrichi
-- À exécuter dans Supabase SQL Editor (une seule fois)

-- Champs client sur les devis
ALTER TABLE devis ADD COLUMN IF NOT EXISTS customer_name    TEXT;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS customer_email   TEXT;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS rdv_date         DATE;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS admin_notes      TEXT;
ALTER TABLE devis ADD COLUMN IF NOT EXISTS relance_sent_at  TIMESTAMPTZ;

-- Table des PINs sécurisés pour l'espace client PWA
-- Remplace le PIN = 4 derniers chiffres du numéro (trop faible)
CREATE TABLE IF NOT EXISTS client_pins (
  wa_id      TEXT PRIMARY KEY,
  pin        TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
