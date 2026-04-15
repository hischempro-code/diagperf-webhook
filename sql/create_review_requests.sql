-- Table pour les demandes d'avis client (review requests)
-- Après une intervention terminée, un message WhatsApp est envoyé 48h plus tard
-- pour demander un avis (1-5 étoiles).

CREATE TABLE IF NOT EXISTS review_requests (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wa_id         TEXT NOT NULL,                          -- numéro WhatsApp du client
  devis_id      TEXT,                                   -- référence du devis (optionnel)
  prestation    TEXT,                                   -- libellé de la prestation
  vehicle_desc  TEXT,                                   -- description du véhicule
  customer_name TEXT,                                   -- nom du client
  customer_email TEXT,                                  -- email du client
  intervention_done_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- date de fin d'intervention
  send_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'), -- quand envoyer la demande d'avis
  sent          BOOLEAN NOT NULL DEFAULT FALSE,         -- déjà envoyé ?
  rating        SMALLINT,                               -- note donnée (1-5), NULL si pas encore répondu
  feedback      TEXT,                                   -- commentaire libre (optionnel)
  responded_at  TIMESTAMPTZ,                            -- date de la réponse
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour le scheduler (trouver les demandes à envoyer)
CREATE INDEX IF NOT EXISTS idx_review_requests_pending
  ON review_requests (send_at)
  WHERE sent = FALSE;

-- Index pour éviter les doublons (1 demande par client par devis)
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_requests_unique
  ON review_requests (wa_id, devis_id)
  WHERE devis_id IS NOT NULL;
