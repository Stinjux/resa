-- Le caddie est facturé UNE fois par départ (200 DH en 18 trous, 100 DH en 9),
-- quel que soit le nombre de réservations. Répartition entre les réservations
-- du départ, configurable par golf :
--   pro_rata_players : au prorata des joueurs (défaut)
--   equal            : à parts égales entre réservations
--   first_booking    : entièrement à la première réservation du départ
ALTER TABLE clubs ADD COLUMN caddie_fee_split text NOT NULL DEFAULT 'pro_rata_players'
  CHECK (caddie_fee_split IN ('pro_rata_players', 'equal', 'first_booking'));
