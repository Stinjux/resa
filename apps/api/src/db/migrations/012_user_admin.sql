-- Gestion des comptes : mot de passe provisoire à changer, dernière connexion.
ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN last_login_at timestamptz;
