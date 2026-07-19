// ============================================================
// SERVEUR DU SAAS "MENU QR CODE"
// ============================================================
// Ce fichier est "le code derrière" (le backend).
// Il n'utilise QUE des outils déjà inclus dans Node.js
// (pas besoin d'installer quoi que ce soit avec npm install
// pour que ça tourne — donc pas besoin de carte bancaire).
//
// Ce que fait ce serveur :
// 1. Il garde en mémoire, dans le fichier db.json, un "tiroir"
//    par commerçant (ses produits, ses prix, son mot de passe).
// 2. Il affiche une page publique par commerçant → c'est CETTE
//    page que le QR code va pointer.
// 3. Il donne à chaque commerçant un espace privé (dashboard)
//    où il peut changer ses prix lui-même.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');

const DB_PATH = path.join(__dirname, 'db.json');
const PORT = process.env.PORT || 3000;

// Les "connexions actives" : qui a le droit d'entrer dans quel tiroir.
// (En mémoire : ça se vide si le serveur redémarre. Pour un vrai
// site avec beaucoup de monde, on ferait ça autrement plus tard.)
const sessions = {}; // token -> slug du commerçant

// ------------------------------------------------------------
// OUTILS : lire / écrire le "classeur" (la base de données JSON)
// ------------------------------------------------------------
function lireDB() {
  const contenu = fs.readFileSync(DB_PATH, 'utf-8');
  return JSON.parse(contenu);
}

function ecrireDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// ------------------------------------------------------------
// OUTILS : mot de passe (on ne stocke JAMAIS le mot de passe en clair)
// ------------------------------------------------------------
function hacherMotDePasse(motDePasse, sel) {
  return crypto.scryptSync(motDePasse, sel, 64).toString('hex');
}

function creerHachage(motDePasse) {
  const sel = crypto.randomBytes(16).toString('hex');
  const hash = hacherMotDePasse(motDePasse, sel);
  return { sel, hash };
}

function verifierMotDePasse(motDePasse, sel, hashAttendu) {
  const hash = hacherMotDePasse(motDePasse, sel);
  return hash === hashAttendu;
}

// ------------------------------------------------------------
// OUTILS : cookies (pour savoir "qui est connecté")
// ------------------------------------------------------------
function lireCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(paire => {
    const [cle, valeur] = paire.trim().split('=');
    if (cle) cookies[cle] = decodeURIComponent(valeur || '');
  });
  return cookies;
}

function slugDepuisRequete(req) {
  const cookies = lireCookies(req);
  const token = cookies.session;
  if (token && sessions[token]) return sessions[token];
  return null;
}

// ------------------------------------------------------------
// PAGES HTML (le "code devant", ici sous forme de gabarits simples)
// ------------------------------------------------------------
function pageLogin(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Connexion commerçant</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="carte">
    <h1>Connexion</h1>
    ${erreur ? `<p class="erreur">${erreur}</p>` : ''}
    <form method="POST" action="/login">
      <label>Identifiant<br><input name="slug" required></label><br><br>
      <label>Mot de passe<br><input type="password" name="motdepasse" required></label><br><br>
      <button type="submit">Se connecter</button>
    </form>
  </div>
</body>
</html>`;
}

function pageDashboard(commercant, slug) {
  const lignesProduits = commercant.produits.map((p, i) => `
    <tr>
      <form method="POST" action="/dashboard/update">
        <input type="hidden" name="index" value="${i}">
        <td><input name="nom" value="${p.nom}" required></td>
        <td><input name="prix" type="number" value="${p.prix}" required> FCFA</td>
        <td>
          <button type="submit">Enregistrer</button>
          <button type="submit" formaction="/dashboard/delete" style="background:#a33;">Supprimer</button>
        </td>
      </form>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Tableau de bord - ${commercant.nom}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="carte large">
    <div class="entete">
      <h1>${commercant.nom}</h1>
      <a href="/logout">Se déconnecter</a>
    </div>
    <p>Ta page publique (celle que le QR code va afficher) :
      <a href="/menu/${slug}" target="_blank">/menu/${slug}</a>
    </p>

    <h2>Tes produits</h2>
    <table>
      <tr><th>Nom</th><th>Prix</th><th></th></tr>
      ${lignesProduits}
    </table>

    <h2>Ajouter un produit</h2>
    <form method="POST" action="/dashboard/add">
      <input name="nom" placeholder="Nom du produit" required>
      <input name="prix" type="number" placeholder="Prix" required>
      <button type="submit">Ajouter</button>
    </form>
  </div>
</body>
</html>`;
}

function pageMenuPublic(commercant) {
  const lignesProduits = commercant.produits.map(p => `
    <div class="produit">
      <span>${p.nom}</span>
      <span class="prix">${p.prix} FCFA</span>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>${commercant.nom}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="carte menu-public">
    <h1>${commercant.nom}</h1>
    ${lignesProduits}
  </div>
</body>
</html>`;
}

function pageErreur(message, code) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Erreur</title>
  <link rel="stylesheet" href="/style.css"></head>
  <body><div class="carte"><h1>${code}</h1><p>${message}</p></div></body></html>`;
}

// ------------------------------------------------------------
// LE SERVEUR : qui répond à quelle adresse
// ------------------------------------------------------------
const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chemin = url.pathname;

  // --- Fichier CSS statique ---
  if (chemin === '/style.css') {
    const css = fs.readFileSync(path.join(__dirname, 'public', 'style.css'));
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(css);
  }

  // --- Page publique du menu : CE LIEN VA DANS LE QR CODE ---
  if (chemin.startsWith('/menu/') && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce commerçant n\'existe pas.', 404));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageMenuPublic(commercant));
  }

  // --- Formulaire de connexion ---
  if (chemin === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageLogin(null));
  }

  // --- Traitement de la connexion ---
  if (chemin === '/login' && req.method === 'POST') {
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug, motdepasse } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];

      if (!commercant || !verifierMotDePasse(motdepasse, commercant.sel, commercant.motDePasseHash)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageLogin('Identifiant ou mot de passe incorrect.'));
      }

      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = slug;
      res.writeHead(302, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/`,
        Location: '/dashboard',
      });
      return res.end();
    });
    return;
  }

  // --- Déconnexion ---
  if (chemin === '/logout') {
    const cookies = lireCookies(req);
    delete sessions[cookies.session];
    res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/login' });
    return res.end();
  }

  // --- Tableau de bord (protégé : il faut être connecté) ---
  if (chemin === '/dashboard' && req.method === 'GET') {
    const slug = slugDepuisRequete(req);
    if (!slug) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    const db = lireDB();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageDashboard(db.commercants[slug], slug));
  }

  // --- Modifier un produit existant ---
  if (chemin === '/dashboard/update' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { index, nom, prix } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits[Number(index)] = { nom, prix: Number(prix) };
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Supprimer un produit ---
  if (chemin === '/dashboard/delete' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { index } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits.splice(Number(index), 1);
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Ajouter un produit ---
  if (chemin === '/dashboard/add' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { nom, prix } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].produits.push({ nom, prix: Number(prix) });
      ecrireDB(db);
      res.writeHead(302, { Location: '/dashboard' });
      res.end();
    });
    return;
  }

  // --- Page d'accueil : redirige vers la connexion ---
  if (chemin === '/') {
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  // --- Rien trouvé ---
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageErreur('Page introuvable.', 404));
});

serveur.listen(PORT, () => {
  console.log(`Serveur démarré : http://localhost:${PORT}`);
  console.log(`Page de connexion : http://localhost:${PORT}/login`);
});

module.exports = { creerHachage }; // utilisé par creer-compte.js
