-- Étape 6 : commandes, paiements, remboursements, correspondance d'identifiants
-- externes et file de synchronisation POS (outbox transactionnelle).
--
-- Principe : la réservation (bookings) décrit le départ ; la commande (orders)
-- décrit ce qui est dû. Le « payé » se calcule UNIQUEMENT à partir des
-- paiements confirmés (payments.status = 'confirmed') moins les remboursements
-- confirmés : aucune colonne « payé » modifiable à la main.

ALTER TABLE clubs
  ADD COLUMN cancellation_free_hours integer NOT NULL DEFAULT 24 CHECK (cancellation_free_hours BETWEEN 0 AND 720),
  ADD COLUMN cancellation_fee_percent integer NOT NULL DEFAULT 0 CHECK (cancellation_fee_percent BETWEEN 0 AND 100),
  ADD COLUMN customer_can_cancel boolean NOT NULL DEFAULT true,
  ADD COLUMN online_payment text NOT NULL DEFAULT 'none' CHECK (online_payment IN ('none', 'optional', 'required')),
  ADD COLUMN pos_provider text; -- NULL = pas de POS ; 'local' = adaptateur local de démonstration

ALTER TABLE bookings ADD COLUMN cancellation_fee_minor integer CHECK (cancellation_fee_minor >= 0);

CREATE TABLE orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid NOT NULL REFERENCES clubs(id),
  booking_id   uuid NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id  uuid REFERENCES customers(id),
  reference    text NOT NULL UNIQUE,
  currency     char(3) NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  total_minor  integer NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  tax_minor    integer NOT NULL DEFAULT 0,
  version      integer NOT NULL DEFAULT 1, -- +1 à chaque changement de lignes (synchronisation POS)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position           smallint NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('green_fee', 'private_surcharge', 'caddie', 'resource', 'cancellation_fee')),
  sku                text NOT NULL, -- code article stable (GREEN_FEE_18, CADDIE, CART…) pour le POS
  label              text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_amount_minor  integer NOT NULL CHECK (unit_amount_minor >= 0),
  total_minor        integer NOT NULL CHECK (total_minor >= 0),
  tax_rate_bp        integer NOT NULL,
  tax_minor          integer NOT NULL,
  payable            text NOT NULL CHECK (payable IN ('with_booking', 'on_site')),
  UNIQUE (order_id, position)
);

CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  order_id         uuid NOT NULL REFERENCES orders(id),
  amount_minor     integer NOT NULL CHECK (amount_minor > 0),
  currency         char(3) NOT NULL,
  method           text NOT NULL CHECK (method IN ('cash', 'card_terminal', 'bank_transfer', 'online', 'pos', 'other')),
  -- pending : initié, NON compté ; confirmed : confirmation fiable reçue
  -- (encaissement constaté par le personnel, ou notification signée du prestataire).
  status           text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),
  source           text NOT NULL CHECK (source IN ('staff', 'pos', 'psp')),
  provider         text,
  external_id      text,
  idempotency_key  text,
  note             text,
  recorded_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  UNIQUE (club_id, idempotency_key),
  UNIQUE (club_id, provider, external_id)
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  order_id         uuid NOT NULL REFERENCES orders(id),
  payment_id       uuid REFERENCES payments(id),
  amount_minor     integer NOT NULL CHECK (amount_minor > 0),
  currency         char(3) NOT NULL,
  method           text NOT NULL CHECK (method IN ('cash', 'card_terminal', 'bank_transfer', 'online', 'pos', 'other')),
  status           text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled')),
  source           text NOT NULL CHECK (source IN ('staff', 'pos', 'psp')),
  reason           text,
  provider         text,
  external_id      text,
  idempotency_key  text,
  recorded_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  confirmed_at     timestamptz,
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  UNIQUE (club_id, idempotency_key),
  UNIQUE (club_id, provider, external_id)
);
CREATE INDEX refunds_order_idx ON refunds (order_id);

-- Correspondance identifiant interne ↔ identifiant chez un fournisseur externe.
CREATE TABLE external_refs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id      uuid NOT NULL REFERENCES clubs(id),
  provider     text NOT NULL,
  entity_type  text NOT NULL CHECK (entity_type IN ('booking', 'tee_time', 'customer', 'order', 'payment', 'refund')),
  entity_id    uuid NOT NULL,
  external_id  text NOT NULL,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  data         jsonb NOT NULL DEFAULT '{}',
  UNIQUE (provider, entity_type, entity_id),
  -- Un même fournisseur peut servir plusieurs golfs avec des comptes distincts.
  UNIQUE (club_id, provider, entity_type, external_id)
);

-- File de synchronisation POS : écrite dans la même transaction que le
-- changement métier, traitée ensuite, avec reprises. La clé d'idempotence
-- (fournisseur + opération + entité + version) empêche tout doublon.
CREATE TABLE pos_sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  provider         text NOT NULL,
  operation        text NOT NULL CHECK (operation IN ('upsert_sale', 'record_payment', 'record_refund')),
  entity_type      text NOT NULL CHECK (entity_type IN ('order', 'payment', 'refund')),
  entity_id        uuid NOT NULL,
  entity_version   integer NOT NULL DEFAULT 1,
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'succeeded', 'superseded', 'failed', 'dead')),
  attempts         integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL DEFAULT 8,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  external_id      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_sync_jobs_due_idx ON pos_sync_jobs (next_attempt_at) WHERE status IN ('pending', 'failed', 'processing');
CREATE INDEX pos_sync_jobs_club_idx ON pos_sync_jobs (club_id, created_at DESC);

CREATE TABLE pos_sync_log (
  id           bigserial PRIMARY KEY,
  job_id       uuid NOT NULL REFERENCES pos_sync_jobs(id),
  attempt      integer NOT NULL,
  success      boolean NOT NULL,
  error        text,
  duration_ms  integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pos_sync_log_job_idx ON pos_sync_log (job_id);

-- Reprise des réservations existantes : une commande par réservation.
INSERT INTO orders (club_id, booking_id, customer_id, reference, currency, status, total_minor, tax_minor)
SELECT b.club_id, b.id, b.customer_id, b.reference, coalesce(b.currency, c.currency),
       CASE WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'open' END,
       CASE WHEN b.status = 'cancelled' THEN 0 ELSE coalesce(b.total_minor, 0) END,
       CASE WHEN b.status = 'cancelled' THEN 0 ELSE coalesce((SELECT sum(tax_minor) FROM booking_charges bc WHERE bc.booking_id = b.id), 0) END
  FROM bookings b JOIN clubs c ON c.id = b.club_id;

INSERT INTO order_lines (order_id, position, kind, sku, label, quantity, unit_amount_minor, total_minor, tax_rate_bp, tax_minor, payable)
SELECT o.id, bc.position, bc.kind,
       CASE bc.kind WHEN 'resource' THEN coalesce(rt.code, 'RESOURCE') WHEN 'caddie' THEN 'CADDIE'
                    WHEN 'green_fee' THEN 'GREEN_FEE_' || b.holes ELSE 'PRIVATE_SURCHARGE' END,
       bc.label, bc.quantity, bc.unit_amount_minor, bc.total_minor, bc.tax_rate_bp, bc.tax_minor, bc.payable
  FROM booking_charges bc
  JOIN bookings b ON b.id = bc.booking_id AND b.status = 'confirmed'
  JOIN orders o ON o.booking_id = b.id
  LEFT JOIN resource_types rt ON rt.id = bc.resource_type_id;
