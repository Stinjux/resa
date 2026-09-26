-- Cohérence des périodes de validité des tarifs (comme pour les règles de grille).
ALTER TABLE tariffs ADD CONSTRAINT tariffs_check2
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);
