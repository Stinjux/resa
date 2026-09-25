-- Étape 1 : noyau réservation (organisations, golfs, parcours, grilles horaires,
-- départs, réservations, ressources, journal d'audit).
-- Convention : montants en unités mineures (centimes) + devise ISO 4217 du golf.
-- Tous les horodatages sont en UTC (timestamptz) ; l'heure locale se calcule
-- avec le fuseau IANA du golf.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Locataire SaaS : un groupe de golfs (ex. les 4 golfs marocains).
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clubs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  timezone             text NOT NULL,              -- IANA, ex. Africa/Casablanca
  currency             char(3) NOT NULL,           -- ISO 4217, ex. MAD
  default_locale       text NOT NULL DEFAULT 'fr', -- BCP 47
  country_code         char(2),
  prices_include_tax   boolean NOT NULL DEFAULT true,
  booking_horizon_days integer NOT NULL DEFAULT 60 CHECK (booking_horizon_days > 0),
  min_lead_minutes     integer NOT NULL DEFAULT 0 CHECK (min_lead_minutes >= 0),
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE courses (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id                   uuid NOT NULL REFERENCES clubs(id),
  code                      text NOT NULL,
  name                      text NOT NULL,
  allowed_holes             smallint[] NOT NULL DEFAULT '{9,18}',
  default_interval_minutes  integer NOT NULL DEFAULT 6 CHECK (default_interval_minutes BETWEEN 1 AND 60),
  default_max_players       smallint NOT NULL DEFAULT 4 CHECK (default_max_players BETWEEN 1 AND 4),
  -- Durées de jeu estimées : servent à calculer la période d'occupation
  -- du caddie et du matériel.
  play_minutes_9            integer NOT NULL DEFAULT 135 CHECK (play_minutes_9 > 0),
  play_minutes_18           integer NOT NULL DEFAULT 270 CHECK (play_minutes_18 > 0),
  active                    boolean NOT NULL DEFAULT true,
  UNIQUE (club_id, code)
);

-- Règles de grille : ouvertures, fermetures et exceptions.
-- La règle la plus prioritaire gagne sur la plage où elle s'applique
-- (priority DESC, puis spécificité : parcours > date unique > période > jours).
CREATE TABLE schedule_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL REFERENCES clubs(id),
  course_id         uuid REFERENCES courses(id),   -- NULL = tous les parcours du golf
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('open', 'closed')),
  valid_from        date,
  valid_to          date,
  weekdays          smallint[],                    -- ISO : 1 = lundi … 7 = dimanche ; NULL = tous
  start_time        time NOT NULL,
  end_time          time NOT NULL,
  interval_minutes  integer CHECK (interval_minutes BETWEEN 1 AND 60),
  max_players       smallint CHECK (max_players BETWEEN 1 AND 4),
  allowed_holes     smallint[],
  priority          integer NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  CHECK (end_time > start_time),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE INDEX schedule_rules_club_idx ON schedule_rules (club_id) WHERE active;

-- Personnes (données personnelles : accès restreint, voir docs/SECURITE).
CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  first_name       text,
  last_name        text NOT NULL,
  email            text,
  phone            text,
  preferred_locale text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_org_email_idx ON customers (organization_id, lower(email));
CREATE INDEX customers_org_phone_idx ON customers (organization_id, phone);

CREATE TABLE caddies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id     uuid NOT NULL REFERENCES clubs(id),
  display_name text NOT NULL,
  phone       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un départ = un créneau d'un parcours. Créé à la première réservation
-- (les créneaux libres sont calculés à partir des règles de grille).
CREATE TABLE tee_times (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid NOT NULL REFERENCES clubs(id),
  course_id    uuid NOT NULL REFERENCES courses(id),
  starts_at    timestamptz NOT NULL,
  local_date   date NOT NULL,
  max_players  smallint NOT NULL CHECK (max_players BETWEEN 1 AND 4),
  holes        smallint CHECK (holes IN (9, 18)),  -- fixé par la 1re réservation active
  is_private   boolean NOT NULL DEFAULT false,
  caddie_id    uuid REFERENCES caddies(id),        -- identité attribuée plus tard
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, starts_at)
);
CREATE INDEX tee_times_course_date_idx ON tee_times (course_id, local_date);

