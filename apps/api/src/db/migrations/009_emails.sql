-- E-mails aux clients : confirmation, modification, annulation, rappel.
-- File d'envoi (outbox) : écrite dans la transaction de la réservation,
-- envoyée ensuite avec reprises.

ALTER TABLE clubs
  ADD COLUMN email_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN email_reply_to text,         -- adresse de réponse (réception du golf)
  ADD COLUMN contact_phone text,          -- téléphone affiché dans les e-mails
  ADD COLUMN reminder_hours_before integer NOT NULL DEFAULT 24 CHECK (reminder_hours_before BETWEEN 0 AND 168); -- 0 = pas de rappel

CREATE TABLE email_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  booking_id       uuid REFERENCES bookings(id),
  kind             text NOT NULL CHECK (kind IN ('confirmation', 'modification', 'cancellation', 'reminder')),
  dedupe_key       text NOT NULL,           -- évite les doublons (ex. un seul rappel par réservation)
  to_address       text NOT NULL,
  locale           text NOT NULL,
  subject          text NOT NULL,
  body_text        text NOT NULL,
  body_html        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'logged')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  provider_id      text,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, kind, dedupe_key)
);
CREATE INDEX email_outbox_queue_idx ON email_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX email_outbox_club_idx ON email_outbox (club_id, created_at DESC);
