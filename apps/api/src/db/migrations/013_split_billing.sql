-- Facturation souple : part client / part partenaire, factures partenaire groupées.

-- Ce que le partenaire prend à sa charge sur ses réservations :
--   all        : tout (green fees, caddie, matériel…)
--   green_fees : green fees, supplément privé, frais d'annulation / d'absence ; le reste est payé par le client
--   none       : rien ; le client paie tout (au tarif négocié du partenaire)
ALTER TABLE partners ADD COLUMN billing_scope text NOT NULL DEFAULT 'green_fees'
  CHECK (billing_scope IN ('all', 'green_fees', 'none'));

ALTER TABLE order_lines ADD COLUMN payer text NOT NULL DEFAULT 'customer' CHECK (payer IN ('customer', 'partner'));
ALTER TABLE payments ADD COLUMN payer text NOT NULL DEFAULT 'customer' CHECK (payer IN ('customer', 'partner'));
ALTER TABLE refunds ADD COLUMN payer text NOT NULL DEFAULT 'customer' CHECK (payer IN ('customer', 'partner'));

UPDATE order_lines ol SET payer = 'partner'
  FROM orders o JOIN bookings b ON b.id = o.booking_id
 WHERE ol.order_id = o.id AND b.partner_id IS NOT NULL
   AND ol.kind IN ('green_fee', 'private_surcharge', 'cancellation_fee', 'no_show_fee');

-- Une facture peut couvrir plusieurs réservations (facture partenaire).
ALTER TABLE invoices
  ADD COLUMN payer text NOT NULL DEFAULT 'customer' CHECK (payer IN ('customer', 'partner')),
  ADD COLUMN partner_id uuid REFERENCES partners(id),
  ADD COLUMN due_date date,
  ALTER COLUMN order_id DROP NOT NULL,
  ALTER COLUMN booking_id DROP NOT NULL;

CREATE TABLE invoice_items (
  invoice_id    uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id),
  booking_id    uuid NOT NULL REFERENCES bookings(id),
  amount_minor  integer NOT NULL,
  PRIMARY KEY (invoice_id, order_id)
);
CREATE INDEX invoice_items_order_idx ON invoice_items (order_id);
INSERT INTO invoice_items (invoice_id, order_id, booking_id, amount_minor)
  SELECT id, order_id, booking_id, total_minor FROM invoices WHERE order_id IS NOT NULL;

ALTER TABLE document_sequences DROP CONSTRAINT document_sequences_kind_check;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_kind_check
  CHECK (kind IN ('invoice', 'partner_invoice', 'credit_note', 'cash_closing'));
