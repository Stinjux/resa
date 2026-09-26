-- Réservations par messagerie (WhatsApp, SMS) avec VALIDATION OBLIGATOIRE par
-- le personnel (réception ou direction) avant toute réservation.

ALTER TABLE bookings DROP CONSTRAINT bookings_channel_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_channel_check
  CHECK (channel IN ('web', 'phone', 'group', 'walk_in', 'staff', 'whatsapp', 'sms'));

ALTER TABLE clubs ADD COLUMN messaging_provider text; -- NULL = aucune ; 'local' = simulateur

-- Une conversation par golf, canal et numéro de téléphone.
CREATE TABLE message_threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  channel          text NOT NULL CHECK (channel IN ('whatsapp', 'sms')),
  contact          text NOT NULL,          -- numéro normalisé (+212…)
  contact_name     text,                   -- nom indiqué par le fournisseur ou le client
  customer_id      uuid REFERENCES customers(id),
  locale           text,                   -- langue détectée (fr, en, ar…)
  ai_messages      jsonb NOT NULL DEFAULT '[]', -- échanges avec l'IA (format API, ajout seulement)
  ai_turns_window  integer NOT NULL DEFAULT 0,  -- garde-fou de coût : tours IA sur la fenêtre en cours
  ai_window_start  timestamptz NOT NULL DEFAULT now(),
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, channel, contact)
);
CREATE INDEX message_threads_club_idx ON message_threads (club_id, last_message_at DESC);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id            uuid NOT NULL REFERENCES message_threads(id),
  direction            text NOT NULL CHECK (direction IN ('in', 'out')),
  author               text NOT NULL CHECK (author IN ('customer', 'ai', 'staff', 'system')),
  body                 text NOT NULL,
  provider             text,
  provider_message_id  text,             -- identifiant chez le fournisseur (anti-doublon)
  -- in : received → processed ; out : pending → sent / failed
  status               text NOT NULL CHECK (status IN ('received', 'processed', 'pending', 'sent', 'failed')),
  attempts             integer NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  last_error           text,
  sent_by              uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at);
CREATE INDEX messages_queue_idx ON messages (next_attempt_at) WHERE status IN ('received', 'pending');

-- Demande de réservation préparée à partir des messages ; seule une
-- validation du personnel la transforme en réservation.
CREATE TABLE booking_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id        uuid NOT NULL REFERENCES clubs(id),
  thread_id      uuid NOT NULL REFERENCES message_threads(id),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  payload        jsonb NOT NULL,
  summary        jsonb NOT NULL,
  booking_ids    uuid[],
  last_error     text,              -- ex. créneau pris entre-temps
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_requests_club_idx ON booking_requests (club_id, status, created_at DESC);
