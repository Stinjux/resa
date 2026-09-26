-- Étape 2 : comptes et rôles, tarification (lignes de prix figées par
-- réservation), attribution nominative du matériel par le starter.

-- ---------------------------------------------------------------------------
-- Comptes, rôles, sessions

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  email            text NOT NULL,
  password_hash    text NOT NULL,
  display_name     text NOT NULL,
  customer_id      uuid REFERENCES customers(id), -- renseigné pour un compte client
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (organization_id, lower(email));

-- Rôle du personnel sur un golf (club_id) ou sur tous les golfs de
-- l'organisation (club_id NULL, réservé à org_admin).
CREATE TABLE user_roles (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id   uuid REFERENCES clubs(id),
  role      text NOT NULL CHECK (role IN ('org_admin', 'club_admin', 'receptionist', 'starter')),
  CHECK (club_id IS NOT NULL OR role = 'org_admin')
);
CREATE UNIQUE INDEX user_roles_unique_idx ON user_roles (user_id, coalesce(club_id, '00000000-0000-0000-0000-000000000000'), role);

-- Seule l'empreinte SHA-256 du jeton est stockée.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tarification

ALTER TABLE clubs
  ADD COLUMN tax_rate_bp integer NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000), -- 2000 = 20 %
  ADD COLUMN default_caddie_payment text NOT NULL DEFAULT 'on_site'
    CHECK (default_caddie_payment IN ('on_site', 'with_booking'));

-- Grille tarifaire : green fee et supplément départ privé. La règle applicable
-- la plus prioritaire (puis la plus spécifique) l'emporte.
CREATE TABLE tariffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id            uuid NOT NULL REFERENCES clubs(id),
  course_id          uuid REFERENCES courses(id),
  product            text NOT NULL CHECK (product IN ('green_fee', 'private_surcharge')),
  name               text NOT NULL,
  holes              smallint CHECK (holes IN (9, 18)),         -- NULL = 9 et 18
  customer_category  text,                                      -- NULL = toutes catégories
  valid_from         date,
  valid_to           date,
  weekdays           smallint[],
  start_time         time,                                      -- heure locale de départ, incluse
  end_time           time,                                      -- exclue
  amount_minor       integer NOT NULL CHECK (amount_minor >= 0),
  basis              text NOT NULL CHECK (basis IN ('per_player', 'per_booking')),
  priority           integer NOT NULL DEFAULT 0,
  active             boolean NOT NULL DEFAULT true,
  CHECK ((start_time IS NULL) = (end_time IS NULL)),
  CHECK (end_time IS NULL OR end_time > start_time)
);
CREATE INDEX tariffs_club_idx ON tariffs (club_id) WHERE active;

ALTER TABLE bookings
  ADD COLUMN customer_category text NOT NULL DEFAULT 'standard',
  ADD COLUMN caddie_payment text NOT NULL DEFAULT 'on_site' CHECK (caddie_payment IN ('on_site', 'with_booking')),
  ADD COLUMN currency char(3),
  ADD COLUMN total_minor integer,           -- TTC, somme des lignes
  ADD COLUMN due_with_booking_minor integer,
  ADD COLUMN due_on_site_minor integer;

-- Lignes de prix figées au moment de la réservation (recalculées à chaque
-- modification ; l'historique des montants est dans audit_log). Base des
-- futures lignes de commande / POS.
CREATE TABLE booking_charges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  position           smallint NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('green_fee', 'private_surcharge', 'caddie', 'resource')),
  tariff_id          uuid REFERENCES tariffs(id),
  resource_type_id   uuid REFERENCES resource_types(id),
  label              text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_amount_minor  integer NOT NULL CHECK (unit_amount_minor >= 0),
  total_minor        integer NOT NULL CHECK (total_minor >= 0),   -- TTC
  tax_rate_bp        integer NOT NULL,
  tax_minor          integer NOT NULL,
  payable            text NOT NULL CHECK (payable IN ('with_booking', 'on_site')),
  UNIQUE (booking_id, position)
);

-- ---------------------------------------------------------------------------
-- Matériel nominatif (voiturette n°12, sac H-D n°3…) attribué par le starter

CREATE TABLE resource_units (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type_id  uuid NOT NULL REFERENCES resource_types(id),
  label             text NOT NULL,
  status            text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'retired')),
  UNIQUE (resource_type_id, label)
);

CREATE TABLE allocation_units (
  allocation_id  uuid NOT NULL REFERENCES resource_allocations(id),
  unit_id        uuid NOT NULL REFERENCES resource_units(id),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (allocation_id, unit_id)
);
CREATE INDEX allocation_units_unit_idx ON allocation_units (unit_id);