CREATE SEQUENCE booking_reference_seq;

CREATE TABLE bookings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference        text NOT NULL UNIQUE,
  club_id          uuid NOT NULL REFERENCES clubs(id),
  tee_time_id      uuid NOT NULL REFERENCES tee_times(id),
  customer_id      uuid REFERENCES customers(id),
  channel          text NOT NULL CHECK (channel IN ('web', 'phone', 'group', 'walk_in', 'staff')),
  status           text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  players          smallint NOT NULL CHECK (players BETWEEN 1 AND 4),
  holes            smallint NOT NULL CHECK (holes IN (9, 18)),
  is_private       boolean NOT NULL DEFAULT false,
  group_id         uuid,
  notes            text,
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at     timestamptz,
  cancel_reason    text,
  UNIQUE (club_id, idempotency_key)
);
CREATE INDEX bookings_tee_time_idx ON bookings (tee_time_id) WHERE status = 'confirmed';

CREATE TABLE booking_players (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  position     smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
  customer_id  uuid REFERENCES customers(id),
  name         text,
  UNIQUE (booking_id, position)
);

-- Types de ressources par golf (caddie, voiturette, chariot, sacs…).
-- scope = 'tee_time' : une seule allocation par départ (caddie).
-- scope = 'booking'  : allouée à chaque réservation selon la quantité demandée.
CREATE TABLE resource_types (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id                uuid NOT NULL REFERENCES clubs(id),
  code                   text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('caddie', 'cart', 'trolley', 'rental_bag', 'other')),
  name                   text NOT NULL,
  variant                text,             -- ex. men_right, women_left
  scope                  text NOT NULL CHECK (scope IN ('tee_time', 'booking')),
  required_per_tee_time  boolean NOT NULL DEFAULT false,
  total_quantity         integer NOT NULL CHECK (total_quantity >= 0),
  price_9_minor          integer NOT NULL DEFAULT 0 CHECK (price_9_minor >= 0),
  price_18_minor         integer NOT NULL DEFAULT 0 CHECK (price_18_minor >= 0),
  buffer_minutes         integer NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  max_per_booking        integer CHECK (max_per_booking > 0),
  active                 boolean NOT NULL DEFAULT true,
  sort_order             integer NOT NULL DEFAULT 0,
  UNIQUE (club_id, code),
  CHECK (NOT required_per_tee_time OR scope = 'tee_time')
);

-- Quantité disponible différente un jour donné (maintenance, effectif caddies…).
CREATE TABLE resource_capacity_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type_id  uuid NOT NULL REFERENCES resource_types(id),
  date              date NOT NULL,
  quantity          integer NOT NULL CHECK (quantity >= 0),
  reason            text,
  UNIQUE (resource_type_id, date)
);

CREATE TABLE resource_allocations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL REFERENCES clubs(id),
  resource_type_id  uuid NOT NULL REFERENCES resource_types(id),
  tee_time_id       uuid REFERENCES tee_times(id),
  booking_id        uuid REFERENCES bookings(id),
  quantity          integer NOT NULL CHECK (quantity > 0),
  period            tstzrange NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  released_at       timestamptz,
  CHECK ((tee_time_id IS NULL) <> (booking_id IS NULL))
);
CREATE INDEX resource_allocations_active_idx
  ON resource_allocations USING gist (resource_type_id, period) WHERE status = 'active';
-- Garantie en base : au plus une allocation active par départ et par type
-- à portée « départ » (=> un seul caddie par départ).
CREATE UNIQUE INDEX resource_allocations_one_per_tee_time
  ON resource_allocations (tee_time_id, resource_type_id)
  WHERE status = 'active' AND tee_time_id IS NOT NULL;
CREATE INDEX resource_allocations_booking_idx ON resource_allocations (booking_id) WHERE status = 'active';

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  club_id      uuid REFERENCES clubs(id),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'customer', 'system')),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,
  data         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
