-- Opérations du jour : départs bloqués par le personnel, arrivée des joueurs,
-- absences (no-show) et départ effectif.

ALTER TABLE tee_times
  ADD COLUMN blocked_reason text,           -- non NULL = départ bloqué (tournoi, entretien, VIP…)
  ADD COLUMN blocked_by uuid REFERENCES users(id),
  ADD COLUMN blocked_at timestamptz,
  ADD COLUMN started_at timestamptz;        -- départ effectivement parti (starter)

ALTER TABLE bookings
  ADD COLUMN checkin_status text NOT NULL DEFAULT 'expected' CHECK (checkin_status IN ('expected', 'arrived', 'no_show')),
  ADD COLUMN checked_in_at timestamptz,
  ADD COLUMN checkin_by uuid REFERENCES users(id);

-- Absence : part du prix restant due (100 = tout reste dû, 0 = rien).
ALTER TABLE clubs ADD COLUMN no_show_fee_percent integer NOT NULL DEFAULT 100 CHECK (no_show_fee_percent BETWEEN 0 AND 100);

ALTER TABLE order_lines DROP CONSTRAINT order_lines_kind_check;
ALTER TABLE order_lines ADD CONSTRAINT order_lines_kind_check
  CHECK (kind IN ('green_fee', 'private_surcharge', 'caddie', 'resource', 'cancellation_fee', 'no_show_fee'));
