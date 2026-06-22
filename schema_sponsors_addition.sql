-- ═══════════════════════════════════════════════════════════
-- MIGRATION : Table sponsors (mécénat Diamant/Or/Argent)
-- ═══════════════════════════════════════════════════════════
-- À exécuter sur la base PostgreSQL principale (kivirafacile-db).
-- Indépendante des autres tables — aucun risque pour les données
-- existantes (users, payments, etc.).
--
-- Logique : l'admin ajoute manuellement un nom après avoir reçu
-- un don par un autre moyen (PayPal, virement...). Pas de lien
-- avec le système de paiement automatisé (Transaction ID).
-- Le sponsor n'a pas forcément de compte utilisateur dans l'app —
-- c'est juste un nom à afficher, donc pas de clé étrangère vers users.

CREATE TABLE sponsors (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tier VARCHAR(20) NOT NULL CHECK (tier IN ('diamant', 'or', 'argent')),
    amount NUMERIC(10,2),              -- montant donné, pour référence admin (ex: 50.00)
    currency VARCHAR(3) DEFAULT 'USD', -- les seuils sont en $ (50/20/10), pas en FC
    message VARCHAR(255),              -- dédicace optionnelle du sponsor
    isVisible BOOLEAN DEFAULT true,    -- masquer sans supprimer (ex: don ponctuel expiré)
    displayOrder INT DEFAULT 0,        -- tri manuel à l'intérieur d'un même palier
    addedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sponsors_tier ON sponsors(tier);
CREATE INDEX idx_sponsors_visible ON sponsors(isVisible);

-- ═══════════════════════════════════════════════════════════
-- VÉRIFICATION
-- ═══════════════════════════════════════════════════════════
-- \d sponsors     → doit montrer les colonnes ci-dessus
-- SELECT * FROM sponsors;   → doit être vide au départ
