-- ═══════════════════════════════════════════════════════════════
-- KIVIRAFACILE — SCHÉMA POSTGRESQL COMPLET (TOUT EN UN)
-- ═══════════════════════════════════════════════════════════════
-- À exécuter UNE SEULE FOIS sur votre base Render PostgreSQL,
-- juste après sa création. Crée les 9 tables nécessaires aux
-- DEUX backends (auth/payments + traduction), qui partagent
-- cette même base.

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- BLOC 1 : TABLES PRINCIPALES (auth, premium général, anti-fraude)
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    uuid VARCHAR(36) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    isPremium BOOLEAN DEFAULT false,
    isBlocked BOOLEAN DEFAULT false,
    premiumExpiresAt TIMESTAMP NULL,
    registrationIP VARCHAR(45),
    deviceFingerprint VARCHAR(255),
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Abonnement traduction indépendant (2000fc), ajouté directement ici
    isTranslationPremium BOOLEAN DEFAULT false,
    translationPremiumExpiresAt TIMESTAMP NULL
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_uuid ON users(uuid);
CREATE INDEX idx_users_device ON users(deviceFingerprint);
CREATE INDEX idx_users_premium ON users(isPremium);
CREATE INDEX idx_users_translation_premium ON users(isTranslationPremium);

CREATE TABLE payments (
    id SERIAL PRIMARY KEY,
    paymentUuid VARCHAR(36) UNIQUE NOT NULL,
    userUuid VARCHAR(36) NOT NULL,
    userName VARCHAR(255),
    userEmail VARCHAR(255),
    transactionId VARCHAR(255) UNIQUE NOT NULL,
    phoneNumber VARCHAR(20) NOT NULL,
    operator VARCHAR(50),
    amount VARCHAR(10) DEFAULT '1000',
    currency VARCHAR(3) DEFAULT 'FC',
    status VARCHAR(20) DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    deviceFingerprint VARCHAR(255),
    submittedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    validatedAt TIMESTAMP NULL,
    -- Distingue abonnement général (1000fc) vs traduction (2000fc)
    productType VARCHAR(20) DEFAULT 'general' CHECK (productType IN ('general', 'translation')),

    FOREIGN KEY (userUuid) REFERENCES users(uuid) ON DELETE CASCADE
);

CREATE INDEX idx_payments_user ON payments(userUuid);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_transaction ON payments(transactionId);
CREATE INDEX idx_payments_phone ON payments(phoneNumber);
CREATE INDEX idx_payments_submitted ON payments(submittedAt);
CREATE INDEX idx_payments_product_type ON payments(productType);

CREATE TABLE blockedPhones (
    id SERIAL PRIMARY KEY,
    number VARCHAR(20) UNIQUE NOT NULL,
    reason VARCHAR(255),
    blockedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_blockedphones_number ON blockedPhones(number);

CREATE TABLE blockedDevices (
    id SERIAL PRIMARY KEY,
    fingerprint VARCHAR(255) UNIQUE NOT NULL,
    reason VARCHAR(255),
    blockedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_blockeddevices_fingerprint ON blockedDevices(fingerprint);

CREATE TABLE translations (
    id SERIAL PRIMARY KEY,
    userUuid VARCHAR(36),
    sourceText TEXT,
    translatedText TEXT,
    direction VARCHAR(50),
    timestamp VARCHAR(50),
    date VARCHAR(50),
    savedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (userUuid) REFERENCES users(uuid) ON DELETE SET NULL
);

CREATE INDEX idx_translations_user ON translations(userUuid);

CREATE TABLE ip_tracking (
    id SERIAL PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL,
    userUuid VARCHAR(36) NOT NULL,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (userUuid) REFERENCES users(uuid) ON DELETE CASCADE
);

CREATE INDEX idx_iptracking_ip ON ip_tracking(ip_address);
CREATE INDEX idx_iptracking_user ON ip_tracking(userUuid);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- BLOC 2 : TABLES DU SERVICE DE TRADUCTION (KiviraAI)
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CREATE TABLE translation_usage (
    id SERIAL PRIMARY KEY,
    userUuid VARCHAR(36) NOT NULL UNIQUE,
    translation_count INT NOT NULL DEFAULT 0,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (userUuid) REFERENCES users(uuid) ON DELETE CASCADE
);

CREATE INDEX idx_translation_usage_user ON translation_usage(userUuid);

CREATE TABLE translation_history (
    id SERIAL PRIMARY KEY,
    userUuid VARCHAR(36) NOT NULL,
    input_text VARCHAR(100) NOT NULL,
    output_text TEXT NOT NULL,
    is_validated BOOLEAN DEFAULT false,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (userUuid) REFERENCES users(uuid) ON DELETE SET NULL
);

CREATE INDEX idx_translation_history_user ON translation_history(userUuid);
CREATE INDEX idx_translation_history_created ON translation_history(createdAt);
CREATE INDEX idx_translation_history_validated ON translation_history(is_validated);

CREATE TABLE translation_cache (
    id SERIAL PRIMARY KEY,
    input_text_normalized VARCHAR(100) NOT NULL UNIQUE,
    output_text TEXT NOT NULL,
    hit_count INT DEFAULT 1,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_translation_cache_input ON translation_cache(input_text_normalized);

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- FIN — Vérifiez avec : \dt   (doit lister 9 tables)
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
