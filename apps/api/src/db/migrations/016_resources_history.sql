-- Disponibilité des ressources et historique fiable.
--
-- 1. Indisponibilités datées : maintenance d'une unité de matériel
--    (voiturette n° 12…) ou absence d'un caddie. Elles réduisent la capacité
--    du type sur leur période et interdisent l'affectation nominative.
-- 2. Historique (audit_log) : éléments liés (refs) pour retrouver un
--    événement depuis chaque réservation concernée, motif, et protection
--    contre toute modification ou suppression.

CREATE TABLE resource_unavailabilities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id           uuid NOT NULL REFERENCES clubs(id),
  -- Type dont la capacité est réduite (NULL : caddie d'un golf sans type caddie).
  resource_type_id  uuid REFERENCES resource_types(id),
  unit_id           uuid REFERENCES resource_units(id),
  caddie_id         uuid REFERENCES caddies(id),
  kind              text NOT NULL CHECK (kind IN ('maintenance', 'unavailable')),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,              -- NULL = jusqu'à nouvel ordre
  reason            text NOT NULL CHECK (length(trim(reason)) > 0),
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz,              -- annulée avant d'avoir commencé
  CHECK ((unit_id IS NULL) <> (caddie_id IS NULL)),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX resource_unavailabilities_type_idx
  ON resource_unavailabilities USING gist (resource_type_id, tstzrange(starts_at, ends_at, '[)'))
  WHERE cancelled_at IS NULL;
CREATE INDEX resource_unavailabilities_unit_idx ON resource_unavailabilities (unit_id) WHERE cancelled_at IS NULL;
CREATE INDEX resource_unavailabilities_caddie_idx ON resource_unavailabilities (caddie_id) WHERE cancelled_at IS NULL;

-- Reprise de l'ancien statut « maintenance » (sans dates) : maintenance
-- ouverte à partir de maintenant ; l'unité redevient « available » (le statut
-- ne sert plus qu'à retirer définitivement une unité : « retired »).
INSERT INTO resource_unavailabilities (club_id, resource_type_id, unit_id, kind, starts_at, reason)
SELECT rt.club_id, rt.id, u.id, 'maintenance', now(), 'Maintenance en cours (reprise de l''ancien statut)'
  FROM resource_units u JOIN resource_types rt ON rt.id = u.resource_type_id
 WHERE u.status = 'maintenance';
UPDATE resource_units SET status = 'available' WHERE status = 'maintenance';

-- Historique
ALTER TABLE audit_log
  ADD COLUMN refs uuid[] NOT NULL DEFAULT '{}',   -- réservations, départ, unités, caddies concernés
  ADD COLUMN reason text;                          -- motif saisi (annulation, remboursement, maintenance…)
CREATE INDEX audit_log_refs_idx ON audit_log USING gin (refs);
CREATE INDEX audit_log_club_time_idx ON audit_log (club_id, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id DESC);

-- L'historique ne se modifie pas et ne s'efface pas, quelle que soit l'origine.
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est en lecture seule (%).', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
