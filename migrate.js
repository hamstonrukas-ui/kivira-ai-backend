// ═══════════════════════════════════════════════════════════
// Script de migration — crée toutes les tables PostgreSQL
// ═══════════════════════════════════════════════════════════
// Usage : node migrate.js
// À exécuter UNE SEULE FOIS, depuis le Shell Render de votre
// backend (Web Service > Shell), après le premier déploiement.
//
// Pourquoi ce script plutôt que psql ?
// Sur mobile, pas de terminal psql installable. Ce script
// réutilise le package "pg" déjà présent dans vos dépendances
// pour exécuter le schéma SQL directement.

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function migrate() {
  const sqlPath = path.join(__dirname, 'schema.sql');

  if (!fs.existsSync(sqlPath)) {
    console.error('❌ Fichier schema.sql introuvable. Vérifiez qu\'il est bien à la racine du projet.');
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf-8');

  console.log('🔧 Connexion à la base...');
  try {
    await pool.query(sql);
    console.log('✅ Migration terminée avec succès ! Toutes les tables ont été créées.');

    // Vérification : lister les tables créées
    const result = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    console.log('\n📋 Tables présentes dans la base :');
    result.rows.forEach(row => console.log('  -', row.table_name));

  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('⚠️  Certaines tables existent déjà — la migration a probablement déjà été exécutée.');
      console.log('   Détail :', err.message);
    } else {
      console.error('❌ Erreur lors de la migration:', err.message);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

migrate();
