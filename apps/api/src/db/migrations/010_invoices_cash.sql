-- Factures, avoirs et clôtures de caisse.

-- Mentions légales du vendeur (Maroc : ICE, IF, RC, patente ; ailleurs : équivalents).
ALTER TABLE clubs
  ADD COLUMN legal_name text,
  ADD COLUMN legal_address text,
  ADD COLUMN ice text,            -- Identifiant commun de l'entreprise
  ADD COLUMN tax_id text,         -- Identifiant fiscal (IF)
  ADD COLUMN trade_register text, -- Registre du commerce (RC)
  ADD COLUMN patente text,
  ADD COLUMN invoice_footer text;

-- Numérotation continue, sans trou, par golf, type et année. Le numéro est
-- attribué dans la même transaction que le document.
CREATE TABLE document_sequences (
  club_id      uuid NOT NULL REFERENCES clubs(id),
  kind         text NOT NULL CHECK (kind IN ('invoice', 'credit_note', 'cash_closing')),
  year         integer NOT NULL,
  last_number  integer NOT NULL,
  PRIMARY KEY (club_id, kind, year)
);

-- Une facture est immuable : les lignes, le vendeur et l'acheteur sont figés
-- à l'émission. Une erreur se corrige par un avoir, puis une nouvelle facture.
CREATE TABLE invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id          uuid NOT NULL REFERENCES clubs(id),
  order_id         uuid NOT NULL REFERENCES orders(id),
  booking_id       uuid NOT NULL REFERENCES bookings(id),
  kind             text NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  number           text NOT NULL,
  original_id      uuid REFERENCES invoices(id), -- avoir : facture annulée
  issued_at        timestamptz NOT NULL DEFAULT now(),
  issued_by        uuid REFERENCES users(id),
  seller           jsonb NOT NULL,
  buyer            jsonb NOT NULL,
  currency         char(3) NOT NULL,
  lines            jsonb NOT NULL,
  total_ht_minor   integer NOT NULL,
  tax_minor        integer NOT NULL,
  total_minor      integer NOT NULL, -- TTC ; négatif pour un avoir
  paid_minor       integer NOT NULL, -- réglé à la date d'émission
  reason           text,
  UNIQUE (club_id, number),
  CHECK ((kind = 'credit_note') = (original_id IS NOT NULL))
);
CREATE INDEX invoices_order_idx ON invoices (order_id);
CREATE UNIQUE INDEX invoices_one_credit_note ON invoices (original_id) WHERE kind = 'credit_note';

-- Clôture de caisse (ticket Z) : regroupe les encaissements et remboursements
-- confirmés non encore clôturés ; écart entre espèces attendues et comptées.
CREATE TABLE cash_closings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id              uuid NOT NULL REFERENCES clubs(id),
  number               text NOT NULL,
  period_start         timestamptz,
  closed_at            timestamptz NOT NULL DEFAULT now(),
  closed_by            uuid REFERENCES users(id),
  currency             char(3) NOT NULL,
  totals               jsonb NOT NULL, -- par mode : encaissé, remboursé, net, nombre
  float_minor          integer NOT NULL DEFAULT 0 CHECK (float_minor >= 0), -- fond de caisse
  expected_cash_minor  integer NOT NULL,
  counted_cash_minor   integer NOT NULL CHECK (counted_cash_minor >= 0),
  difference_minor     integer NOT NULL,
  note                 text,
  UNIQUE (club_id, number)
);

ALTER TABLE payments ADD COLUMN closing_id uuid REFERENCES cash_closings(id);
ALTER TABLE refunds ADD COLUMN closing_id uuid REFERENCES cash_closings(id);
CREATE INDEX payments_unclosed_idx ON payments (club_id) WHERE closing_id IS NULL AND status = 'confirmed';
CREATE INDEX refunds_unclosed_idx ON refunds (club_id) WHERE closing_id IS NULL AND status = 'confirmed';
