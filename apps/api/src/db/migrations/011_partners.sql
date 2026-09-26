-- Partenaires (tour-opérateurs, agences, hôtels, entreprises), allotements,
-- accès au portail partenaire.

CREATE TABLE partners (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  code                text NOT NULL,
  name                text NOT NULL,
  kind                text NOT NULL DEFAULT 'tour_operator'
                      CHECK (kind IN ('tour_operator', 'travel_agency', 'hotel', 'corporate', 'other')),
  -- Tarifs négociés : catégorie de la grille tarifaire appliquée à ses réservations.
  price_category      text NOT NULL DEFAULT 'standard',
  on_account          boolean NOT NULL DEFAULT true, -- règlement sur relevé, pas au comptoir
  payment_terms_days  integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  contact_name        text,
  email               text,
  phone               text,
  legal_name          text,
  address             text,
  ice                 text,
  notes               text,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code)
);

ALTER TABLE bookings
  ADD COLUMN partner_id uuid REFERENCES partners(id),
  ADD COLUMN partner_reference text; -- numéro de voucher / dossier du partenaire
CREATE INDEX bookings_partner_idx ON bookings (partner_id) WHERE partner_id IS NOT NULL;
ALTER TABLE bookings DROP CONSTRAINT bookings_channel_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_channel_check
  CHECK (channel IN ('web', 'phone', 'group', 'walk_in', 'staff', 'whatsapp', 'sms', 'partner'));

-- Compte du portail partenaire (ni personnel, ni client).
ALTER TABLE users ADD COLUMN partner_id uuid REFERENCES partners(id);

-- Allotement : départs réservés à un partenaire sur une période, rendus à la
-- vente « release_days » jours avant la date s'ils ne sont pas utilisés.
CREATE TABLE allotments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id       uuid NOT NULL REFERENCES clubs(id),
  partner_id    uuid NOT NULL REFERENCES partners(id),
  course_id     uuid NOT NULL REFERENCES courses(id),
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  weekdays      smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}', -- 1 = lundi
  start_time    time NOT NULL,
  end_time      time NOT NULL, -- inclus
  release_days  integer NOT NULL DEFAULT 7 CHECK (release_days BETWEEN 0 AND 365),
  note          text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from AND date_to - date_from <= 366),
  CHECK (end_time >= start_time)
);

-- Départ tenu pour un allotement (en plus de blocked_reason, qui le retire de la vente).
ALTER TABLE tee_times
  ADD COLUMN held_allotment_id uuid REFERENCES allotments(id),
  ADD COLUMN held_until timestamptz;
CREATE INDEX tee_times_held_idx ON tee_times (held_until) WHERE held_allotment_id IS NOT NULL;
