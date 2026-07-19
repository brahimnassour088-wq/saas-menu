// ============================================================
// SCRIPT POUR CRÉER UN NOUVEAU COMPTE COMMERÇANT
// ============================================================
// Utilisation dans le terminal :
//   node creer-compte.js <slug> <nom-affiché> <mot-de-passe>
//
// Exemple pour un vrai restaurant :
//   node creer-compte.js chez-fatime "Chez Fatimé" motDePasseSolide123
//
// "slug" = l'identifiant unique dans l'adresse, sans espace ni accent
// (ex: chez-fatime). C'est CE mot qui apparaîtra dans le lien du QR
// code : tonsite.com/menu/chez-fatime
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');

function creerHachage(motDePasse) {
  const sel = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(motDePasse, sel, 64).toString('hex');
  return { sel, hash };
}

const [, , slug, nom, motDePasse] = process.argv;

if (!slug || !nom || !motDePasse) {
  console.log('Utilisation : node creer-compte.js <slug> <nom-affiché> <mot-de-passe>');
  console.log('Exemple     : node creer-compte.js chez-fatime "Chez Fatimé" monMotDePasse123');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));

if (db.commercants[slug]) {
  console.log(`⚠️  Le slug "${slug}" existe déjà. Choisis-en un autre.`);
  process.exit(1);
}

const { sel, hash } = creerHachage(motDePasse);

db.commercants[slug] = {
  nom,
  sel,
  motDePasseHash: hash,
  produits: [
    { nom: 'Exemple de produit', prix: 1000 },
  ],
};

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');

console.log(`✅ Compte créé pour "${nom}"`);
console.log(`   Identifiant : ${slug}`);
console.log(`   Page publique (pour le QR code) : /menu/${slug}`);
console.log(`   Connexion : /login`);
