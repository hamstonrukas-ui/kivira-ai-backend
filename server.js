// ═══════════════════════════════════════════════════════════
// KiviraAI Backend — Relais sécurisé pour Claude Haiku
// ═══════════════════════════════════════════════════════════
// Rôle de ce serveur :
//   1. Cacher la clé API Anthropic (jamais exposée au navigateur)
//   2. Vérifier l'authentification de l'utilisateur (JWT existant)
//   3. Appliquer le quota de 3 traductions gratuites À VIE par utilisateur
//   4. Mettre en cache le system prompt (90% moins cher sur les répétitions)
//   5. Mettre en cache les traductions identiques déjà faites (0 coût)
//   6. Enregistrer chaque traduction (corpus pour amélioration future)
//
// ── VERSION CORRIGÉE v2 ──
// Connecté à la MÊME base PostgreSQL que le système d'authentification.
// - JWT : lit le champ `uuid` (format réel émis par le backend principal :
//   jwt.sign({ uuid: userUuid, email }, JWT_SECRET, { expiresIn: '30d' }))
// - Premium : vérifie `isTranslationPremium` — un abonnement à 2000fc
//   INDÉPENDANT du premium général à 1000fc (isPremium, qui couvre
//   dictionnaire + bibliothèque + leçons). Un utilisateur peut avoir
//   l'un, l'autre, les deux, ou aucun.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FREE_QUOTA = parseInt(process.env.FREE_TRANSLATION_QUOTA || '3', 10);
// Plafond anti-abus pour les utilisateurs PREMIUM (qui sont "illimités" dans
// le temps, mais doivent rester bornés par jour pour éviter qu'un usage
// automatisé ne fasse exploser les coûts API). Les utilisateurs gratuits
// (3 traductions à vie) n'atteignent jamais ce plafond, donc il ne les concerne pas.
const DAILY_TRANSLATION_LIMIT = parseInt(process.env.DAILY_TRANSLATION_LIMIT || '20', 10);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY manquante dans les variables d\'environnement.');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET manquante — nécessaire pour vérifier les utilisateurs connectés.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Chargement des données statiques (system prompt + lexique)
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, 'data', 'system_prompt.txt'),
  'utf-8'
);
const LEXICON = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'kivira_lexicon.json'), 'utf-8')
);
console.log(`✓ Lexique chargé : ${LEXICON.length} entrées (${LEXICON.filter(e => e.priority).length} prioritaires)`);

// ─────────────────────────────────────────────────────────────
// Connexion PostgreSQL (MÊME base que le système d'authentification)
// ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.connect()
  .then(client => {
    console.log('💾 PostgreSQL connecté avec succès (service traduction)');
    client.release();
  })
  .catch(err => {
    console.error('❌ Erreur connexion PostgreSQL:', err.message);
    process.exit(1);
  });

// ─────────────────────────────────────────────────────────────
// Authentification — lit le champ "uuid" du JWT
// (format réel émis par le système auth.js / server.js principal)
// ─────────────────────────────────────────────────────────────
function verifyAuthToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Le système d'auth signe les tokens avec { uuid, email }
    return decoded.uuid || null;
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const userUuid = verifyAuthToken(req);
  if (!userUuid) {
    return res.status(401).json({ message: 'Authentification requise. Veuillez vous connecter.' });
  }
  req.userUuid = userUuid;
  next();
}

