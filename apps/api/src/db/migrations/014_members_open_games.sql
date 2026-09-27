-- Membres (abonnés), profil golfeur, parties ouvertes.

-- Profil golfeur. Le handicap et le nom ne sont montrés aux autres golfeurs
-- (parties ouvertes) que si le golfeur l'accepte (share_profile).
ALTER TABLE customers
  ADD COLUMN handicap_index numeric(3,1) CHECK (handicap_index BETWEEN -10 AND 54),
  ADD COLUMN licence_number text,
  ADD COLUMN share_profile boolean NOT NULL DEFAULT false;

-- Formules d'abonnement d'un golf : catégorie tarifaire (grille Tarifs) et
-- réservation en ligne ouverte plus longtemps à l'avance que pour le public.
CREATE TABLE membership_plans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id               uuid NOT NULL REFERENCES clubs(id),
  code                  text NOT NULL,
  name                  text NOT NULL,
  price_category        text NOT NULL DEFAULT 'member',
  booking_horizon_days  integer NOT NULL DEFAULT 21 CHECK (booking_horizon_days BETWEEN 1 AND 730),
  annual_fee_minor      integer CHECK (annual_fee_minor >= 0), -- information (cotisation)
  active                boolean NOT NULL DEFAULT true,
  UNIQUE (club_id, code)
);

CREATE TABLE memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid NOT NULL REFERENCES clubs(id),
  customer_id  uuid NOT NULL REFERENCES customers(id),
  plan_id      uuid NOT NULL REFERENCES membership_plans(id),
  card_number  text,
  valid_from   date NOT NULL,
  valid_to     date NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from),
  UNIQUE (club_id, card_number)
);
CREATE INDEX memberships_customer_idx ON memberships (customer_id, club_id);

-- Partie ouverte : l'organisateur accepte que d'autres golfeurs rejoignent son départ.
ALTER TABLE bookings
  ADD COLUMN is_open boolean NOT NULL DEFAULT false,
  ADD COLUMN open_note text;
