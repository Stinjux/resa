-- Intelligence artificielle : assistant de réservation et rapports.
-- L'IA ne réserve jamais seule : elle prépare des brouillons (ai_drafts) que
-- l'utilisateur confirme explicitement.

CREATE TABLE ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  -- Historique complet au format de l'API (blocs de réflexion et d'outils
  -- conservés tels quels, sans modification : ajout seulement).
  messages    jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  payload          jsonb NOT NULL, -- demande de réservation validée
  summary          jsonb NOT NULL, -- récapitulatif affiché (départs, client, prix)
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'failed')),
  booking_ids      uuid[],
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  decided_at       timestamptz
);
CREATE INDEX ai_drafts_conversation_idx ON ai_drafts (conversation_id);

CREATE TABLE ai_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES clubs(id),
  created_by  uuid REFERENCES users(id),
  period_from date NOT NULL,
  period_to   date NOT NULL,
  focus       text,
  locale      text NOT NULL DEFAULT 'fr',
  data        jsonb NOT NULL,  -- chiffres calculés par Resa (source de vérité)
  content     text NOT NULL,   -- analyse rédigée par l'IA (Markdown)
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_reports_club_idx ON ai_reports (club_id, created_at DESC);