// ─────────────────────────────────────────────────────────────
// Vérifie le statut premium TRADUCTION (abonnement 2000fc,
// INDÉPENDANT du premium général 1000fc qui couvre dico+bibliothèque).
// Colonne réelle : isTranslationPremium (pas isPremium !)
// ─────────────────────────────────────────────────────────────
async function isUserPremium(userUuid) {
  try {
    const result = await pool.query(
      'SELECT isTranslationPremium, translationPremiumExpiresAt FROM users WHERE uuid = $1 LIMIT 1',
      [userUuid]
    );
    if (result.rows.length === 0) return false;

    const user = result.rows[0];
    // Un premium "temporaire" (48h en attente de validation admin) reste
    // valable seulement si translationPremiumExpiresAt n'est pas encore dépassé.
    // Un premium permanent a translationPremiumExpiresAt = NULL.
    if (!user.istranslationpremium) return false;
    if (user.translationpremiumexpiresat && new Date() > new Date(user.translationpremiumexpiresat)) {
      return false; // Premium temporaire expiré
    }
    return true;
  } catch (err) {
    console.error('Erreur vérification premium traduction:', err.message);
    // En cas d'erreur DB, on considère l'utilisateur comme non-premium
    // par sécurité (évite de donner un accès illimité par défaut).
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Gestion du quota de traductions gratuites (à vie, pas par jour)
// ─────────────────────────────────────────────────────────────
async function getTranslationCount(userUuid) {
  const result = await pool.query(
    'SELECT translation_count FROM translation_usage WHERE userUuid = $1 LIMIT 1',
    [userUuid]
  );
  return result.rows.length > 0 ? result.rows[0].translation_count : 0;
}

async function incrementTranslationCount(userUuid) {
  await pool.query(
    `INSERT INTO translation_usage (userUuid, translation_count)
     VALUES ($1, 1)
     ON CONFLICT (userUuid) DO UPDATE SET translation_count = translation_usage.translation_count + 1, updatedAt = NOW()`,
    [userUuid]
  );
}

// ─────────────────────────────────────────────────────────────
// Plafond quotidien (utilisateurs premium uniquement) — réutilise
// translation_history, qui contient déjà chaque traduction horodatée.
// Pas besoin de table de compteur séparée à réinitialiser chaque jour.
// Note : CURRENT_DATE suit le fuseau horaire du serveur PostgreSQL
// (UTC sur Render par défaut) — le "jour" bascule donc à minuit UTC,
// pas à minuit heure de Bukavu (UTC+2). Décalage de 2h, sans impact
// pratique sur un plafond de 20/jour.
// ─────────────────────────────────────────────────────────────
async function getDailyTranslationCount(userUuid) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM translation_history
     WHERE userUuid = $1 AND createdAt >= CURRENT_DATE`,
    [userUuid]
  );
  return parseInt(result.rows[0].count, 10);
}

// ─────────────────────────────────────────────────────────────
// Cache de traductions exactes (évite de rappeler Claude pour
// une phrase déjà traduite par n'importe quel utilisateur)
// ─────────────────────────────────────────────────────────────
function normalizeText(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getCachedTranslation(text) {
  const normalized = normalizeText(text);
  const result = await pool.query(
    'SELECT output_text FROM translation_cache WHERE input_text_normalized = $1 LIMIT 1',
    [normalized]
  );
  if (result.rows.length > 0) {
    // Incrémenter le compteur de hits (asynchrone, on n'attend pas)
    pool.query(
      'UPDATE translation_cache SET hit_count = hit_count + 1, last_used_at = NOW() WHERE input_text_normalized = $1',
      [normalized]
    ).catch(e => console.warn('Erreur update cache hit:', e.message));
    return result.rows[0].output_text;
  }
  return null;
}

async function saveToCache(text, translation) {
  const normalized = normalizeText(text);
  try {
    await pool.query(
      `INSERT INTO translation_cache (input_text_normalized, output_text)
       VALUES ($1, $2)
       ON CONFLICT (input_text_normalized) DO NOTHING`,
      [normalized, translation]
    );
  } catch (err) {
    console.warn('Erreur sauvegarde cache:', err.message);
  }
}

async function saveToHistory(userUuid, text, translation) {
  try {
    await pool.query(
      'INSERT INTO translation_history (userUuid, input_text, output_text) VALUES ($1, $2, $3)',
      [userUuid, text, translation]
    );
  } catch (err) {
    console.warn('Erreur sauvegarde historique:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// Moteur de recherche lexicale (même logique que le frontend v2,
// reproduite ici côté serveur)
// ─────────────────────────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'le','la','les','un','une','des','de','du','d','l','je','tu','il','elle',
  'nous','vous','ils','elles','me','te','se','mon','ma','mes','ton','ta','tes',
  'son','sa','ses','notre','nos','votre','vos','leur','leurs','ce','cet','cette',
  'ces','et','ou','mais','donc','car','si','que','qui','quand','comme','ne',
  'pas','plus','très','trop','est','sont','a','ont','au','aux','en','sur',
  'dans','par','pour','avec','sans','vers','chez','entre','après','avant',
  'y','on','ça','cela','ceci','tout','tous','toute','toutes'
]);

function extractWords(phrase) {
  return normalize(phrase).split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function searchLexicon(phrase, maxResults = 30) {
  const words = extractWords(phrase);
  if (words.length === 0) return [];

  const scored = [];
  for (const entry of LEXICON) {
    const frNorm = normalize(entry.fr);
    const frWords = frNorm.split(' ');
    let score = 0;
    for (const word of words) {
      if (frWords.length === 1 && frWords[0] === word) score += 10;
      else if (frWords.includes(word)) score += 3;
      else if (frNorm.startsWith(word) || frNorm.endsWith(word)) score += 1;
      else if (frNorm.includes(word) && word.length > 4) score += 0.5;
    }
    if (score > 0 && entry.priority) score += 1000;
    if (score > 0) scored.push([entry, score]);
  }

  return scored.sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([e]) => e);
}

function formatEntry(e) {
  let syn = '';
  if (e.synonymes && e.synonymes.length > 0) {
    syn = ` (synonyme accepté: ${e.synonymes.join(', ')})`;
  }
  if (e.type === 'verbe') {
    return `  ${e.kv} = ${e.fr}${syn}`;
  } else if (e.type === 'nom') {
    const pl = e.kv_pl ? ` / PL: ${e.kv_pl}` : '';
    const cl = e.classe ? ` [Cl.${e.classe}]` : '';
    const ex = e.exemple ? ` → Ex: ${e.exemple}` : '';
    return `  SG: ${e.kv}${pl}${cl} = ${e.fr}${syn}${ex}`;
  } else if (e.type === 'adjectif') {
    const ex = e.exemple ? ` (ex: ${e.exemple})` : '';
    return `  ${e.kv} = ${e.fr}${syn}${ex}`;
  }
  return `  ${e.kv} = ${e.fr}${syn}`;
}

function formatLexiconForPrompt(entries) {
  if (!entries || entries.length === 0) return '';
  const prioritaires = entries.filter(e => e.priority);
  const generaux = entries.filter(e => !e.priority);

  let out = '';
  if (prioritaires.length > 0) {
    out += '\n═══════════════════════════════════════════════════\n';
    out += '🔒 LEXIQUE PRIORITAIRE — VALIDÉ PAR LOCUTEUR NATIF\n';
    out += '═══════════════════════════════════════════════════\n';
    out += "RÈGLE ABSOLUE : ces traductions sont la SEULE vérité. Utilise-les TELLES QUELLES,\n";
    out += "sans aucune modification, substitution ou \"amélioration\".\n\n";
    for (const e of prioritaires) out += formatEntry(e) + '\n';
  }
  if (generaux.length > 0) {
    out += '\n───────────────────────────────────────────────────\n';
    out += 'LEXIQUE GÉNÉRAL (complémentaire)\n';
    out += '───────────────────────────────────────────────────\n';
    for (const e of generaux) out += formatEntry(e) + '\n';
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Appel à l'API Anthropic avec prompt caching activé
// ─────────────────────────────────────────────────────────────
async function callClaude(userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' } // ← active le prompt caching
        }
      ],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `Erreur API Anthropic (${response.status})`);
  }
  return data.content[0].text;
}

// ─────────────────────────────────────────────────────────────
// ROUTE : GET /api/translate/quota
// Retourne le quota restant sans consommer de traduction
// ─────────────────────────────────────────────────────────────
app.get('/api/translate/quota', requireAuth, async (req, res) => {
  try {
    const premium = await isUserPremium(req.userUuid);
    const used = await getTranslationCount(req.userUuid);
    const remaining = premium ? null : Math.max(0, FREE_QUOTA - used);

    // Le plafond quotidien ne concerne que les premium (cf. note plus haut)
    let dailyRemaining = null;
    if (premium) {
      const dailyUsed = await getDailyTranslationCount(req.userUuid);
      dailyRemaining = Math.max(0, DAILY_TRANSLATION_LIMIT - dailyUsed);
    }

    res.json({ quotaRemaining: remaining, dailyRemaining, isPremium: premium, used });
  } catch (err) {
    console.error('Erreur /quota:', err);
    res.status(500).json({ message: 'Erreur serveur lors de la vérification du quota.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ROUTE : POST /api/translate
// Traduit le texte, en respectant le quota gratuit à vie
// ─────────────────────────────────────────────────────────────
app.post('/api/translate', requireAuth, async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ message: 'Texte à traduire manquant.' });
    }
    if (text.length > 100) {
      return res.status(400).json({ message: 'Le texte ne doit pas dépasser 100 caractères.' });
    }

    const premium = await isUserPremium(req.userUuid);

    if (!premium) {
      // ── Utilisateur gratuit : quota à vie (3 traductions) ──
      const used = await getTranslationCount(req.userUuid);
      if (used >= FREE_QUOTA) {
        return res.status(402).json({
          code: 'QUOTA_EXCEEDED',
          message: 'Vous avez utilisé vos 3 traductions gratuites. Passez Premium Traduction (2000 FC) pour continuer.',
          quotaRemaining: 0
        });
      }
    } else {
      // ── Utilisateur premium traduction : plafond quotidien anti-abus ──
      // Le premium est illimité dans la durée (pas d'expiration d'usage),
      // mais plafonné par jour pour éviter qu'un usage automatisé/abusif
      // ne fasse exploser les coûts API.
      const dailyUsed = await getDailyTranslationCount(req.userUuid);
      if (dailyUsed >= DAILY_TRANSLATION_LIMIT) {
        return res.status(429).json({
          code: 'DAILY_LIMIT_EXCEEDED',
          message: `Limite quotidienne de ${DAILY_TRANSLATION_LIMIT} traductions atteinte. Réessayez demain.`,
          dailyRemaining: 0
        });
      }
    }

    // ── Vérifier le cache de traductions exactes avant d'appeler Claude ──
    let translation = await getCachedTranslation(text);
    let fromCache = !!translation;

    if (!translation) {
      const relevantEntries = searchLexicon(text);
      const lexiconInjection = formatLexiconForPrompt(relevantEntries);
      const userPrompt = `Traduis cette phrase du français en Kivira. Donne UNIQUEMENT la traduction en Kivira, sans commentaire.${lexiconInjection}\n\nPhrase : ${text}`;

      translation = await callClaude(userPrompt);
      await saveToCache(text, translation);
    }

    // ── Incrémenter le quota seulement pour les utilisateurs non-premium ──
    if (!premium) {
      await incrementTranslationCount(req.userUuid);
    }

    await saveToHistory(req.userUuid, text, translation);

    const used = await getTranslationCount(req.userUuid);
    const remaining = premium ? null : Math.max(0, FREE_QUOTA - used);

    // dailyRemaining ne concerne que les premium — saveToHistory vient juste
    // d'enregistrer cette traduction, donc le compte inclut déjà celle-ci.
    let dailyRemaining = null;
    if (premium) {
      const dailyUsed = await getDailyTranslationCount(req.userUuid);
      dailyRemaining = Math.max(0, DAILY_TRANSLATION_LIMIT - dailyUsed);
    }

    res.json({
      translation,
      quotaRemaining: remaining,
      dailyRemaining,
      isPremium: premium,
      fromCache
    });

  } catch (err) {
    console.error('Erreur /translate:', err);
    res.status(500).json({ message: 'Erreur serveur lors de la traduction. Veuillez réessayer.' });
  }
});

// ─────────────────────────────────────────────────────────────
// Healthcheck (utile pour Render)
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', lexiconEntries: LEXICON.length });
});

app.listen(PORT, () => {
  console.log(`✓ KiviraAI Backend démarré sur le port ${PORT}`);
  console.log(`✓ Modèle Claude utilisé : ${CLAUDE_MODEL}`);
  console.log(`✓ Quota gratuit : ${FREE_QUOTA} traductions à vie`);
  console.log(`✓ Premium vérifié : isTranslationPremium (indépendant du premium général)`);
});
