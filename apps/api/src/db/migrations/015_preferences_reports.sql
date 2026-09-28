-- Préférences d'interface par utilisateur (barre de menu, blocs de rapport)
-- et envois programmés de rapports.

ALTER TABLE users ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';

CREATE TABLE report_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL,
  frequency        text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  recipients       text[] NOT NULL CHECK (cardinality(recipients) BETWEEN 1 AND 10),
  config           jsonb NOT NULL, -- golfs, filtres, blocs, comparaison
  active           boolean NOT NULL DEFAULT true,
  next_run_at      timestamptz NOT NULL,
  last_run_at      timestamptz,
  last_status      text CHECK (last_status IN ('sent', 'logged', 'failed')),
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_schedules_due_idx ON report_schedules (next_run_at) WHERE active;
