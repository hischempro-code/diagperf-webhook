-- Table conversation_state : gère l'état du flow conversationnel par wa_id
CREATE TABLE IF NOT EXISTS conversation_state (
  wa_id          TEXT PRIMARY KEY,
  state          TEXT,
  intent         TEXT,
  data           JSONB DEFAULT '{}'::jsonb,
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Index pour requêtes fréquentes par state
CREATE INDEX IF NOT EXISTS idx_conversation_state_state ON conversation_state (state);

-- Trigger pour mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_conversation_state_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conversation_state_updated_at ON conversation_state;
CREATE TRIGGER trg_conversation_state_updated_at
  BEFORE UPDATE ON conversation_state
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_state_updated_at();
