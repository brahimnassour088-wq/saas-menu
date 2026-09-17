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

const DB_PATH = path.join(__dirname, 'SAAS-db.json');
const PORT = process.env.PORT || 3000;

// Favicon KAVIO (SVG inline encodé en base64)
const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 251'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%232E9CFF'/%3E%3Cstop offset='50%25' stop-color='%235B5FEF'/%3E%3Cstop offset='100%25' stop-color='%238B2FE0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M20,20 L70,20 C78,20 82,30 76,36 L30,90 L20,90 Z' fill='url(%23g)'/%3E%3Cpath d='M30,110 L120,20 C126,14 136,14 142,20 C148,26 148,36 142,42 L60,125 L142,208 C148,214 148,224 142,230 C136,236 126,236 120,230 L30,140 Z' fill='url(%23g)'/%3E%3C/svg%3E">`;

// Écran de chargement KAVIO — logo qui respire + effet de brillance sur le texte,
// se cache automatiquement dès que la page a fini de charger (avec un minimum
// de 500ms d'affichage pour éviter un flash trop rapide).
const ECRAN_CHARGEMENT = `
<div class="kavio-loader" id="kavioLoader">
  <div class="kavio-loader-scene">
    <div class="kavio-loader-logo-zone">
      <svg viewBox="0 0 200 251" xmlns="http://www.w3.org/2000/svg" class="kavio-loader-svg" aria-hidden="true">
        <defs>
          <linearGradient id="kavioLoaderGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#2E9CFF"/>
            <stop offset="50%" stop-color="#5B5FEF"/>
            <stop offset="100%" stop-color="#8B2FE0"/>
          </linearGradient>
        </defs>
        <path d="M20,20 L70,20 C78,20 82,30 76,36 L30,90 L20,90 Z" fill="url(#kavioLoaderGrad)"/>
        <path d="M30,110 L120,20 C126,14 136,14 142,20 C148,26 148,36 142,42 L60,125 L142,208 C148,214 148,224 142,230 C136,236 126,236 120,230 L30,140 Z" fill="url(#kavioLoaderGrad)"/>
      </svg>
      <div class="kavio-loader-orbite kavio-orbite-1"></div>
      <div class="kavio-loader-orbite kavio-orbite-2"></div>
      <div class="kavio-loader-ombre"></div>
    </div>
  </div>
  <span class="kavio-loader-marque">KAVIO</span>
  <span class="kavio-loader-souligne"></span>
</div>
<script>
(function() {
  var debut = Date.now();
  var minAffichage = 500;
  function cacherLoader() {
    var loader = document.getElementById('kavioLoader');
    if (!loader) return;
    var ecoule = Date.now() - debut;
    var attente = Math.max(0, minAffichage - ecoule);
    setTimeout(function() {
      loader.classList.add('kavio-loader-cachee');
      setTimeout(function() { loader.remove(); }, 550);
    }, attente);
  }
  if (document.readyState === 'complete') {
    cacherLoader();
  } else {
    window.addEventListener('load', cacherLoader);
    // Filet de sécurité : si "load" met trop de temps (connexion lente),
    // on cache quand même le loader après 4s pour ne pas bloquer l'utilisateur.
    setTimeout(cacherLoader, 4000);
  }
})();
</script>`;

// Les "connexions actives" : qui a le droit d'entrer dans quel tiroir.
// Persistées dans la base de données (SAAS-db.json) pour survivre aux
// redémarrages du serveur (redéploiements) — avant, un simple redéploiement
// déconnectait tout le monde du jour au lendemain.
function persisterSessions() {
  const db = lireDB();
  db.sessions = sessions;
  db.sessionsAdmin = sessionsAdmin;
  ecrireDB(db);
}
function creerSessionsPersistantes(donneesInitiales) {
  const cible = Object.assign({}, donneesInitiales || {});
  return new Proxy(cible, {
    set(t, prop, val) { t[prop] = val; persisterSessions(); return true; },
    deleteProperty(t, prop) { delete t[prop]; persisterSessions(); return true; }
  });
}
const DB_INITIALE = (function() {
  try { return lireDB(); } catch (e) { return {}; }
})();
// Durée de vie des cookies de connexion (30 jours) — sans ça, le cookie
// expire dès que le navigateur "oublie" la session (fermeture de l'appli
// sur certains téléphones), et l'utilisateur doit se reconnecter à chaque fois.
const DUREE_COOKIE = 60 * 60 * 24 * 30;
const sessions = creerSessionsPersistantes(DB_INITIALE.sessions); // token -> slug du commerçant
const ADMIN_SEL = '0c3120e826330c9b79c090c353de1dd5';
const ADMIN_HASH = '74e544fb3d47e70bb3e6832f6e53ec054da0e3934e888090be2cd6075fd5afb83c2dc3c50f92c444041f7d120b2858b1bd2251f845870184fc9ffaccb7be767d';
const sessionsAdmin = creerSessionsPersistantes(DB_INITIALE.sessionsAdmin); // token -> true
const tentatives = {}; // adresse IP -> { nombre, depuis }
const avisEnvoyesAujourdhui = new Set(); // anti-spam simple : un avis par IP par commerçant par jour
const messagesChatAujourdhui = new Map(); // anti-abus : compteur de messages chat par IP par commerçant par jour
const messagesLeaCommercantAujourdhui = new Map(); // limite Léa dashboard : max 10 messages par commerçant par jour
const LIMITES_PLAN = { basique: 20, avance: 60 };
const MAX_TENTATIVES = 5;
const BLOCAGE_MS = 10 * 60 * 1000; // 10 minutes

function adresseIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'inconnu').split(',')[0].trim();
}

function estBloque(ip) {
  const t = tentatives[ip];
  if (!t) return false;
  if (Date.now() - t.depuis > BLOCAGE_MS) {
    delete tentatives[ip];
    return false;
  }
  return t.nombre >= MAX_TENTATIVES;
}

function enregistrerEchec(ip) {
  const t = tentatives[ip] || { nombre: 0, depuis: Date.now() };
  t.nombre += 1;
  if (t.nombre === 1) t.depuis = Date.now();
  tentatives[ip] = t;
}

function reinitialiserTentatives(ip) {
  delete tentatives[ip];
}

// ------------------------------------------------------------
// OUTILS : lire / écrire le "classeur" (la base de données JSON)
// ------------------------------------------------------------
function lireDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2), 'utf-8');
  }
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

// ------------------------------------------------------------
// OUTILS : thème de couleur personnalisé par commerçant
// ------------------------------------------------------------
function assombrirCouleur(hex, pourcentage) {
  const h = (hex || '#5B6EF5').replace('#', '');
  const r = Math.max(0, parseInt(h.substring(0, 2), 16) - Math.round(255 * pourcentage));
  const g = Math.max(0, parseInt(h.substring(2, 4), 16) - Math.round(255 * pourcentage));
  const b = Math.max(0, parseInt(h.substring(4, 6), 16) - Math.round(255 * pourcentage));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
function styleThemeCommercant(couleur) {
  const fonce = assombrirCouleur(couleur, 0.18);
  return `--ember-500:${couleur}; --ember-600:${fonce}; --amber-400:${couleur};`;
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

function adminConnecte(req) {
  const cookies = lireCookies(req);
  const token = cookies.sessionAdmin;
  return !!(token && sessionsAdmin[token]);
}

function pageAdminLogin(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin</title>${FAVICON}<link rel="stylesheet" href="/style.css"></head>
<body class="fond-braise admin-login-body">
  <canvas id="matrixFond" class="matrix-fond"></canvas>
  <main class="admin-terminal-wrap">
    <div class="admin-terminal admin-terminal-grand">
      <div class="admin-terminal-bar">
        <span class="admin-terminal-dot admin-dot-rouge"></span>
        <span class="admin-terminal-dot admin-dot-jaune"></span>
        <span class="admin-terminal-dot admin-dot-verte"></span>
        <span class="admin-terminal-titre">root@kavio: ~/admin</span>
      </div>
      <div class="admin-terminal-corps">
        <p class="admin-terminal-ligne">$ whoami</p>
        <p class="admin-terminal-ligne admin-terminal-reponse">propriétaire_kavio</p>
        <p class="admin-terminal-ligne">$ authentification --requise</p>
        ${erreur ? `<p class="admin-terminal-erreur">✗ ${erreur}</p>` : ''}
        <form method="POST" action="/admin" class="admin-terminal-form">
          <label class="admin-terminal-ligne admin-terminal-label">
            mot_de_passe:
            <input type="password" name="motdepasse" required autocomplete="current-password" class="admin-terminal-input" autofocus>
            <span class="admin-terminal-curseur">▌</span>
          </label>
          <button type="submit" class="admin-terminal-btn">[ ENTRÉE ]</button>
        </form>
      </div>
    </div>
  </main>
  <script>
    (function() {
      const reduitMouvement = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const canvas = document.getElementById('matrixFond');
      if (reduitMouvement || !canvas) return;
      const ctx = canvas.getContext('2d');
      let largeur, hauteur, colonnes, gouttes;
      function dimensionner() {
        largeur = canvas.width = window.innerWidth;
        hauteur = canvas.height = window.innerHeight;
        colonnes = Math.floor(largeur / 18);
        gouttes = new Array(colonnes).fill(1);
      }
      dimensionner();
      window.addEventListener('resize', dimensionner);
      function dessiner() {
        ctx.fillStyle = 'rgba(10,14,23,0.12)';
        ctx.fillRect(0, 0, largeur, hauteur);
        ctx.font = '16px monospace';
        for (let i = 0; i < gouttes.length; i++) {
          const car = Math.random() > 0.5 ? '1' : '0';
          const degrade = ctx.createLinearGradient(0, 0, 0, hauteur);
          ctx.fillStyle = Math.random() > 0.97 ? '#9B6BFF' : 'rgba(91,110,245,0.7)';
          ctx.fillText(car, i * 18, gouttes[i] * 18);
          if (gouttes[i] * 18 > hauteur && Math.random() > 0.975) gouttes[i] = 0;
          gouttes[i]++;
        }
      }
      setInterval(dessiner, 45);
    })();
  </script>
</body>
</html>`;
}

function pageAdmin(db, nouvellesDepuisDerniereVisite) {
  const lignes = Object.entries(db.commercants).map(([slug, c]) => {
    const suspendu = c.suspendu === true;
    const messageRappel = encodeURIComponent(`Bonjour ${c.nom}, petit rappel : il reste 2 à 3 jours avant l'échéance de votre abonnement mensuel. Merci de faire le nécessaire pour continuer à profiter du service.`);
    const numero = (c.telephonePaiement || '').replace(/[^0-9]/g, '');
    const derniereConnexion = c.derniereConnexion
      ? new Date(c.derniereConnexion).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
      : 'Jamais connecté';
    return `
    <div class="admin-ligne ${suspendu ? 'admin-ligne-suspendue' : ''}">
      <div>
        <strong>${c.nom}</strong>
        <span class="admin-slug">/menu/${slug}</span>
        ${suspendu ? '<span class="admin-tag-suspendu">Suspendu</span>' : ''}
        <div class="admin-derniere-connexion">Dernière connexion : ${derniereConnexion}</div>
      </div>
      <div class="admin-actions">
        ${numero ? `<a href="https://wa.me/${numero}?text=${messageRappel}" target="_blank" class="btn-mini">Rappel WhatsApp</a>` : ''}
        <form method="POST" action="/admin/suspendre" style="display:inline;">
          <input type="hidden" name="slug" value="${slug}">
          <button type="submit" class="btn-mini ${suspendu ? 'btn-mini-save' : 'btn-mini-delete'}">${suspendu ? 'Réactiver' : 'Suspendre'}</button>
        </form>
        <form method="POST" action="/admin/plan" style="display:inline;">
          <input type="hidden" name="slug" value="${slug}">
          <button type="submit" class="btn-mini">Plan : ${c.plan === 'avance' ? 'Avancé (5000F)' : 'Basique (2500F)'} — changer</button>
        </form>
        <form method="POST" action="/admin/ia" style="display:inline;">
          <input type="hidden" name="slug" value="${slug}">
          <button type="submit" class="btn-mini ${c.iaActivee ? 'btn-mini-save' : ''}">IA : ${c.iaActivee ? 'Activée ✓' : 'Désactivée'} — changer</button>
        </form>
        <form method="POST" action="/admin/supprimer" style="display:inline;" onsubmit="return confirm('Supprimer définitivement ${c.nom.replace(/'/g, "\\'")} ? Cette action est irréversible.');">
          <input type="hidden" name="slug" value="${slug}">
          <button type="submit" class="btn-mini btn-mini-delete">Supprimer</button>
        </form>
        ${c.email ? `<form method="POST" action="/admin/bannir-email" style="display:inline;" onsubmit="return confirm('Empêcher ${c.email} de recréer un compte ?');">
          <input type="hidden" name="email" value="${c.email}">
          <button type="submit" class="btn-mini btn-mini-delete">Bannir cet email</button>
        </form>` : ''}
      </div>
    </div>`;
  }).join('') || '<p style="color:var(--smoke-500);">Aucun commerçant inscrit pour l\'instant.</p>';

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Espace propriétaire</title>${FAVICON}<link rel="stylesheet" href="/style.css"></head>
<body class="fond-braise">
  <main class="dash-page">
    <header class="dash-head">
      <div><span class="eyebrow">Espace propriétaire</span><h1>Tes commerçants</h1></div>
      <div style="display:flex; gap:12px; align-items:center;">
        <a href="/admin/sauvegarde" class="lien-discret" download>💾 Sauvegarder la base</a>
        <a href="/admin/logout" class="lien-discret">Se déconnecter</a>
      </div>
    </header>
    ${nouvellesDepuisDerniereVisite > 0 ? `<p class="admin-badge-nouveau">🎉 ${nouvellesDepuisDerniereVisite} nouvelle${nouvellesDepuisDerniereVisite > 1 ? 's' : ''} inscription${nouvellesDepuisDerniereVisite > 1 ? 's' : ''} depuis ta dernière visite</p>` : ''}
    <div class="admin-liste">${lignes}</div>

    <section class="admin-terminal admin-terminal-grand admin-lea-bloc">
      <div class="admin-terminal-bar">
        <span class="admin-terminal-dot admin-dot-rouge"></span>
        <span class="admin-terminal-dot admin-dot-jaune"></span>
        <span class="admin-terminal-dot admin-dot-verte"></span>
        <span class="admin-terminal-titre">léa@kavio: ~/admin</span>
      </div>
      <div class="admin-terminal-corps">
        <p class="admin-terminal-ligne">$ léa --assistante-admin</p>
        <p class="admin-terminal-ligne admin-terminal-reponse">Demande-moi qui s'est connecté, quel commerçant a quel plan, etc.</p>
        <div class="chat-messages admin-lea-messages" id="leaMessages"></div>
        <form class="chat-form" id="leaForm">
          <input type="text" id="leaInput" class="admin-terminal-input admin-lea-input" placeholder="Pose ta question à Léa…" autocomplete="off" required>
          <button type="button" class="admin-terminal-btn admin-lea-mic" id="leaMic" aria-label="Parler">🎤</button>
          <button type="button" class="admin-terminal-btn admin-lea-stop" id="leaStop" aria-label="Arrêter la voix" hidden>⏹</button>
          <button type="submit" class="admin-terminal-btn admin-lea-btn">Envoyer</button>
        </form>
      </div>
    </section>
  </main>
  <script>
    (function() {
      const form = document.getElementById('leaForm');
      const input = document.getElementById('leaInput');
      const messages = document.getElementById('leaMessages');
      const bouttonMic = document.getElementById('leaMic');
      const bouttonStop = document.getElementById('leaStop');
      let historique = [];
      function ajouter(texte, classe) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + classe;
        const bulle = document.createElement('span');
        bulle.className = 'chat-msg-texte';
        bulle.textContent = texte;
        div.appendChild(bulle);
        if (classe.indexOf('ia') !== -1 || classe.indexOf('bot') !== -1) {
          const btnCopier = document.createElement('button');
          btnCopier.type = 'button';
          btnCopier.className = 'chat-msg-copier';
          btnCopier.textContent = '📋';
          btnCopier.setAttribute('aria-label', 'Copier');
          btnCopier.addEventListener('click', () => {
            navigator.clipboard.writeText(texte).then(() => {
              btnCopier.textContent = '✓';
              setTimeout(() => { btnCopier.textContent = '📋'; }, 1500);
            });
          });
          div.appendChild(btnCopier);
        }
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }
      function parlerReponse(texte) {
        if (!('speechSynthesis' in window)) return;
        const u = new SpeechSynthesisUtterance(texte);
        u.lang = 'fr-FR';
        window.speechSynthesis.cancel();
        if (bouttonStop) {
          bouttonStop.hidden = false;
          u.addEventListener('end', () => { bouttonStop.hidden = true; });
          u.addEventListener('error', () => { bouttonStop.hidden = true; });
        }
        window.speechSynthesis.speak(u);
      }
      if (bouttonStop) {
        bouttonStop.addEventListener('click', () => {
          window.speechSynthesis.cancel();
          bouttonStop.hidden = true;
        });
      }
      const ReconnaissanceVocale = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (ReconnaissanceVocale && bouttonMic) {
        const reco = new ReconnaissanceVocale();
        reco.lang = 'fr-FR';
        reco.interimResults = false;
        let enEcoute = false;
        bouttonMic.addEventListener('click', () => {
          if (enEcoute) { reco.stop(); return; }
          reco.start();
        });
        reco.addEventListener('start', () => { enEcoute = true; bouttonMic.classList.add('admin-lea-mic-actif'); bouttonMic.textContent = '●'; });
        reco.addEventListener('end', () => { enEcoute = false; bouttonMic.classList.remove('admin-lea-mic-actif'); bouttonMic.textContent = '🎤'; });
        reco.addEventListener('result', (e) => {
          input.value = e.results[0][0].transcript;
          form.requestSubmit();
        });
      } else if (bouttonMic) {
        bouttonMic.style.display = 'none';
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const texte = input.value.trim();
        if (!texte) return;
        ajouter(texte, 'chat-msg-client');
        historique.push({ role: 'user', content: texte });
        input.value = '';
        input.disabled = true;
        const attente = document.createElement('div');
        attente.className = 'chat-msg chat-msg-ia chat-msg-attente';
        attente.textContent = '…';
        messages.appendChild(attente);
        try {
          const reponse = await fetch('/admin/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ historique: historique.slice(-14) })
          });
          const data = await reponse.json();
          attente.remove();
          if (data.reponse) {
            ajouter(data.reponse, 'chat-msg-ia');
            historique.push({ role: 'assistant', content: data.reponse });
            parlerReponse(data.reponse);
          } else {
            ajouter(data.erreur || 'Erreur', 'chat-msg-ia');
          }
        } catch (err) {
          attente.remove();
          ajouter('Connexion impossible.', 'chat-msg-ia');
        }
        input.disabled = false;
        input.focus();
      });
    })();
  </script>
</body>
</html>`;
}

// ------------------------------------------------------------
// PAGES HTML (le "code devant", ici sous forme de gabarits simples)
// ------------------------------------------------------------
function pageAccueil(hote) {
  const lienDemo = `https://${hote}/menu/restaurant-le-sahel`;
  const qrDemo = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(lienDemo)}`;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KAVIO — Votre commerce. Votre image.</title>
${FAVICON}<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise fond-accueil">
  ${ECRAN_CHARGEMENT}
  <main class="accueil">
    <header class="accueil-nav">
      <span class="accueil-marque">
        <svg width="28" height="35" viewBox="0 0 200 251" xmlns="http://www.w3.org/2000/svg" class="logo-kavio" aria-hidden="true">
          <defs>
            <linearGradient id="kavioGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#2E9CFF"/>
              <stop offset="50%" stop-color="#5B5FEF"/>
              <stop offset="100%" stop-color="#8B2FE0"/>
            </linearGradient>
          </defs>
          <path d="M20,20 L70,20 C78,20 82,30 76,36 L30,90 L20,90 Z" fill="url(#kavioGrad)"/>
          <path d="M30,110 L120,20 C126,14 136,14 142,20 C148,26 148,36 142,42 L60,125 L142,208 C148,214 148,224 142,230 C136,236 126,236 120,230 L30,140 Z" fill="url(#kavioGrad)"/>
        </svg>
        KAVI<span class="point-ember">O</span>
      </span>
      <a href="/login" class="lien-discret accueil-nav-connexion">Se connecter →</a>
    </header>

    <section class="accueil-hero">
      <div class="accueil-texte">
        <span class="eyebrow">Votre commerce. Votre image.</span>
        <h1 class="accueil-titre">Votre carte,<br><em>un code à scanner.</em></h1>
        <p class="accueil-sous-titre">
          Fini les menus à réimprimer. Créez votre catalogue en ligne, obtenez votre QR code,
          et changez vos prix en direct — depuis votre téléphone.
        </p>
        <div class="accueil-cta">
          <a href="/signup" class="btn-primary">Créer mon menu</a>
          <a href="/login" class="lien-discret accueil-cta-secondaire">J'ai déjà un compte</a>
        </div>
        <p class="accueil-preuve">🍽️ <strong>Restaurant Le Sahel</strong> utilise déjà KAVIO pour son menu</p>
        <a href="${lienDemo}" target="_blank" class="accueil-demo-lien">Voir leur menu en ligne →</a>
      </div>

      <div class="accueil-ticket" aria-hidden="true">
        <div class="ticket-tete">
          <span class="ticket-eyebrow">Aperçu</span>
          <span class="ticket-nom">Chez Vous</span>
        </div>
        <div class="ticket-rule"></div>
        <ul class="ticket-liste">
          <li><span>Article du jour</span><i></i><b>1500 F</b></li>
          <li><span>Jus de bissap</span><i></i><b>500 F</b></li>
          <li><span>Brochette</span><i></i><b>1000 F</b></li>
        </ul>
        <div class="ticket-qr" aria-hidden="true">
          <div class="qr-faux">
            ${Array.from({length: 49}).map(() => `<span class="${Math.random() > 0.55 ? 'plein' : ''}"></span>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="accueil-scan">
      <div class="accueil-scan-texte">
        <span class="eyebrow">Testez maintenant</span>
        <h2>Scannez, vous y êtes.</h2>
        <p>Ce QR code mène vers un vrai menu en ligne, hébergé sur ce SaaS. Scannez-le avec l'appareil photo de votre téléphone.</p>
      </div>
      <img src="${qrDemo}" alt="QR code de démonstration" width="180" height="180" class="accueil-scan-qr">
    </section>

    <section class="accueil-etapes">
      <span class="eyebrow" style="display:block; text-align:center; margin-bottom:22px;">Comment ça marche</span>
      <div class="etapes-grille">
        <div class="etape"><span class="etape-num">1</span><h3>Crée ton compte</h3><p>Nom du commerce, mot de passe. Deux minutes, gratuit pour commencer.</p></div>
        <div class="etape"><span class="etape-num">2</span><h3>Ajoute tes produits</h3><p>Photos, prix, descriptions. Depuis ton téléphone, sans ordinateur.</p></div>
        <div class="etape"><span class="etape-num">3</span><h3>Partage ton QR code</h3><p>Tes clients scannent et voient ton catalogue à jour, instantanément.</p></div>
      </div>
    </section>

    <section class="accueil-temoignages">
      <span class="eyebrow" style="display:block; text-align:center; margin-bottom:22px;">Ils nous font confiance</span>
      <div class="temoignages-grille">
        <div class="temoignage-carte">
          <div class="temoignage-etoiles">★★★★★</div>
          <p class="temoignage-texte">"Avant j'imprimais des menus chaque semaine. Maintenant je change mes prix en 30 secondes depuis mon téléphone. Mes clients adorent scanner le code."</p>
          <span class="temoignage-auteur">— Hamid, Restaurant Le Sahel, N'Djamena</span>
        </div>
        <div class="temoignage-carte">
          <div class="temoignage-etoiles">★★★★★</div>
          <p class="temoignage-texte">"Super facile à utiliser. J'ai mis mes produits en 10 minutes et mes clientes peuvent voir les prix avant de venir. Ça m'évite des appels pour rien."</p>
          <span class="temoignage-auteur">— Mariama, Salon de beauté, N'Djamena</span>
        </div>
        <div class="temoignage-carte">
          <div class="temoignage-etoiles">★★★★☆</div>
          <p class="temoignage-texte">"Je mets le QR code à l'entrée de ma boutique. Les clients voient mes nouveautés avant même d'entrer. C'est moderne et ça fait sérieux."</p>
          <span class="temoignage-auteur">— Aïcha, Boutique prêt-à-porter, N'Djamena</span>
        </div>
      </div>
    </section>

    <section class="accueil-tarifs">
      <span class="eyebrow" style="display:block; text-align:center; margin-bottom:22px;">Tarifs</span>
      <div class="tarifs-grille">
        <div class="tarif-carte">
          <h3>Basique</h3>
          <p class="tarif-prix">2 500 F<span>/mois</span></p>
          <p>Menu en ligne, QR code, jusqu'à 20 produits.</p>
          <a class="btn-primary tarif-btn" href="https://wa.me/23565008485?text=${encodeURIComponent("Bonjour, je veux l'offre Basique (2500F/mois) sur KAVIO.")}" target="_blank">Choisir Basique</a>
        </div>
        <div class="tarif-carte tarif-carte-vedette">
          <span class="tarif-badge">Populaire</span>
          <h3>Avancé</h3>
          <p class="tarif-prix">5 000 F<span>/mois</span></p>
          <p>Jusqu'à 60 produits, photos, catégories, statistiques.</p>
          <a class="btn-primary tarif-btn" href="https://wa.me/23565008485?text=${encodeURIComponent("Bonjour, je veux l'offre Avancé (5000F/mois) sur KAVIO.")}" target="_blank">Choisir Avancé</a>
        </div>
      </div>
    </section>
      </div>
    </section>

    <section class="accueil-features">
      <div class="feature-card">
        <span class="eyebrow">Sur place ou en ligne</span>
        <h2>Un QR code, pas un catalogue papier</h2>
        <p>Le client scanne, voit votre catalogue à jour, sans app à installer.</p>
      </div>
      <div class="feature-card">
        <span class="eyebrow">Depuis votre téléphone</span>
        <h2>Vos prix changent en direct</h2>
        <p>Modifiez un article, un prix, une rupture de stock — visible tout de suite.</p>
      </div>
      <div class="feature-card">
        <span class="eyebrow">Sans engagement</span>
        <h2>Créez votre compte en 2 minutes</h2>
        <p>Aucune carte bancaire, aucun rendez-vous. Juste un nom et un mot de passe.</p>
      </div>
    </section>

    <footer class="accueil-pied">
      <a href="/signup" class="btn-primary">Créer mon catalogue maintenant</a>
    </footer>
  </main>
</body>
</html>`;
}

function pageLogin(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KAVIO — Connexion commerçant</title>
${FAVICON}<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="auth-page">
    <div class="auth-card">
      <span class="eyebrow">Espace commerçant</span>
      <h1>Connexion</h1>
      ${erreur ? `<p class="form-error">${erreur}</p>` : ''}
      <form method="POST" action="/login" class="stack">
        <label>Identifiant
          <input name="slug" required autocomplete="username">
        </label>
        <label>Mot de passe
          <input type="password" name="motdepasse" required autocomplete="current-password">
        </label>
        <button type="submit" class="btn-primary">Se connecter</button>
      </form>
      <p class="lien-discret" style="margin-top:16px; text-align:center;">
        Pas encore de compte ? <a href="/signup" style="color:inherit; text-decoration:underline;">Créer un compte</a>
      </p>
    </div>
  </main>
</body>
</html>`;

}

function pageSignup(erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KAVIO — Créer un compte commerçant</title>
${FAVICON}<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  <main class="auth-page">
    <div class="auth-card">
      <span class="eyebrow">Espace commerçant</span>
      <h1>Créer un compte</h1>
      ${erreur ? `<p class="form-error">${erreur}</p>` : ''}
      <form method="POST" action="/signup" class="stack">
        <label>Nom du commerce
          <input name="nom" required placeholder="Ex: Chez Fatimé">
        </label>
        <label>Type d'activité
          <select name="typeActivite">
            <option value="restaurant">Restaurant / Maquis / Snack</option>
            <option value="coiffure">Coiffure / Beauté</option>
            <option value="hotel">Hôtel</option>
            <option value="boutique">Boutique</option>
            <option value="autre">Autre</option>
          </select>
        </label>
        <label>Numéro Mobile Money (optionnel)
          <input name="telephonePaiement" placeholder="Ex: 65 00 84 85">
        </label>
        <label>Adresse Gmail (optionnel)
          <input type="email" name="email" placeholder="Ex: moncommerce@gmail.com">
        </label>
        <label>Mot de passe
          <input type="password" name="motdepasse" required autocomplete="new-password" minlength="6">
        </label>
        <button type="submit" class="btn-primary">Créer mon compte</button>
      </form>
      <p class="lien-discret" style="margin-top:16px; text-align:center;">
        Déjà un compte ? <a href="/login" style="color:inherit; text-decoration:underline;">Se connecter</a>
      </p>
    </div>
  </main>
</body>
</html>`;
}

// Petit graphique en barres CSS (7 derniers jours) — pas besoin de librairie externe
function graphiqueVues7Jours(vuesParJour, t) {
  const jours = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const cle = d.toISOString().slice(0, 10);
    jours.push({ label: d.toLocaleDateString('fr-FR', { weekday: 'short' }), valeur: vuesParJour[cle] || 0 });
  }
  const max = Math.max(1, ...jours.map(j => j.valeur));
  const barres = jours.map(j => `
    <div style="display:flex; flex-direction:column; align-items:center; gap:6px; flex:1;">
      <span style="font-size:0.75rem; opacity:0.75;">${j.valeur}</span>
      <div style="width:100%; max-width:28px; height:70px; display:flex; align-items:flex-end; background:rgba(255,255,255,0.06); border-radius:6px; overflow:hidden;">
        <div style="width:100%; height:${Math.max(4, Math.round((j.valeur / max) * 70))}px; background:linear-gradient(180deg, var(--ember-500), var(--ember-600)); border-radius:6px;"></div>
      </div>
      <span style="font-size:0.7rem; opacity:0.6; text-transform:capitalize;">${j.label}</span>
    </div>`).join('');
  return `
    <div style="margin-top:18px;">
      <p style="margin:0 0 10px; font-size:0.85rem; opacity:0.75;">${t.graphique7Jours || '7 derniers jours'}</p>
      <div style="display:flex; gap:8px; align-items:flex-end;">${barres}</div>
    </div>`;
}

function pageDashboard(commercant, slug, hote, langue, messageMotDePasse, limiteAtteinte) {
  const t = TRAD_DASH[langue] || TRAD_DASH.fr;
  const direction = langue === 'ar' ? 'rtl' : 'ltr';
  const mot = motProduit(commercant.typeActivite, langue);
  const motMaj = mot.charAt(0).toUpperCase() + mot.slice(1);
  const indexActuel = ORDRE_LANGUES.indexOf(langue) === -1 ? 0 : ORDRE_LANGUES.indexOf(langue);
  const autreLangue = ORDRE_LANGUES[(indexActuel + 1) % ORDRE_LANGUES.length];
  const limitePlan = LIMITES_PLAN[commercant.plan || 'basique'] || LIMITES_PLAN.basique;
  const compteurProduits = commercant.produits.length;

  const paiements = commercant.paiements || [];
  const totalPaiements = paiements.reduce((s, p) => s + Number(p.montant || 0), 0);
  const listePaiements = paiements.length
    ? `<ul class="liste-paiements">${paiements.slice(-10).reverse().map(p => `
        <li>
          <strong>${Number(p.montant).toLocaleString('fr-FR')} F</strong>
          ${p.note ? `— ${p.note}` : ''}
          <span style="opacity:0.6; font-size:0.82rem;">· ${new Date(p.date).toLocaleDateString('fr-FR')}</span>
        </li>`).join('')}</ul>`
    : `<p style="opacity:0.7;">${t.aucunPaiement}</p>`;

  const fidelite = commercant.fidelite || {};
  const clientsFideles = Object.entries(fidelite).sort((a, b) => b[1].points - a[1].points);
  const listeFidelite = clientsFideles.length
    ? `<ul class="liste-paiements">${clientsFideles.slice(0, 15).map(([numero, c]) => `
        <li>
          <strong>${c.nom || numero}</strong> ${c.nom ? `<span style="opacity:0.6; font-size:0.82rem;">· ${numero}</span>` : ''}
          — ${c.points} ${t.fidelitePoints}
          ${c.points >= 10 ? `<span class="badge-rupture" style="background:#2e7d32;">${t.fideliteRecompense}</span>` : ''}
        </li>`).join('')}</ul>`
    : `<p style="opacity:0.7;">${t.aucunFidele}</p>`;

  const lienMenu = `https://${hote}/menu/${slug}`;
  const couleurQr = (commercant.couleurTheme || '#5B6EF5').replace('#', '');
  const urlQrCode = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&color=${couleurQr}&data=${encodeURIComponent(lienMenu)}`;
  const lignesProduits = commercant.produits.map((p, i) => {
    const stockSuivi = p.stock !== null && p.stock !== undefined && p.stock !== '';
    const enRupture = stockSuivi && Number(p.stock) <= 0;
    return `
    <form method="POST" action="/dashboard/update?lang=${langue}" class="ligne-produit ${p.disponible === false || enRupture ? 'produit-epuise' : ''}">
      <input type="hidden" name="index" value="${i}">
      ${p.photo ? `<img src="${p.photo}" alt="" class="photo-apercu">` : ''}
      <input name="nom" id="nom-${i}" value="${p.nom}" required class="champ-nom">
      ${p.clicsCommande ? `<span class="badge-clics" title="${t.clicsCommandeTitre}">📩 ${p.clicsCommande}</span>` : ''}
      <div class="champ-prix">
        <input name="prix" type="number" value="${p.prix}" required>
        <span>F</span>
      </div>
      <div class="champ-prix" title="${t.prixPromoLabel}">
        <input name="prixPromo" type="number" value="${p.prixPromo || ''}" placeholder="${t.prixPromoLabel}">
        <span>🏷️</span>
      </div>
      <input name="categorie" id="cat-${i}" value="${p.categorie || ''}" placeholder="${t.categorieOpt}" class="champ-photo">
      <div class="champ-photo-groupe">
        <input name="photo" id="photo-${i}" value="${p.photo || ''}" placeholder="${t.photoOpt}" class="champ-photo">
        <input type="file" accept="image/*" class="input-photo-fichier" data-cible="photo-${i}" id="fichier-${i}" hidden>
        <button type="button" class="btn-mini btn-photo-galerie" data-cible="fichier-${i}">📷</button>
      </div>
      <input name="stock" type="number" min="0" value="${stockSuivi ? p.stock : ''}" placeholder="${t.stockLabel}" class="champ-photo" title="${t.stockLabel}">
      ${enRupture ? `<span class="badge-rupture">${t.stockRupture}</span>` : ''}
      ${commercant.iaActivee ? `
      <div class="champ-ia-groupe">
        <textarea name="description" id="desc-${i}" placeholder="${t.descriptionOpt}" rows="2">${p.description || ''}</textarea>
        <button type="button" class="btn-mini btn-ia" onclick="genererDescriptionIA('${i}')">${t.genererIA}</button>
      </div>` : `
      <textarea name="description" placeholder="${t.descriptionOpt}" rows="2">${p.description || ''}</textarea>`}
      <label class="case-disponible champ-horaire">${t.disponibleDe}
        <input type="time" name="heureDebut" value="${p.heureDebut || ''}">
        ${t.horaireA}
        <input type="time" name="heureFin" value="${p.heureFin || ''}">
      </label>
      <label class="case-disponible">
        <input type="checkbox" name="disponible" ${p.disponible === false ? '' : 'checked'}>
        ${t.enStock}
      </label>
      <div class="ligne-actions">
        <button type="submit" class="btn-mini btn-mini-save">${t.enregistrer}</button>
        <button type="submit" formaction="/dashboard/delete?lang=${langue}" class="btn-mini btn-mini-delete">${t.supprimer}</button>
      </div>
      ${p.historiquePrix && p.historiquePrix.length ? `
      <details class="historique-prix">
        <summary>${t.historiquePrixTitre} (${p.historiquePrix.length})</summary>
        <ul>
          ${[...p.historiquePrix].reverse().map(h => `<li>${new Date(h.date).toLocaleDateString('fr-FR')} : ${h.ancienPrix} F → ${h.nouveauPrix} F</li>`).join('')}
        </ul>
      </details>` : ''}
    </form>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="${langue}" dir="${direction}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t.tableauDeBord} — ${commercant.nom}</title>
${FAVICON}<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise">
  ${ECRAN_CHARGEMENT}
  <main class="dash-page">
    <header class="dash-head">
      <div>
        <span class="eyebrow">${t.tableauDeBord}</span>
        <h1>${commercant.nom}</h1>
      </div>
      <div class="dash-head-droite">
        <a class="lang-switch lang-switch-dash" href="/dashboard?lang=${autreLangue}" title="${NOMS_LANGUES[autreLangue]}">🌐 ${NOMS_LANGUES[langue] || 'FR'}</a>
        <a href="/logout" class="lien-discret">${t.deconnexion}</a>
      </div>
    </header>

    <a class="chip-lien" href="/menu/${slug}" target="_blank">
      <span>${t.pagePublique}</span>
      <strong>/menu/${slug}</strong>
    </a>
    <button type="button" class="btn-copier-lien" onclick="navigator.clipboard.writeText('${lienMenu}').then(()=>{this.textContent='✓ Copié !'; setTimeout(()=>this.textContent='📋 Copier mon lien menu',2000)})">📋 Copier mon lien menu</button>

    <section class="dash-section">
      <h2>${t.statistiques}</h2>
      <p>${t.statsDesc}</p>
      <div class="bloc-qrcode" style="text-align:left;">
        <p style="font-size:2.2rem; font-weight:bold; margin:0;">${commercant.vues || 0}</p>
        <p style="margin:4px 0 0; opacity:0.8;">${(commercant.vues || 0) > 1 ? t.vues : t.vue} ${t.auTotal}</p>
      </div>
      ${graphiqueVues7Jours(commercant.vuesParJour || {}, t)}
    </section>

    <section class="dash-section">
      <h2>${t.tonQr}</h2>
      <p>${t.tonQrDesc}</p>
      <div class="bloc-qrcode">
        <img src="${urlQrCode}" alt="QR code du menu de ${commercant.nom}" width="220" height="220">
        <div style="display:flex; gap:10px; margin-top:12px; flex-wrap:wrap;">
          <a href="/dashboard/qrcode-telecharger?slug=${slug}&lang=${langue}" class="btn-primary" style="display:inline-block;">${t.telecharger}</a>
          <a href="/menu/${slug}/qrcode-imprimer?lang=${langue}" target="_blank" class="btn-primary" style="display:inline-block; background:var(--charcoal-700);">🖨️ ${t.qrImprimer}</a>
        </div>
      </div>
    </section>

    <section class="dash-section">
      <h2>${t.qrTable}</h2>
      <p>${t.qrTableDesc}</p>
      <form method="GET" action="/dashboard/qr-table" class="stack">
        <label>${t.nomTable}
          <input name="nom" required placeholder="Table 1">
        </label>
        <button type="submit" class="btn-primary">${t.generer}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${motMaj}s</h2>
      <div class="liste-produits">
        ${lignesProduits}
      </div>
    </section>

    <section class="dash-section">
      <h2>${t.ajouter} — ${mot}</h2>
      <p class="compteur-plan">${compteurProduits} / ${limitePlan} ${mot}${compteurProduits > 1 ? 's' : ''} (plan ${commercant.plan === 'avance' ? 'Avancé' : 'Basique'})</p>
      ${limiteAtteinte ? `<p class="form-error">Limite atteinte pour ton plan actuel. Passe au plan Avancé pour ajouter plus.</p>` : ''}
      <form method="POST" action="/dashboard/add?lang=${langue}" class="form-ajout" id="formAjout">
        <input name="nom" id="ajoutNom" placeholder="${motMaj}" required>
        <input name="prix" type="number" placeholder="${t.prixLabel}" required>
        <input name="categorie" id="ajoutCategorie" placeholder="${t.categorieOpt}">
        <div class="champ-photo-groupe">
          <input name="photo" id="ajoutPhoto" placeholder="${t.photoOpt}">
          <input type="file" accept="image/*" class="input-photo-fichier" data-cible="ajoutPhoto" id="ajoutFichier" hidden>
          <button type="button" class="btn-mini btn-photo-galerie" data-cible="ajoutFichier">📷</button>
        </div>
        <input name="stock" type="number" min="0" placeholder="${t.stockLabel}">
        ${commercant.iaActivee ? `
        <div class="champ-ia-groupe">
          <textarea name="description" id="ajoutDescription" placeholder="${t.descriptionOpt}" rows="2"></textarea>
          <button type="button" class="btn-mini btn-ia" onclick="genererDescriptionIA('ajout')">${t.genererIA}</button>
        </div>` : `
        <textarea name="description" placeholder="${t.descriptionOpt}" rows="2"></textarea>`}
        <label class="case-disponible champ-horaire">${t.disponibleDe}
          <input type="time" name="heureDebut">
          ${t.horaireA}
          <input type="time" name="heureFin">
        </label>
        <button type="submit" class="btn-primary">${t.ajouter}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${t.numeroMobile}</h2>
      <p>${t.numeroMobileDesc}</p>
      <form method="POST" action="/dashboard/telephone?lang=${langue}" class="stack">
        <label>${t.numero}
          <input name="telephonePaiement" value="${commercant.telephonePaiement || ''}" placeholder="Ex: 65 00 84 85">
        </label>
        <button type="submit" class="btn-primary">${t.enregistrer}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${t.themeTitre}</h2>
      <p>${t.themeDesc}</p>
      <form method="POST" action="/dashboard/theme?lang=${langue}" class="stack" style="flex-direction:row; align-items:center; gap:12px; flex-wrap:wrap;">
        <input type="color" name="couleur" value="${commercant.couleurTheme || '#5B6EF5'}" style="width:56px; height:44px; border:none; border-radius:10px; background:none; cursor:pointer; padding:0;">
        <button type="submit" class="btn-primary" style="margin:0;">${t.enregistrer}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${t.domaineTitre}</h2>
      <p>${t.domaineDesc}</p>
      <form method="POST" action="/dashboard/domaine?lang=${langue}" class="stack">
        <label>${t.domaineLabel}
          <input name="domaine" value="${commercant.domainePersonnalise || ''}" placeholder="Ex: menu.tonentreprise.td">
        </label>
        <button type="submit" class="btn-primary">${t.enregistrer}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${t.aProposTitre}</h2>
      <p>${t.aProposDesc}</p>
      <form method="POST" action="/dashboard/apropos?lang=${langue}" class="stack">
        <label>${t.photoProfilLabel}</label>
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
          ${commercant.photoProfil ? `<img src="${commercant.photoProfil}" alt="" style="width:56px; height:56px; border-radius:50%; object-fit:cover;">` : ''}
          <input type="hidden" name="photoProfil" id="photoProfilChamp" value="${commercant.photoProfil || ''}">
          <input type="file" accept="image/*" class="input-photo-fichier" data-cible="photoProfilChamp" data-forme="rond" id="photoProfilFichier" hidden>
          <button type="button" class="btn-mini btn-photo-galerie" data-cible="photoProfilFichier">📷 ${t.choisirPhoto}</button>
        </div>
        <label>${t.adresseLabel}
          <input name="adresse" value="${commercant.adresse || ''}" placeholder="Ex: En face de Hec-Tchad, N'Djaména">
        </label>
        <label>${t.horairesLabel}
          <input name="horaires" value="${commercant.horaires || ''}" placeholder="Ex: Lun-Sam 8h-19h">
        </label>
        <label>Instagram
          <input name="instagram" value="${commercant.instagram || ''}" placeholder="Ex: @tonentreprise">
        </label>
        <label>Facebook
          <input name="facebook" value="${commercant.facebook || ''}" placeholder="Ex: facebook.com/tonentreprise">
        </label>
        <button type="submit" class="btn-primary">${t.enregistrer}</button>
      </form>
    </section>

    <section class="dash-section">
      <h2>${t.paiementsTitre}</h2>
      <p>${t.paiementsDesc}</p>
      <p style="font-size:1.6rem; font-weight:bold; margin:6px 0 14px;">${totalPaiements.toLocaleString('fr-FR')} F <span style="font-size:0.9rem; font-weight:normal; opacity:0.75;">${t.totalRecu}</span></p>
      <form method="POST" action="/dashboard/paiement?lang=${langue}" class="stack">
        <label>${t.montantLabel}
          <input name="montant" type="number" min="1" required>
        </label>
        <label>${t.noteLabel}
          <input name="note" placeholder="${t.noteLabelPlaceholder}">
        </label>
        <button type="submit" class="btn-primary">${t.ajouterPaiement}</button>
      </form>
      ${listePaiements}
    </section>

    <section class="dash-section">
      <h2>${t.fideliteTitre}</h2>
      <p>${t.fideliteDesc}</p>
      <form method="POST" action="/dashboard/fidelite?lang=${langue}" class="stack">
        <label>${t.fideliteNumero}
          <input name="numero" required placeholder="Ex: 65 00 84 85">
        </label>
        <label>${t.fideliteNom}
          <input name="nom" placeholder="Ex: Mariam">
        </label>
        <button type="submit" class="btn-primary">${t.ajouterPoint}</button>
      </form>
      ${listeFidelite}
    </section>

    ${commercant.iaActivee ? `
    <section class="dash-section admin-terminal admin-lea-bloc" id="leaCommercantBloc">
      <div class="admin-terminal-bar">
        <span class="admin-terminal-dot admin-dot-rouge"></span>
        <span class="admin-terminal-dot admin-dot-jaune"></span>
        <span class="admin-terminal-dot admin-dot-verte"></span>
        <span class="admin-terminal-titre">léa@kavio: ~/dashboard</span>
      </div>
      <div class="admin-terminal-corps">
        <p class="admin-terminal-ligne">$ léa --assistante</p>
        <p class="admin-terminal-ligne admin-terminal-reponse" id="leaCompteur">Max 10 messages par jour.</p>
        <div class="chat-messages admin-lea-messages" id="leaDashMessages"></div>
        <form class="chat-form" id="leaDashForm">
          <input type="text" id="leaDashInput" class="admin-terminal-input admin-lea-input" placeholder="Pose ta question à Léa…" autocomplete="off" required>
          <button type="button" class="admin-terminal-btn admin-lea-mic" id="leaDashMic" aria-label="Parler">🎤</button>
          <button type="button" class="admin-terminal-btn admin-lea-stop" id="leaDashStop" aria-label="Arrêter la voix" hidden>⏹</button>
          <button type="submit" class="admin-terminal-btn admin-lea-btn">Envoyer</button>
        </form>
      </div>
    </section>` : ''}

    <section class="dash-section">
      <h2>${t.changerMdp}</h2>
      ${messageMotDePasse ? `<p class="form-error" style="color:${messageMotDePasse.startsWith('Mot de passe modifié') || messageMotDePasse.startsWith('Password') || messageMotDePasse.includes('نجاح') ? 'var(--amber-400)' : 'var(--ember-500)'};">${messageMotDePasse}</p>` : ''}
      <form method="POST" action="/dashboard/mot-de-passe?lang=${langue}" class="stack">
        <label>${t.nouveauMdp}
          <input type="password" name="motdepasse" required minlength="6" autocomplete="new-password">
        </label>
        <button type="submit" class="btn-primary">${t.mettreAJour}</button>
      </form>
    </section>
  </main>
  <script>
    // Upload photo depuis la galerie : ouvre un outil de recadrage (glisser
    // pour repositionner, molette/pincement pour zoomer) avant de compresser
    // l'image et la glisser dans le champ texte (en base64).
    (function() {
      const TAILLE_SORTIE = 800; // taille finale de l'image recadrée (pixels)
      const QUALITE = 0.72;
      const CADRE = 280; // taille du cadre de recadrage à l'écran (pixels CSS)

      // --- Construction de la fenêtre modale de recadrage (une seule fois, réutilisée) ---
      const modale = document.createElement('div');
      modale.className = 'recadreur-modale';
      modale.innerHTML =
        '<div class="recadreur-boite">' +
          '<p class="recadreur-titre">Ajuste ta photo</p>' +
          '<div class="recadreur-cadre" id="recadreurCadre">' +
            '<img id="recadreurImg" draggable="false" alt="">' +
          '</div>' +
          '<input type="range" id="recadreurZoom" min="1" max="3" step="0.01" value="1">' +
          '<div class="recadreur-actions">' +
            '<button type="button" class="btn-mini" id="recadreurAnnuler">Annuler</button>' +
            '<button type="button" class="btn-mini btn-mini-save" id="recadreurValider">Valider</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modale);

      const cadreEl = modale.querySelector('#recadreurCadre');
      const imgEl = modale.querySelector('#recadreurImg');
      const zoomEl = modale.querySelector('#recadreurZoom');
      const btnAnnuler = modale.querySelector('#recadreurAnnuler');
      const btnValider = modale.querySelector('#recadreurValider');

      let etat = null; // { imgNaturelle, echelleBase, posX, posY, callback, rond }

      function appliquerTransform() {
        const echelle = etat.echelleBase * parseFloat(zoomEl.value);
        imgEl.style.width = (etat.imgNaturelle.width * echelle) + 'px';
        imgEl.style.height = (etat.imgNaturelle.height * echelle) + 'px';
        imgEl.style.transform = 'translate(' + etat.posX + 'px, ' + etat.posY + 'px)';
      }

      function ouvrirRecadreur(fichier, callback, rond) {
        const lecteur = new FileReader();
        lecteur.onload = function(e) {
          const img = new Image();
          img.onload = function() {
            const echelleBase = Math.max(CADRE / img.width, CADRE / img.height);
            etat = { imgNaturelle: { width: img.width, height: img.height }, echelleBase: echelleBase, posX: (CADRE - img.width * echelleBase) / 2, posY: (CADRE - img.height * echelleBase) / 2, callback: callback };
            imgEl.src = e.target.result;
            zoomEl.value = 1;
            cadreEl.classList.toggle('recadreur-cadre-rond', !!rond);
            appliquerTransform();
            modale.classList.add('recadreur-ouverte');
          };
          img.src = e.target.result;
        };
        lecteur.readAsDataURL(fichier);
      }

      zoomEl.addEventListener('input', appliquerTransform);

      // Glisser pour repositionner (souris et tactile)
      let glisseActive = false, departX = 0, departY = 0, posDepartX = 0, posDepartY = 0;
      function pointX(e) { return e.touches ? e.touches[0].clientX : e.clientX; }
      function pointY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }
      function debutGlisse(e) {
        glisseActive = true;
        departX = pointX(e); departY = pointY(e);
        posDepartX = etat.posX; posDepartY = etat.posY;
      }
      function pendantGlisse(e) {
        if (!glisseActive || !etat) return;
        e.preventDefault();
        etat.posX = posDepartX + (pointX(e) - departX);
        etat.posY = posDepartY + (pointY(e) - departY);
        appliquerTransform();
      }
      function finGlisse() { glisseActive = false; }
      cadreEl.addEventListener('mousedown', debutGlisse);
      cadreEl.addEventListener('touchstart', debutGlisse, { passive: true });
      window.addEventListener('mousemove', pendantGlisse);
      window.addEventListener('touchmove', pendantGlisse, { passive: false });
      window.addEventListener('mouseup', finGlisse);
      window.addEventListener('touchend', finGlisse);

      btnAnnuler.addEventListener('click', function() {
        modale.classList.remove('recadreur-ouverte');
        etat = null;
      });

      btnValider.addEventListener('click', function() {
        if (!etat) return;
        const echelle = etat.echelleBase * parseFloat(zoomEl.value);
        const sourceX = -etat.posX / echelle;
        const sourceY = -etat.posY / echelle;
        const sourceTaille = CADRE / echelle;
        const toile = document.createElement('canvas');
        toile.width = TAILLE_SORTIE;
        toile.height = TAILLE_SORTIE;
        const ctx = toile.getContext('2d');
        ctx.drawImage(imgEl, sourceX, sourceY, sourceTaille, sourceTaille, 0, 0, TAILLE_SORTIE, TAILLE_SORTIE);
        const dataUrl = toile.toDataURL('image/jpeg', QUALITE);
        etat.callback(dataUrl);
        modale.classList.remove('recadreur-ouverte');
        etat = null;
      });

      // --- Branchement sur les boutons et champs fichier existants ---
      document.querySelectorAll('.btn-photo-galerie').forEach(function(bouton) {
        bouton.addEventListener('click', function() {
          const fichierInput = document.getElementById(bouton.dataset.cible);
          if (fichierInput) fichierInput.click();
        });
      });
      document.querySelectorAll('.input-photo-fichier').forEach(function(fichierInput) {
        fichierInput.addEventListener('change', function() {
          const fichier = fichierInput.files && fichierInput.files[0];
          const champTexte = document.getElementById(fichierInput.dataset.cible);
          if (!fichier || !champTexte) return;
          const bouton = document.querySelector('.btn-photo-galerie[data-cible="' + fichierInput.id + '"]');
          const estRond = fichierInput.dataset.forme === 'rond';
          ouvrirRecadreur(fichier, function(dataUrl) {
            champTexte.value = dataUrl;
            if (bouton) { bouton.textContent = '✅'; setTimeout(function() { bouton.textContent = '📷'; }, 1500); }
            champTexte.dispatchEvent(new Event('change'));
          }, estRond);
        });
      });
    })();
  </script>
  ${commercant.iaActivee ? `
  <script>
    (function() {
      const form = document.getElementById('leaDashForm');
      const input = document.getElementById('leaDashInput');
      const messages = document.getElementById('leaDashMessages');
      const compteurEl = document.getElementById('leaCompteur');
      const bouttonMic = document.getElementById('leaDashMic');
      const bouttonStop = document.getElementById('leaDashStop');
      const codeLangue = '${langue === 'ar' ? 'ar-SA' : (langue === 'en' ? 'en-US' : 'fr-FR')}';
      let historique = [];
      function ajouter(texte, classe) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + classe;
        const bulle = document.createElement('span');
        bulle.className = 'chat-msg-texte';
        bulle.textContent = texte;
        div.appendChild(bulle);
        if (classe.indexOf('ia') !== -1 || classe.indexOf('bot') !== -1) {
          const btnCopier = document.createElement('button');
          btnCopier.type = 'button';
          btnCopier.className = 'chat-msg-copier';
          btnCopier.textContent = '📋';
          btnCopier.setAttribute('aria-label', 'Copier');
          btnCopier.addEventListener('click', () => {
            navigator.clipboard.writeText(texte).then(() => {
              btnCopier.textContent = '✓';
              setTimeout(() => { btnCopier.textContent = '📋'; }, 1500);
            });
          });
          div.appendChild(btnCopier);
        }
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }
      function parlerReponse(texte) {
        if (!('speechSynthesis' in window)) return;
        const u = new SpeechSynthesisUtterance(texte);
        u.lang = codeLangue;
        window.speechSynthesis.cancel();
        if (bouttonStop) {
          bouttonStop.hidden = false;
          u.addEventListener('end', () => { bouttonStop.hidden = true; });
          u.addEventListener('error', () => { bouttonStop.hidden = true; });
        }
        window.speechSynthesis.speak(u);
      }
      if (bouttonStop) {
        bouttonStop.addEventListener('click', () => {
          window.speechSynthesis.cancel();
          bouttonStop.hidden = true;
        });
      }
      const ReconnaissanceVocale = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (ReconnaissanceVocale && bouttonMic) {
        const reco = new ReconnaissanceVocale();
        reco.lang = codeLangue;
        reco.interimResults = false;
        let enEcoute = false;
        bouttonMic.addEventListener('click', () => {
          if (enEcoute) { reco.stop(); return; }
          reco.start();
        });
        reco.addEventListener('start', () => { enEcoute = true; bouttonMic.classList.add('admin-lea-mic-actif'); bouttonMic.textContent = '●'; });
        reco.addEventListener('end', () => { enEcoute = false; bouttonMic.classList.remove('admin-lea-mic-actif'); bouttonMic.textContent = '🎤'; });
        reco.addEventListener('result', (e) => {
          input.value = e.results[0][0].transcript;
          form.requestSubmit();
        });
      } else if (bouttonMic) {
        bouttonMic.style.display = 'none';
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const texte = input.value.trim();
        if (!texte) return;
        ajouter(texte, 'chat-msg-client');
        historique.push({ role: 'user', content: texte });
        input.value = '';
        input.disabled = true;
        const attente = document.createElement('div');
        attente.className = 'chat-msg chat-msg-ia chat-msg-attente';
        attente.textContent = '…';
        messages.appendChild(attente);
        try {
          const reponse = await fetch('/dashboard/lea?lang=${langue}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ historique: historique.slice(-10) })
          });
          const data = await reponse.json();
          attente.remove();
          if (data.reponse) {
            ajouter(data.reponse, 'chat-msg-ia');
            historique.push({ role: 'assistant', content: data.reponse });
            parlerReponse(data.reponse);
            if (typeof data.restant === 'number') compteurEl.textContent = data.restant + ' message(s) restant(s) aujourd\\'hui.';
          } else {
            ajouter(data.erreur || 'Erreur', 'chat-msg-ia');
          }
        } catch (err) {
          attente.remove();
          ajouter('Connexion impossible.', 'chat-msg-ia');
        }
        input.disabled = false;
        input.focus();
      });
    })();
  </script>
  <script>
    async function genererDescriptionIA(id) {
      const nom = document.getElementById(id === 'ajout' ? 'ajoutNom' : 'nom-' + id).value;
      const categorie = document.getElementById(id === 'ajout' ? 'ajoutCategorie' : 'cat-' + id).value;
      const champDesc = document.getElementById(id === 'ajout' ? 'ajoutDescription' : 'desc-' + id);
      if (!nom) { alert('${langue === 'ar' ? 'اكتب الاسم أولاً' : (langue === 'en' ? 'Write the name first' : "Ecris d'abord le nom")}'); return; }
      const bouton = event.target;
      const texteOriginal = bouton.textContent;
      bouton.textContent = '${langue === 'ar' ? '...جارٍ الإنشاء' : (langue === 'en' ? 'Generating...' : 'Génération...')}';
      bouton.disabled = true;
      try {
        const reponse = await fetch('/dashboard/ia-description?lang=${langue}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nom, categorie })
        });
        const data = await reponse.json();
        if (data.description) { champDesc.value = data.description; }
        else { alert(data.erreur || 'Erreur IA'); }
      } catch (e) {
        alert('Erreur de connexion à l\\'IA.');
      }
      bouton.textContent = texteOriginal;
      bouton.disabled = false;
    }
  </script>` : ''}
</body>
</html>`;
}

const TRADUCTIONS = {
  fr: { menu: 'Menu', prix: 'Prix en Francs CFA', paiement: 'Paiement Mobile Money', commander: 'Commander', avis: 'Avis clients', laisserAvis: 'Laisser un avis', votreNote: 'Votre note', votreAvisOpt: 'Votre commentaire (optionnel)', envoyerAvis: 'Envoyer', merciAvis: 'Merci pour votre avis !', aucunAvis: 'Aucun avis pour le moment.', chatTitre: 'Léa', chatSousTitre: 'Assistante du menu', chatPlaceholder: 'Pose ta question…', chatBienvenue: 'Bonjour ! Je suis Léa, je peux répondre à tes questions sur le menu. 😊', chatEnvoyer: 'Envoyer', imprimerCatalogue: 'Imprimer / Télécharger en PDF' },
  en: { menu: 'Menu', prix: 'Prices in CFA Francs', paiement: 'Mobile Money payment', commander: 'Order', avis: 'Customer reviews', laisserAvis: 'Leave a review', votreNote: 'Your rating', votreAvisOpt: 'Your comment (optional)', envoyerAvis: 'Send', merciAvis: 'Thanks for your review!', aucunAvis: 'No reviews yet.', chatTitre: 'Léa', chatSousTitre: 'Menu assistant', chatPlaceholder: 'Ask a question…', chatBienvenue: 'Hi! I\'m Léa, ask me anything about the menu. 😊', chatEnvoyer: 'Send', imprimerCatalogue: 'Print / Save as PDF' },
  ar: { menu: 'القائمة', prix: 'الأسعار بالفرنك الأفريقي', paiement: 'الدفع عبر موبايل موني', commander: 'اطلب', avis: 'آراء الزبائن', laisserAvis: 'أضف رأيك', votreNote: 'تقييمك', votreAvisOpt: 'تعليقك (اختياري)', envoyerAvis: 'إرسال', merciAvis: 'شكرا على رأيك!', aucunAvis: 'لا توجد آراء بعد.', chatTitre: 'ليا', chatSousTitre: 'مساعدة القائمة', chatPlaceholder: 'اطرح سؤالك…', chatBienvenue: 'مرحبا! أنا ليا، اسألني عن القائمة. 😊', chatEnvoyer: 'إرسال', imprimerCatalogue: 'طباعة / حفظ بصيغة PDF' },
};
const ORDRE_LANGUES = ['fr', 'en', 'ar'];
const NOMS_LANGUES = { fr: 'FR', en: 'EN', ar: 'AR' };

// Vocabulaire du dashboard, selon la langue choisie
const TRAD_DASH = {
  fr: {
    tableauDeBord: 'Tableau de bord', deconnexion: 'Se déconnecter', pagePublique: 'Page publique',
    statistiques: 'Statistiques', statsDesc: 'Nombre de fois où des clients ont ouvert ton menu.',
    vue: 'vue', vues: 'vues', auTotal: 'au total',
    tonQr: 'Ton QR code', tonQrDesc: 'Les clients scannent ce code. Tu peux l\'imprimer.', qrImprimer: 'Version à imprimer',
    telecharger: 'Télécharger le QR code',
    qrTable: 'QR code par emplacement', qrTableDesc: 'Génère un QR code différent pour chaque table, caisse, comptoir ou zone.',
    nomTable: 'Nom (ex: Table 3, VIP, Bar)', generer: 'Générer ce QR code',
    ajouter: 'Ajouter', enStock: 'En stock', enregistrer: 'Enregistrer', supprimer: 'Supprimer',
    categorieOpt: 'Catégorie (optionnel)', photoOpt: 'Lien de la photo (optionnel)', prixLabel: 'Prix', prixPromoLabel: 'Prix promo (optionnel)', historiquePrixTitre: 'Historique des prix', clicsCommandeTitre: 'Nombre de fois où ce produit a été commandé',
    numeroMobile: 'Numéro Mobile Money', numeroMobileDesc: 'Affiché sur ton menu et pour la commande WhatsApp.',
    themeTitre: 'Couleur de ta page', themeDesc: 'Choisis la couleur qui représente le mieux ton commerce.',
    graphique7Jours: '7 derniers jours',
    domaineTitre: 'Domaine personnalisé', domaineDesc: 'Si tu as acheté un nom de domaine, connecte-le ici pour que tes clients voient une adresse à ton nom au lieu de railway.app.',
    domaineLabel: 'Ton domaine (sans https://)',
    aProposTitre: 'À propos de ton commerce', aProposDesc: 'Ces infos apparaissent sur ta page catalogue, en bas.', photoProfilLabel: 'Photo de profil', choisirPhoto: 'Choisir une photo',
    adresseLabel: 'Adresse', horairesLabel: 'Horaires d\'ouverture',
    numero: 'Numéro', changerMdp: 'Changer mon mot de passe', nouveauMdp: 'Nouveau mot de passe', mettreAJour: 'Mettre à jour',
    disponibleDe: 'Visible de', horaireA: 'à', descriptionOpt: 'Description (optionnel)', genererIA: '✨ Générer avec l\'IA',
    stockLabel: 'Quantité en stock (optionnel)', stockRestant: 'en stock', stockRupture: 'Rupture de stock',
    paiementsTitre: 'Paiements reçus', paiementsDesc: 'Note ce que tu reçois de tes clients pour garder un historique clair.',
    totalRecu: 'reçu au total', montantLabel: 'Montant (F CFA)', noteLabel: 'Client / note (optionnel)',
    noteLabelPlaceholder: 'Ex: Mariam, table 3', ajouterPaiement: 'Ajouter', aucunPaiement: 'Aucun paiement noté pour le moment.',
    fideliteTitre: 'Clients fidèles', fideliteDesc: 'À partir de 10 points, pense à offrir une petite réduction.',
    fideliteNumero: 'Numéro du client', fideliteNom: 'Nom (optionnel)', ajouterPoint: '+1 point',
    fidelitePoints: 'pts', fideliteRecompense: '🎁 Mérite une réduction', aucunFidele: 'Aucun client fidèle enregistré pour le moment.',
  },
  en: {
    tableauDeBord: 'Dashboard', deconnexion: 'Log out', pagePublique: 'Public page',
    statistiques: 'Statistics', statsDesc: 'Number of times customers opened your menu.',
    vue: 'view', vues: 'views', auTotal: 'total',
    tonQr: 'Your QR code', tonQrDesc: 'Customers scan this code. You can print it.', qrImprimer: 'Printable version',
    telecharger: 'Download the QR code',
    qrTable: 'QR code per location', qrTableDesc: 'Generate a different QR code for each spot: counter, shelf, table, or zone.',
    nomTable: 'Name (e.g. Table 3, VIP, Bar)', generer: 'Generate this QR code',
    ajouter: 'Add', enStock: 'In stock', enregistrer: 'Save', supprimer: 'Delete',
    categorieOpt: 'Category (optional)', photoOpt: 'Photo link (optional)', prixLabel: 'Price', prixPromoLabel: 'Sale price (optional)', historiquePrixTitre: 'Price history', clicsCommandeTitre: 'Times this product was ordered',
    numeroMobile: 'Mobile Money number', numeroMobileDesc: 'Shown on your menu and for WhatsApp ordering.',
    themeTitre: 'Your page color', themeDesc: 'Pick the color that best represents your business.',
    graphique7Jours: 'Last 7 days',
    domaineTitre: 'Custom domain', domaineDesc: 'If you bought a domain name, connect it here so customers see your own address instead of railway.app.',
    domaineLabel: 'Your domain (without https://)',
    aProposTitre: 'About your business', aProposDesc: 'This info appears at the bottom of your catalog page.', photoProfilLabel: 'Profile photo', choisirPhoto: 'Choose a photo',
    adresseLabel: 'Address', horairesLabel: 'Opening hours',
    numero: 'Number', changerMdp: 'Change my password', nouveauMdp: 'New password', mettreAJour: 'Update',
    disponibleDe: 'Visible from', horaireA: 'to', descriptionOpt: 'Description (optional)', genererIA: '✨ Generate with AI',
    stockLabel: 'Stock quantity (optional)', stockRestant: 'in stock', stockRupture: 'Out of stock',
    paiementsTitre: 'Payments received', paiementsDesc: 'Note what you receive from customers to keep a clear history.',
    totalRecu: 'received total', montantLabel: 'Amount (F CFA)', noteLabel: 'Customer / note (optional)',
    noteLabelPlaceholder: 'E.g: Mariam, table 3', ajouterPaiement: 'Add', aucunPaiement: 'No payment logged yet.',
    fideliteTitre: 'Loyal customers', fideliteDesc: 'From 10 points on, consider offering a small discount.',
    fideliteNumero: 'Customer number', fideliteNom: 'Name (optional)', ajouterPoint: '+1 point',
    fidelitePoints: 'pts', fideliteRecompense: '🎁 Deserves a discount', aucunFidele: 'No loyal customer logged yet.',
  },
  ar: {
    tableauDeBord: 'لوحة التحكم', deconnexion: 'تسجيل الخروج', pagePublique: 'الصفحة العامة',
    statistiques: 'الإحصائيات', statsDesc: 'عدد مرات فتح العملاء لقائمتك.',
    vue: 'مشاهدة', vues: 'مشاهدات', auTotal: 'إجمالي',
    tonQr: 'رمز الاستجابة السريعة الخاص بك', tonQrDesc: 'يقوم العملاء بمسح هذا الرمز. يمكنك طباعته.', qrImprimer: 'نسخة للطباعة',
    telecharger: 'تحميل رمز QR',
    qrTable: 'رمز QR لكل طاولة', qrTableDesc: 'أنشئ رمز QR مختلف لكل طاولة أو البار أو "للطلبات الخارجية".',
    nomTable: 'الاسم (مثال: طاولة 3، في آي بي، البار)', generer: 'إنشاء رمز QR',
    ajouter: 'إضافة', enStock: 'متوفر', enregistrer: 'حفظ', supprimer: 'حذف',
    categorieOpt: 'الفئة (اختياري)', photoOpt: 'رابط الصورة (اختياري)', prixLabel: 'السعر', prixPromoLabel: 'سعر العرض (اختياري)', historiquePrixTitre: 'سجل الأسعار', clicsCommandeTitre: 'عدد مرات طلب هذا المنتج',
    numeroMobile: 'رقم موبايل موني', numeroMobileDesc: 'يظهر في قائمتك ولطلبات واتساب.',
    themeTitre: 'لون صفحتك', themeDesc: 'اختر اللون الذي يمثل متجرك بشكل أفضل.',
    graphique7Jours: 'آخر 7 أيام',
    domaineTitre: 'نطاق مخصص', domaineDesc: 'إذا اشتريت اسم نطاق، اربطه هنا ليرى عملاؤك عنوانك الخاص بدلاً من railway.app.',
    domaineLabel: 'نطاقك (بدون https://)',
    aProposTitre: 'عن متجرك', aProposDesc: 'تظهر هذه المعلومات أسفل صفحة الكتالوج الخاصة بك.', photoProfilLabel: 'صورة الملف الشخصي', choisirPhoto: 'اختر صورة',
    adresseLabel: 'العنوان', horairesLabel: 'ساعات العمل',
    numero: 'الرقم', changerMdp: 'تغيير كلمة المرور', nouveauMdp: 'كلمة مرور جديدة', mettreAJour: 'تحديث',
    disponibleDe: 'مرئي من', horaireA: 'إلى', descriptionOpt: 'الوصف (اختياري)', genererIA: '✨ إنشاء بالذكاء الاصطناعي',
    stockLabel: 'الكمية المتوفرة (اختياري)', stockRestant: 'متوفر', stockRupture: 'نفدت الكمية',
    paiementsTitre: 'المدفوعات المستلمة', paiementsDesc: 'سجل ما تستلمه من زبائنك لتتبع واضح.',
    totalRecu: 'الإجمالي المستلم', montantLabel: 'المبلغ (فرنك أفريقي)', noteLabel: 'الزبون / ملاحظة (اختياري)',
    noteLabelPlaceholder: 'مثال: مريم، طاولة 3', ajouterPaiement: 'إضافة', aucunPaiement: 'لا توجد مدفوعات مسجلة بعد.',
    fideliteTitre: 'الزبائن الأوفياء', fideliteDesc: 'ابتداء من 10 نقاط، فكر في تقديم خصم صغير.',
    fideliteNumero: 'رقم الزبون', fideliteNom: 'الاسم (اختياري)', ajouterPoint: '+1 نقطة',
    fidelitePoints: 'نقطة', fideliteRecompense: '🎁 يستحق خصماً', aucunFidele: 'لا يوجد زبائن أوفياء مسجلون بعد.',
  },
};

// Vocabulaire du produit selon le type d'activité du commerçant
const MOTS_ACTIVITE = {
  restaurant: { fr: 'article', en: 'item', ar: 'منتج' },
  coiffure:   { fr: 'prestation', en: 'service', ar: 'خدمة' },
  hotel:      { fr: 'chambre', en: 'room', ar: 'غرفة' },
  boutique:   { fr: 'article', en: 'item', ar: 'منتج' },
  autre:      { fr: 'produit', en: 'product', ar: 'منتج' },
};
function motProduit(typeActivite, langue) {
  const table = MOTS_ACTIVITE[typeActivite] || MOTS_ACTIVITE.autre;
  return table[langue] || table.fr;
}

// Version imprimable du catalogue : mise en page simple noir/blanc,
// optimisée pour l'impression papier ou "Enregistrer en PDF" du navigateur.
function pageMenuImprimable(commercant, langue) {
  const produitsTries = [...commercant.produits].sort((a, b) => (a.categorie || '').localeCompare(b.categorie || ''));
  const lignesProduits = produitsTries.map(p => {
    const enPromo = p.prixPromo && Number(p.prixPromo) > 0 && Number(p.prixPromo) < Number(p.prix);
    const prixAffiche = enPromo ? p.prixPromo : p.prix;
    return `
    <tr>
      <td>${p.nom}${p.description ? `<br><small>${p.description}</small>` : ''}</td>
      <td class="prix-imprime">${enPromo ? `<s>${p.prix} F</s> ` : ''}${prixAffiche} F</td>
    </tr>`;
  }).join('');
  return `<!DOCTYPE html>
<html lang="${langue}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${commercant.nom} — Catalogue</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 1.8rem; border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; margin-bottom: 4px; }
  .sous-titre { color: #555; font-size: 0.9rem; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 10px 4px; border-bottom: 1px dotted #ccc; vertical-align: top; }
  td small { color: #666; }
  .prix-imprime { text-align: right; white-space: nowrap; font-weight: bold; }
  .prix-imprime s { color: #999; font-weight: normal; }
  .pied-imprime { margin-top: 30px; text-align: center; color: #777; font-size: 0.8rem; }
  .bouton-imprimer { display: block; margin: 0 auto 24px; padding: 10px 20px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  @media print { .bouton-imprimer { display: none; } }
</style>
</head>
<body>
  <button class="bouton-imprimer" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
  <h1>${commercant.nom}</h1>
  <p class="sous-titre">${commercant.adresse || ''}${commercant.adresse && commercant.horaires ? ' — ' : ''}${commercant.horaires || ''}</p>
  <table>${lignesProduits}</table>
  <p class="pied-imprime">Catalogue généré via KAVIO</p>
</body>
</html>`;
}

function pageMenuPublic(commercant, slug, langue, table, messageAvis) {
  const t = TRADUCTIONS[langue] || TRADUCTIONS.fr;
  const indexActuel = ORDRE_LANGUES.indexOf(langue) === -1 ? 0 : ORDRE_LANGUES.indexOf(langue);
  const autreLangue = ORDRE_LANGUES[(indexActuel + 1) % ORDRE_LANGUES.length];
  const labelAutreLangue = NOMS_LANGUES[autreLangue];
  const direction = langue === 'ar' ? 'rtl' : 'ltr';
  const suffixeUrl = `?lang=${langue}${table ? '&table=' + encodeURIComponent(table) : ''}`;

  // Numéro WhatsApp pour la commande (on réutilise le numéro Mobile Money, format international requis)
  const numeroWhatsApp = (commercant.telephonePaiement || '').replace(/[^0-9]/g, '');
  const precisionTable = table ? ` — ${table}` : '';

  // Filtre par horaire : un produit avec heureDebut/heureFin ne s'affiche que sur cette plage
  function estDansHoraire(p) {
    if (!p.heureDebut || !p.heureFin) return true;
    const maintenant = new Date();
    const heureActuelle = maintenant.getHours() * 60 + maintenant.getMinutes();
    const [hd, md] = p.heureDebut.split(':').map(Number);
    const [hf, mf] = p.heureFin.split(':').map(Number);
    const debut = hd * 60 + (md || 0);
    const fin = hf * 60 + (mf || 0);
    if (debut <= fin) return heureActuelle >= debut && heureActuelle < fin;
    // Plage qui traverse minuit (ex: 22h -> 2h)
    return heureActuelle >= debut || heureActuelle < fin;
  }

  function ligneProduit(p) {
    const epuise = p.disponible === false || (p.stock !== null && p.stock !== undefined && Number(p.stock) <= 0);
    const enPromo = p.prixPromo && Number(p.prixPromo) > 0 && Number(p.prixPromo) < Number(p.prix);
    const prixAffiche = enPromo ? p.prixPromo : p.prix;
    const pourcentageReduc = enPromo ? Math.round((1 - Number(p.prixPromo) / Number(p.prix)) * 100) : 0;
    const messageWa = encodeURIComponent(`Bonjour, je veux commander : ${p.nom} (${prixAffiche} F)${precisionTable}`);
    return `
    <li class="menu-item ${epuise ? 'menu-item-epuise' : ''}">
      ${p.photo ? `<img src="${p.photo}" alt="" class="menu-item-photo">` : ''}
      <span class="item-nom">${p.nom}</span>
      <span class="item-leader" aria-hidden="true"></span>
      ${epuise
        ? `<span class="item-epuise-tag">Épuisé</span>`
        : `<span class="item-prix">
             ${enPromo ? `<span class="item-badge-promo">-${pourcentageReduc}%</span> <span class="item-prix-barre">${p.prix} F</span> ` : ''}${prixAffiche}<span class="item-devise"> F</span>
           </span>
           ${numeroWhatsApp ? `<a class="item-commander" href="/menu/${slug}/commander?produit=${p.indexReel}&wa=${numeroWhatsApp}&texte=${messageWa}" target="_blank">${t.commander}</a>` : ''}`
      }
      ${p.description ? `<span class="item-description">${p.description}</span>` : ''}
      ${p.dateAjout && (Date.now() - p.dateAjout) < 7 * 24 * 3600 * 1000 ? `<span class="item-badge-nouveau">✨ Nouveau</span>` : ''}
    </li>`;
  }

  // Regroupement par catégorie si les produits en ont une (on filtre d'abord par horaire)
  // On garde une trace de l'index réel dans commercant.produits pour le suivi des clics "Commander"
  const produitsVisibles = commercant.produits
    .map((p, i) => ({ ...p, indexReel: i }))
    .filter(estDansHoraire);
  const categories = {};
  const sansCategorie = [];
  produitsVisibles.forEach(p => {
    if (p.categorie) {
      categories[p.categorie] = categories[p.categorie] || [];
      categories[p.categorie].push(p);
    } else {
      sansCategorie.push(p);
    }
  });

  let corpsListe = '';
  if (Object.keys(categories).length === 0) {
    corpsListe = `<ul class="menu-list">${sansCategorie.map(ligneProduit).join('')}</ul>`;
  } else {
    corpsListe = Object.entries(categories).map(([nomCat, produits]) => `
      <h2 class="menu-categorie">${nomCat}</h2>
      <ul class="menu-list">${produits.map(ligneProduit).join('')}</ul>`).join('');
    if (sansCategorie.length) {
      corpsListe += `<ul class="menu-list">${sansCategorie.map(ligneProduit).join('')}</ul>`;
    }
  }

  // --- Avis clients ---
  const avis = commercant.avis || [];
  const moyenne = avis.length ? (avis.reduce((s, a) => s + a.note, 0) / avis.length) : 0;
  const etoiles = (n) => Array.from({length: 5}).map((_, i) => `<span class="etoile ${i < Math.round(n) ? 'etoile-pleine' : ''}">★</span>`).join('');
  const blocAvisListe = avis.length
    ? avis.slice(-8).reverse().map(a => `
        <div class="avis-item">
          <div class="avis-etoiles">${etoiles(a.note)}</div>
          ${a.commentaire ? `<p class="avis-commentaire">${a.commentaire}</p>` : ''}
        </div>`).join('')
    : `<p class="avis-vide">${t.aucunAvis}</p>`;
  const blocAvis = `
    <section class="menu-avis">
      <h2 class="menu-categorie">${t.avis}</h2>
      ${avis.length ? `<div class="avis-moyenne">${etoiles(moyenne)} <span class="avis-total">${moyenne.toFixed(1)} / 5 (${avis.length})</span></div>` : ''}
      ${blocAvisListe}
      ${messageAvis ? `<p class="avis-merci">${t.merciAvis}</p>` : `
      <form method="POST" action="/menu/${slug}/avis${suffixeUrl}" class="form-avis">
        <label class="avis-label">${t.votreNote}
          <select name="note" required>
            <option value="5">★★★★★</option>
            <option value="4">★★★★</option>
            <option value="3">★★★</option>
            <option value="2">★★</option>
            <option value="1">★</option>
          </select>
        </label>
        <textarea name="commentaire" placeholder="${t.votreAvisOpt}" maxlength="300" rows="2"></textarea>
        <button type="submit" class="btn-primary">${t.envoyerAvis}</button>
      </form>`}
    </section>`;

  return `<!DOCTYPE html>
<html lang="${langue}" dir="${direction}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${commercant.nom}</title>
${FAVICON}<link rel="stylesheet" href="/style.css">
</head>
<body class="fond-braise"${commercant.couleurTheme ? ` style="${styleThemeCommercant(commercant.couleurTheme)}"` : ''}>
  ${ECRAN_CHARGEMENT}
  <main class="menu-page">
    <div class="menu-card">
      <a class="lang-switch" href="?lang=${autreLangue}${table ? '&table=' + encodeURIComponent(table) : ''}">${labelAutreLangue}</a>
      <button type="button" class="mode-clair-bouton" id="modeClairBouton" title="Mode clair / sombre" aria-label="Mode clair / sombre">🌓</button>
      <header class="menu-head">
        ${commercant.photoProfil ? `<img src="${commercant.photoProfil}" alt="" class="menu-photo-profil">` : ''}
        <span class="eyebrow">${t.menu}</span>
        <h1>${commercant.nom}</h1>
        ${table ? `<span class="menu-table-tag">${table}</span>` : ''}
      </header>
      <div class="grill-rule" aria-hidden="true"></div>
      ${corpsListe}
      <footer class="menu-foot">${t.prix}</footer>
      ${commercant.telephonePaiement ? `<p class="menu-paiement">${t.paiement} : <strong>${commercant.telephonePaiement}</strong></p>` : ''}
      ${(commercant.adresse || commercant.horaires || commercant.instagram || commercant.facebook) ? `
      <div class="menu-apropos">
        ${commercant.adresse ? `<p class="menu-apropos-ligne">📍 ${commercant.adresse}</p>` : ''}
        ${commercant.horaires ? `<p class="menu-apropos-ligne">🕒 ${commercant.horaires}</p>` : ''}
        ${(commercant.instagram || commercant.facebook) ? `
        <p class="menu-apropos-reseaux">
          ${commercant.instagram ? `<a href="https://instagram.com/${commercant.instagram.replace('@','').trim()}" target="_blank">Instagram</a>` : ''}
          ${commercant.instagram && commercant.facebook ? ' · ' : ''}
          ${commercant.facebook ? `<a href="${commercant.facebook.startsWith('http') ? commercant.facebook : 'https://' + commercant.facebook}" target="_blank">Facebook</a>` : ''}
        </p>` : ''}
      </div>` : ''}
      <p class="menu-lien-imprimer"><a href="/menu/${slug}/imprimer?lang=${langue}" target="_blank">🖨️ ${t.imprimerCatalogue}</a></p>
      ${blocAvis}
    </div>
  </main>
  ${commercant.iaActivee ? `
  <div class="chat-widget" id="chatWidget">
    <button type="button" class="chat-bulle" id="chatBouton" aria-label="${t.chatTitre}">💬</button>
    <div class="chat-panneau" id="chatPanneau" hidden>
      <div class="chat-panneau-tete">
        <div>
          <strong>${t.chatTitre}</strong>
          <span class="chat-sous-titre">${t.chatSousTitre}</span>
        </div>
        <button type="button" class="chat-fermer" id="chatFermer" aria-label="Fermer">✕</button>
      </div>
      <div class="chat-messages" id="chatMessages">
        <div class="chat-msg chat-msg-ia">${t.chatBienvenue}</div>
      </div>
      <form class="chat-form" id="chatForm">
        <input type="text" id="chatInput" placeholder="${t.chatPlaceholder}" autocomplete="off" required>
        <button type="submit" class="btn-ia">${t.chatEnvoyer}</button>
      </form>
    </div>
  </div>
  <script>
    (function() {
      const bouton = document.getElementById('chatBouton');
      const panneau = document.getElementById('chatPanneau');
      const fermer = document.getElementById('chatFermer');
      const form = document.getElementById('chatForm');
      const input = document.getElementById('chatInput');
      const messages = document.getElementById('chatMessages');
      let historique = [];

      bouton.addEventListener('click', () => { panneau.hidden = !panneau.hidden; if (!panneau.hidden) input.focus(); });
      fermer.addEventListener('click', (e) => { e.stopPropagation(); panneau.hidden = true; });

      function ajouterMessage(texte, classe) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + classe;
        const bulle = document.createElement('span');
        bulle.className = 'chat-msg-texte';
        bulle.textContent = texte;
        div.appendChild(bulle);
        if (classe.indexOf('ia') !== -1) {
          const btnCopier = document.createElement('button');
          btnCopier.type = 'button';
          btnCopier.className = 'chat-msg-copier';
          btnCopier.textContent = '📋';
          btnCopier.setAttribute('aria-label', 'Copier');
          btnCopier.addEventListener('click', () => {
            navigator.clipboard.writeText(texte).then(() => {
              btnCopier.textContent = '✓';
              setTimeout(() => { btnCopier.textContent = '📋'; }, 1500);
            });
          });
          div.appendChild(btnCopier);
        }
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const texte = input.value.trim();
        if (!texte) return;
        ajouterMessage(texte, 'chat-msg-client');
        historique.push({ role: 'user', content: texte });
        input.value = '';
        input.disabled = true;
        const attente = document.createElement('div');
        attente.className = 'chat-msg chat-msg-ia chat-msg-attente';
        attente.textContent = '…';
        messages.appendChild(attente);
        messages.scrollTop = messages.scrollHeight;
        try {
          const reponse = await fetch('/menu/${slug}/chat?lang=${langue}', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ historique: historique.slice(-10) })
          });
          const data = await reponse.json();
          attente.remove();
          if (data.reponse) {
            ajouterMessage(data.reponse, 'chat-msg-ia');
            historique.push({ role: 'assistant', content: data.reponse });
          } else {
            ajouterMessage(data.erreur || 'Erreur', 'chat-msg-ia');
          }
        } catch (err) {
          attente.remove();
          ajouterMessage('Connexion impossible pour le moment.', 'chat-msg-ia');
        }
        input.disabled = false;
        input.focus();
      });
    })();
  </script>` : ''}
  <script>
  (function() {
    var body = document.body;
    var bouton = document.getElementById('modeClairBouton');
    var CLE = 'kavio-mode-clair';
    function appliquer(clair) {
      body.classList.toggle('mode-clair', clair);
    }
    try {
      appliquer(localStorage.getItem(CLE) === '1');
    } catch (e) { /* stockage indisponible, on reste en mode sombre par défaut */ }
    if (bouton) {
      bouton.addEventListener('click', function() {
        var clair = !body.classList.contains('mode-clair');
        appliquer(clair);
        try { localStorage.setItem(CLE, clair ? '1' : '0'); } catch (e) {}
      });
    }
  })();
  </script>
</body>
</html>`;
}

function pageErreur(message, code) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Erreur ${code}</title>
  ${FAVICON}<link rel="stylesheet" href="/style.css"></head>
  <body class="fond-braise"><main class="auth-page"><div class="auth-card">
    <span class="eyebrow">Erreur ${code}</span>
    <h1>${message}</h1>
  </div></main></body></html>`;
}

// ------------------------------------------------------------
// LE SERVEUR : qui répond à quelle adresse
// ------------------------------------------------------------
const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const chemin = url.pathname;
  const hoteBrut = (req.headers.host || '').split(':')[0].toLowerCase(); // sans le port

  // --- Domaine personnalisé : si un commerçant a configuré son propre domaine
  // (ex: menu.lebonsoin.td), on lui sert directement son catalogue sur "/"
  // au lieu d'exiger /menu/son-slug. On ne fait rien pour le domaine principal
  // de KAVIO ni pour le domaine Railway par défaut.
  if (hoteBrut && !hoteBrut.includes('railway.app') && hoteBrut !== 'kavio.td' && hoteBrut !== 'localhost') {
    const dbHote = lireDB();
    const slugPourCeDomaine = Object.keys(dbHote.commercants || {}).find(
      s => (dbHote.commercants[s].domainePersonnalise || '').toLowerCase() === hoteBrut
    );
    if (slugPourCeDomaine && (chemin === '/' || chemin.startsWith('/avis') || chemin.startsWith('/chat'))) {
      req.url = chemin === '/' ? `/menu/${slugPourCeDomaine}${url.search}` : `/menu/${slugPourCeDomaine}${chemin.replace(/^\/[^/]+/, '')}${url.search}`;
      return serveur.emit('request', req, res);
    }
  }

  // --- Garde globale : un compte suspendu perd l'accès à TOUT le dashboard immédiatement ---
  if (chemin.startsWith('/dashboard')) {
    const slugCourant = slugDepuisRequete(req);
    if (slugCourant) {
      const dbCheck = lireDB();
      const cCourant = dbCheck.commercants[slugCourant];
      if (!cCourant || cCourant.suspendu) {
        delete sessions[lireCookies(req).session];
        res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/login' });
        return res.end();
      }
    }
  }

  // --- Fichier CSS statique ---
  if (chemin === '/style.css') {
    const css = fs.readFileSync(path.join(__dirname, 'style.css'));
    res.writeHead(200, { 'Content-Type': 'text/css' });
    return res.end(css);
  }

  // --- Page publique du menu : CE LIEN VA DANS LE QR CODE ---
  if (chemin.startsWith('/menu/') && !chemin.includes('/', 6) && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce commerçant n\'existe pas.', 404));
    }
    if (commercant.suspendu) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce compte est momentanément en pause. Merci de contacter le commerçant.', 200));
    }
    // On compte cette visite (statistiques simples + historique par jour pour le graphique)
    commercant.vues = (commercant.vues || 0) + 1;
    const aujourdHui = new Date().toISOString().slice(0, 10); // ex: "2026-08-23"
    commercant.vuesParJour = commercant.vuesParJour || {};
    commercant.vuesParJour[aujourdHui] = (commercant.vuesParJour[aujourdHui] || 0) + 1;
    // On garde seulement les 30 derniers jours pour ne pas alourdir le fichier
    const clesJours = Object.keys(commercant.vuesParJour).sort();
    if (clesJours.length > 30) {
      clesJours.slice(0, clesJours.length - 30).forEach(k => delete commercant.vuesParJour[k]);
    }
    ecrireDB(db);
    const langue = url.searchParams.get('lang') || 'fr';
    const table = url.searchParams.get('table') || '';
    const messageAvis = url.searchParams.get('avis') === 'ok';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageMenuPublic(commercant, slug, langue, table, messageAvis));
  }

  // --- Version imprimable du catalogue (le navigateur peut l'enregistrer en PDF) ---
  if (chemin.match(/^\/menu\/[^/]+\/imprimer$/) && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '').replace('/imprimer', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce commerçant n\'existe pas.', 404));
    }
    const langue = url.searchParams.get('lang') || 'fr';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageMenuImprimable(commercant, langue));
  }

  // --- Clic "Commander" : on compte l'intérêt pour ce produit précis, puis on redirige vers WhatsApp ---
  if (chemin.match(/^\/menu\/[^/]+\/commander$/) && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '').replace('/commander', '');
    const indexProduit = Number(url.searchParams.get('produit'));
    const numeroWa = url.searchParams.get('wa') || '';
    const texte = url.searchParams.get('texte') || '';
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (commercant && commercant.produits[indexProduit]) {
      commercant.produits[indexProduit].clicsCommande = (commercant.produits[indexProduit].clicsCommande || 0) + 1;
      ecrireDB(db);
    }
    res.writeHead(302, { Location: `https://wa.me/${numeroWa}?text=${texte}` });
    return res.end();
  }

  // --- Envoi d'un avis client sur un menu public ---
  if (chemin.endsWith('/avis') && chemin.startsWith('/menu/') && req.method === 'POST') {
    const slug = chemin.replace('/menu/', '').replace('/avis', '');
    const ip = adresseIP(req);
    const cleAntiSpam = `${slug}:${ip}:${new Date().toDateString()}`;
    if (avisEnvoyesAujourdhui.has(cleAntiSpam)) {
      res.writeHead(302, { Location: `/menu/${slug}${url.search}` });
      return res.end();
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { note, commentaire } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];
      if (commercant && !commercant.suspendu) {
        const noteNum = Math.min(5, Math.max(1, parseInt(note, 10) || 5));
        commercant.avis = commercant.avis || [];
        commercant.avis.push({
          note: noteNum,
          commentaire: (commentaire || '').toString().slice(0, 300),
          date: new Date().toISOString(),
        });
        // On garde les 200 derniers avis maximum
        if (commercant.avis.length > 200) commercant.avis = commercant.avis.slice(-200);
        ecrireDB(db);
        avisEnvoyesAujourdhui.add(cleAntiSpam);
      }
      const params = new URLSearchParams(url.search);
      params.set('avis', 'ok');
      res.writeHead(302, { Location: `/menu/${slug}?${params.toString()}` });
      return res.end();
    });
    return;
  }

  // --- Chat IA "Léa" pour les clients sur le menu public ---
  if (chemin.endsWith('/chat') && chemin.startsWith('/menu/') && req.method === 'POST') {
    const slug = chemin.replace('/menu/', '').replace('/chat', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant || commercant.suspendu || !commercant.iaActivee) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Chat non disponible.' }));
    }
    if (!process.env.GROQ_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Clé IA non configurée sur le serveur.' }));
    }
    const ip = adresseIP(req);
    const cleLimite = `${slug}:${ip}:${new Date().toDateString()}`;
    const compteur = messagesChatAujourdhui.get(cleLimite) || 0;
    if (compteur >= 30) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Trop de messages aujourd\'hui, réessaie demain.' }));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', async () => {
      try {
        const { historique } = JSON.parse(corps || '{}');
        const langue = url.searchParams.get('lang') || 'fr';
        const langueTexte = langue === 'ar' ? 'arabe' : (langue === 'en' ? 'anglais' : 'français');
        const listeProduits = (commercant.produits || []).map(p =>
          `- ${p.nom}${p.categorie ? ` (${p.categorie})` : ''} : ${p.prix} F${p.description ? ` — ${p.description}` : ''}${p.disponible === false ? ' [épuisé]' : ''}`
        ).join('\n');
        const messagesEnvoyes = [
          { role: 'system', content: `Tu es Léa, l'assistante virtuelle du menu de "${commercant.nom}". Tu réponds en ${langueTexte}, de façon courte, amicale et utile. Tu ne connais QUE les informations du menu ci-dessous — si on te demande autre chose (hors-sujet), dis poliment que tu ne peux répondre qu'aux questions sur le menu. Ne donne jamais d'information médicale ferme sur les allergènes, invite plutôt à vérifier directement avec le commerçant si c'est important. Reste bref (2-3 phrases maximum).\n\nMenu actuel :\n${listeProduits || 'Aucun produit pour le moment.'}` },
          ...(Array.isArray(historique) ? historique.slice(-10) : []),
        ];
        const reponseGroq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: messagesEnvoyes,
            temperature: 0.6,
            max_tokens: 200,
          }),
        });
        if (!reponseGroq.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erreur: 'Erreur du service IA. Réessaie dans un instant.' }));
        }
        const data = await reponseGroq.json();
        const reponseTexte = data.choices?.[0]?.message?.content?.trim() || '';
        messagesChatAujourdhui.set(cleLimite, compteur + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ reponse: reponseTexte }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erreur: 'Erreur inattendue.' }));
      }
    });
    return;
  }

  // --- Formulaire de connexion ---
  if (chemin === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageLogin(null));
  }

  // --- Page d'inscription ---
  if (chemin === '/signup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageSignup(null));
  }

  // --- Traitement de l'inscription ---
  if (chemin === '/signup' && req.method === 'POST') {
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { nom, motdepasse, telephonePaiement, typeActivite, email } = querystring.parse(corps);

      if (!nom || !motdepasse || motdepasse.length < 6) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageSignup('Nom du commerce et mot de passe (6 caractères min.) requis.'));
      }

      const emailPropre = (email || '').toLowerCase().trim();
      const db = lireDB();
      db.emailsBannis = db.emailsBannis || [];
      if (emailPropre && db.emailsBannis.includes(emailPropre)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageSignup("Ce compte Gmail n'est plus autorisé à s'inscrire."));
      }

      // On transforme le nom en identifiant simple pour l'adresse (slug)
      let slugBase = nom
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      if (!slugBase) slugBase = 'commerce';

      let slug = slugBase;
      let compteur = 2;
      while (db.commercants[slug]) {
        slug = `${slugBase}-${compteur}`;
        compteur++;
      }

      const { sel, hash } = creerHachage(motdepasse);
      db.commercants[slug] = {
        nom,
        sel,
        motDePasseHash: hash,
        telephonePaiement: telephonePaiement || '',
        typeActivite: typeActivite || 'autre',
        email: emailPropre,
        dateInscription: new Date().toISOString(),
        plan: 'basique',
        produits: [{ nom: 'Exemple de produit', prix: 1000 }],
      };
      ecrireDB(db);

      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = slug;
      res.writeHead(302, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${DUREE_COOKIE}`,
        Location: '/dashboard',
      });
      return res.end();
    });
    return;
  }

  // --- Traitement de la connexion ---
  if (chemin === '/login' && req.method === 'POST') {
    const ip = adresseIP(req);
    if (estBloque(ip)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageLogin('Trop de tentatives. Réessaie dans quelques minutes.'));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug, motdepasse } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];

      if (!commercant || !verifierMotDePasse(motdepasse, commercant.sel, commercant.motDePasseHash)) {
        enregistrerEchec(ip);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageLogin('Identifiant ou mot de passe incorrect.'));
      }

      if (commercant.suspendu) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageLogin('Ce compte est suspendu. Contactez KAVIO pour plus d\'informations.'));
      }

      reinitialiserTentatives(ip);
      commercant.derniereConnexion = new Date().toISOString();
      ecrireDB(db);
      const token = crypto.randomBytes(24).toString('hex');
      sessions[token] = slug;
      res.writeHead(302, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${DUREE_COOKIE}`,
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

  // --- Connexion admin (espace propriétaire) ---
  if (chemin === '/admin' && req.method === 'GET') {
    if (adminConnecte(req)) {
      const db = lireDB();
      const derniereVisite = db.derniereVisiteAdmin ? new Date(db.derniereVisiteAdmin) : new Date(0);
      const nouvelles = Object.values(db.commercants).filter(
        c => c.dateInscription && new Date(c.dateInscription) > derniereVisite
      ).length;
      db.derniereVisiteAdmin = new Date().toISOString();
      ecrireDB(db);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageAdmin(db, nouvelles));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageAdminLogin(null));
  }

  if (chemin === '/admin' && req.method === 'POST') {
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { motdepasse } = querystring.parse(corps);
      if (!verifierMotDePasse(motdepasse, ADMIN_SEL, ADMIN_HASH)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(pageAdminLogin('Mot de passe incorrect.'));
      }
      const token = crypto.randomBytes(24).toString('hex');
      sessionsAdmin[token] = true;
      res.writeHead(302, { 'Set-Cookie': `sessionAdmin=${token}; HttpOnly; Path=/; Max-Age=${DUREE_COOKIE}`, Location: '/admin' });
      return res.end();
    });
    return;
  }

  if (chemin === '/admin/logout') {
    const cookies = lireCookies(req);
    delete sessionsAdmin[cookies.sessionAdmin];
    res.writeHead(302, { 'Set-Cookie': 'sessionAdmin=; Path=/; Max-Age=0', Location: '/admin' });
    return res.end();
  }

  if (chemin === '/admin/suspendre' && req.method === 'POST') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug } = querystring.parse(corps);
      const db = lireDB();
      if (db.commercants[slug]) {
        db.commercants[slug].suspendu = !db.commercants[slug].suspendu;
        ecrireDB(db);
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    });
    return;
  }

  // --- Télécharger une sauvegarde de la base de données (admin uniquement) ---
  if (chemin === '/admin/sauvegarde' && req.method === 'GET') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    const db = lireDB();
    const contenu = JSON.stringify(db, null, 2);
    const dateFichier = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="kavio-sauvegarde-${dateFichier}.json"`,
    });
    return res.end(contenu);
  }

  // --- Changer le plan d'un commerçant (basique <-> avancé) ---
  if (chemin === '/admin/plan' && req.method === 'POST') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug } = querystring.parse(corps);
      const db = lireDB();
      if (db.commercants[slug]) {
        db.commercants[slug].plan = (db.commercants[slug].plan === 'avance') ? 'basique' : 'avance';
        ecrireDB(db);
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    });
    return;
  }

  // --- Activer/désactiver l'IA (description auto) pour un commerçant ---
  if (chemin === '/admin/ia' && req.method === 'POST') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug } = querystring.parse(corps);
      const db = lireDB();
      if (db.commercants[slug]) {
        db.commercants[slug].iaActivee = !db.commercants[slug].iaActivee;
        ecrireDB(db);
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    });
    return;
  }

  // --- Chat IA "Léa" pour l'admin (Brahim) : pas de limite, accès aux données des commerçants ---
  if (chemin === '/admin/chat' && req.method === 'POST') {
    if (!adminConnecte(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Non connecté en admin.' }));
    }
    if (!process.env.GROQ_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Clé IA non configurée sur le serveur.' }));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', async () => {
      try {
        const { historique } = JSON.parse(corps || '{}');
        const db = lireDB();
        const resume = Object.entries(db.commercants).map(([slug, c]) => {
          const derniereConnexion = c.derniereConnexion ? new Date(c.derniereConnexion).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais connecté';
          const dateInscription = c.dateInscription ? new Date(c.dateInscription).toLocaleDateString('fr-FR') : 'inconnue';
          return `- ${c.nom} (slug: ${slug}) | plan: ${c.plan || 'basique'} | IA: ${c.iaActivee ? 'activée' : 'désactivée'} | suspendu: ${c.suspendu ? 'oui' : 'non'} | produits: ${(c.produits || []).length} | inscrit le: ${dateInscription} | dernière connexion: ${derniereConnexion}`;
        }).join('\n');
        const messagesEnvoyes = [
          { role: 'system', content: `Tu es Léa, l'assistante privée de Brahim, le propriétaire de KAVIO (SaaS de menus digitaux QR code). Tu réponds en français, de façon claire et directe. Tu as accès à la liste de ses commerçants ci-dessous pour répondre à ses questions (connexions, plans, statut IA, etc.). Ne donne jamais de conseil hors-sujet non demandé.\n\nListe des commerçants :\n${resume || 'Aucun commerçant inscrit pour le moment.'}` },
          ...(Array.isArray(historique) ? historique.slice(-14) : []),
        ];
        const reponseGroq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: messagesEnvoyes,
            temperature: 0.5,
            max_tokens: 400,
          }),
        });
        if (!reponseGroq.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erreur: 'Erreur du service IA. Réessaie dans un instant.' }));
        }
        const data = await reponseGroq.json();
        const reponseTexte = data.choices?.[0]?.message?.content?.trim() || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ reponse: reponseTexte }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erreur: 'Erreur inattendue.' }));
      }
    });
    return;
  }

  // --- Bannir un email pour empêcher la recréation d'un compte ---
  if (chemin === '/admin/bannir-email' && req.method === 'POST') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { email } = querystring.parse(corps);
      const emailPropre = (email || '').toLowerCase().trim();
      const db = lireDB();
      db.emailsBannis = db.emailsBannis || [];
      if (emailPropre && !db.emailsBannis.includes(emailPropre)) {
        db.emailsBannis.push(emailPropre);
        ecrireDB(db);
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    });
    return;
  }
  if (chemin === '/admin/supprimer' && req.method === 'POST') {
    if (!adminConnecte(req)) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { slug } = querystring.parse(corps);
      const db = lireDB();
      if (db.commercants[slug]) {
        delete db.commercants[slug];
        ecrireDB(db);
      }
      // Déconnecte immédiatement toute session ouverte pour ce commerçant supprimé
      for (const token in sessions) {
        if (sessions[token] === slug) delete sessions[token];
      }
      res.writeHead(302, { Location: '/admin' });
      return res.end();
    });
    return;
  }

  // --- Tableau de bord (protégé : il faut être connecté) ---
  if (chemin === '/dashboard' && req.method === 'GET') {
    const slug = slugDepuisRequete(req);
    if (!slug) {
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant || commercant.suspendu) {
      delete sessions[lireCookies(req).session];
      res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Max-Age=0', Location: '/login' });
      return res.end();
    }
    const langue = url.searchParams.get('lang') || 'fr';
    const limiteAtteinte = url.searchParams.get('erreur') === 'limite';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageDashboard(commercant, slug, req.headers.host, langue, null, limiteAtteinte));
  }

  // --- Générer le QR code d'une table précise ---
  // --- Téléchargement fiable du QR code (proxy via notre serveur, marche sur tous les navigateurs) ---
  if (chemin === '/dashboard/qrcode-telecharger' && req.method === 'GET') {
    const slug = url.searchParams.get('slug');
    const table = url.searchParams.get('table') || '';
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) { res.writeHead(404); return res.end(); }
    const hote = req.headers.host;
    const lienMenu = table ? `https://${hote}/menu/${slug}?table=${encodeURIComponent(table)}` : `https://${hote}/menu/${slug}`;
    const couleurQr = (commercant.couleurTheme || '#5B6EF5').replace('#', '');
    const urlQr = `https://api.qrserver.com/v1/create-qr-code/?size=600x600&color=${couleurQr}&data=${encodeURIComponent(lienMenu)}`;
    const nomFichier = table ? `qrcode-${slug}-${table}.png` : `qrcode-${slug}.png`;
    try {
      const reponseQr = await fetch(urlQr);
      const tampon = Buffer.from(await reponseQr.arrayBuffer());
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${nomFichier}"`,
      });
      return res.end(tampon);
    } catch (e) {
      res.writeHead(302, { Location: urlQr });
      return res.end();
    }
  }

  // --- Version imprimable du QR code (grand format, prêt pour affichage papier / PDF) ---
  if (chemin.match(/^\/menu\/[^/]+\/qrcode-imprimer$/) && req.method === 'GET') {
    const slug = chemin.replace('/menu/', '').replace('/qrcode-imprimer', '');
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageErreur('Ce commerçant n\'existe pas.', 404));
    }
    const hote = req.headers.host;
    const lienMenu = `https://${hote}/menu/${slug}`;
    const couleurQr = (commercant.couleurTheme || '#5B6EF5').replace('#', '');
    const urlQr = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&color=${couleurQr}&data=${encodeURIComponent(lienMenu)}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${commercant.nom} — QR code</title>
<style>
  body { font-family: Georgia, serif; text-align: center; max-width: 480px; margin: 50px auto; color: #1a1a1a; }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  p { color: #555; margin-top: 0; }
  img { margin: 30px 0; border: 10px solid #1a1a1a; border-radius: 8px; }
  .bouton-imprimer { display: block; margin: 0 auto 20px; padding: 10px 20px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
  .consigne { font-size: 0.85rem; color: #888; margin-top: 20px; }
  @media print { .bouton-imprimer { display: none; } }
</style>
</head>
<body>
  <button class="bouton-imprimer" onclick="window.print()">🖨️ Imprimer / Enregistrer en PDF</button>
  <h1>${commercant.nom}</h1>
  <p>Scannez pour voir le catalogue</p>
  <img src="${urlQr}" alt="QR code ${commercant.nom}" width="380" height="380">
  <p class="consigne">Généré via KAVIO</p>
</body>
</html>`);
  }

  if (chemin === '/dashboard/qr-table' && req.method === 'GET') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    const nomTable = url.searchParams.get('nom') || '';
    const lien = `https://${req.headers.host}/menu/${slug}?table=${encodeURIComponent(nomTable)}`;
    const urlQr = `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(lien)}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QR code — ${nomTable}</title>${FAVICON}<link rel="stylesheet" href="/style.css"></head>
<body class="fond-braise">
  <main class="auth-page">
    <div class="auth-card" style="text-align:center;">
      <span class="eyebrow">${nomTable}</span>
      <h1 style="margin-bottom:20px;">QR code de cette table</h1>
      <img src="${urlQr}" alt="QR code ${nomTable}" width="260" height="260" style="border-radius:4px; border:6px solid var(--cream-100);">
      <a href="/dashboard/qrcode-telecharger?slug=${slug}&table=${encodeURIComponent(nomTable)}&lang=fr" class="btn-primary" style="display:block; margin-top:20px;">Télécharger</a>
      <a href="/dashboard" class="lien-discret" style="display:block; margin-top:14px;">← Retour au tableau de bord</a>
    </div>
  </main>
</body>
</html>`);
  }

  // --- Modifier un produit existant ---
  if (chemin === '/dashboard/update' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { index, nom, prix, photo, categorie, description, disponible, heureDebut, heureFin, stock, prixPromo } = querystring.parse(corps);
      const db = lireDB();
      const stockValeur = stock !== undefined && stock !== '' ? Number(stock) : null;
      const promoValeur = prixPromo !== undefined && prixPromo !== '' && Number(prixPromo) > 0 && Number(prixPromo) < Number(prix) ? Number(prixPromo) : null;
      const ancien = db.commercants[slug].produits[Number(index)] || {};
      const historique = ancien.historiquePrix || [];
      if (ancien.prix !== undefined && Number(ancien.prix) !== Number(prix)) {
        historique.push({ date: new Date().toISOString(), ancienPrix: ancien.prix, nouveauPrix: Number(prix) });
        if (historique.length > 10) historique.shift(); // on garde seulement les 10 derniers changements
      }
      db.commercants[slug].produits[Number(index)] = { nom, prix: Number(prix), prixPromo: promoValeur, photo: photo || '', categorie: categorie || '', description: description || '', disponible: stockValeur !== null && stockValeur <= 0 ? false : disponible === 'on', heureDebut: heureDebut || '', heureFin: heureFin || '', stock: stockValeur, dateAjout: ancien.dateAjout, historiquePrix: historique };
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
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
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
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
      const { nom, prix, photo, categorie, description, heureDebut, heureFin, stock } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];
      const limite = LIMITES_PLAN[commercant.plan || 'basique'] || LIMITES_PLAN.basique;
      if (commercant.produits.length >= limite) {
        res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}&erreur=limite` });
        return res.end();
      }
      commercant.produits.push({ nom, prix: Number(prix), photo: photo || '', categorie: categorie || '', description: description || '', heureDebut: heureDebut || '', heureFin: heureFin || '', stock: stock !== undefined && stock !== '' ? Number(stock) : null, dateAjout: Date.now() });
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      res.end();
    });
    return;
  }

  // --- Générer une description de produit avec l'IA (Groq) ---
  if (chemin === '/dashboard/ia-description' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ erreur: 'Non connecté.' })); }
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant || !commercant.iaActivee) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'IA non activée sur ce compte.' }));
    }
    if (!process.env.GROQ_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Clé IA non configurée sur le serveur.' }));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', async () => {
      try {
        const { nom, categorie } = JSON.parse(corps || '{}');
        const langue = url.searchParams.get('lang') || 'fr';
        const langueTexte = langue === 'ar' ? 'arabe' : (langue === 'en' ? 'anglais' : 'français');
        const reponseGroq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: [
              { role: 'system', content: `Tu écris de courtes descriptions appétissantes pour des menus de commerçants, en ${langueTexte}. Une seule phrase, 15 mots maximum, sans guillemets, sans emoji.` },
              { role: 'user', content: `Produit : ${nom}${categorie ? ` (catégorie : ${categorie})` : ''}` },
            ],
            temperature: 0.8,
            max_tokens: 60,
          }),
        });
        if (!reponseGroq.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erreur: 'Erreur du service IA. Réessaie dans un instant.' }));
        }
        const data = await reponseGroq.json();
        const description = data.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, '') || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ description }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erreur: 'Erreur inattendue.' }));
      }
    });
    return;
  }

  // --- Chat Léa pour le commerçant lui-même (max 10 messages/jour) ---
  if (chemin === '/dashboard/lea' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ erreur: 'Non connecté.' })); }
    const db = lireDB();
    const commercant = db.commercants[slug];
    if (!commercant || !commercant.iaActivee) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'IA non activée sur ce compte.' }));
    }
    if (!process.env.GROQ_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Clé IA non configurée sur le serveur.' }));
    }
    const cleLimite = `${slug}:${new Date().toDateString()}`;
    const compteur = messagesLeaCommercantAujourdhui.get(cleLimite) || 0;
    if (compteur >= 10) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ erreur: 'Limite de 10 messages atteinte pour aujourd\'hui. Reviens demain !' }));
    }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', async () => {
      try {
        const { historique } = JSON.parse(corps || '{}');
        const langue = url.searchParams.get('lang') || 'fr';
        const langueTexte = langue === 'ar' ? 'arabe' : (langue === 'en' ? 'anglais' : 'français');
        const listeProduits = (commercant.produits || []).map(p => `- ${p.nom} : ${p.prix} F${p.categorie ? ` (${p.categorie})` : ''}`).join('\n');
        const messagesEnvoyes = [
          { role: 'system', content: `Tu es Léa, l'assistante privée du commerçant "${commercant.nom}" sur KAVIO. Tu réponds en ${langueTexte}, de façon brève et utile (idées de description, conseils simples sur son menu, etc.). Tu ne donnes pas de conseils hors-sujet non demandés.\n\nSon menu actuel :\n${listeProduits || 'Aucun produit pour le moment.'}` },
          ...(Array.isArray(historique) ? historique.slice(-10) : []),
        ];
        const reponseGroq = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'openai/gpt-oss-120b',
            messages: messagesEnvoyes,
            temperature: 0.6,
            max_tokens: 200,
          }),
        });
        if (!reponseGroq.ok) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ erreur: 'Erreur du service IA. Réessaie dans un instant.' }));
        }
        const data = await reponseGroq.json();
        const reponseTexte = data.choices?.[0]?.message?.content?.trim() || '';
        messagesLeaCommercantAujourdhui.set(cleLimite, compteur + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ reponse: reponseTexte, restant: 10 - (compteur + 1) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ erreur: 'Erreur inattendue.' }));
      }
    });
    return;
  }

  // --- Changer son mot de passe ---
  if (chemin === '/dashboard/mot-de-passe' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    const langue = url.searchParams.get('lang') || 'fr';
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { motdepasse } = querystring.parse(corps);
      const db = lireDB();
      let message;
      if (!motdepasse || motdepasse.length < 6) {
        message = 'Le mot de passe doit faire au moins 6 caractères.';
      } else {
        const { sel, hash } = creerHachage(motdepasse);
        db.commercants[slug].sel = sel;
        db.commercants[slug].motDePasseHash = hash;
        ecrireDB(db);
        message = 'Mot de passe modifié avec succès.';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageDashboard(db.commercants[slug], slug, req.headers.host, langue, message));
    });
    return;
  }

  // --- Modifier le numéro Mobile Money ---
  if (chemin === '/dashboard/paiement' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { montant, note } = querystring.parse(corps);
      const db = lireDB();
      const commercant = db.commercants[slug];
      commercant.paiements = commercant.paiements || [];
      commercant.paiements.push({ montant: Number(montant), note: note || '', date: Date.now() });
      if (commercant.paiements.length > 500) commercant.paiements = commercant.paiements.slice(-500);
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      res.end();
    });
    return;
  }

  if (chemin === '/dashboard/fidelite' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { numero, nom } = querystring.parse(corps);
      const numeroPropre = (numero || '').replace(/[^0-9]/g, '');
      if (!numeroPropre) { res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` }); return res.end(); }
      const db = lireDB();
      const commercant = db.commercants[slug];
      commercant.fidelite = commercant.fidelite || {};
      const existant = commercant.fidelite[numeroPropre] || { points: 0, nom: '' };
      commercant.fidelite[numeroPropre] = { points: existant.points + 1, nom: nom || existant.nom || '' };
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      res.end();
    });
    return;
  }

  if (chemin === '/dashboard/telephone' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { telephonePaiement } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].telephonePaiement = telephonePaiement || '';
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      return res.end();
    });
    return;
  }

  if (chemin === '/dashboard/theme' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { couleur } = querystring.parse(corps);
      const db = lireDB();
      // On valide que c'est bien un code hex (#RRGGBB) avant d'enregistrer
      const couleurValide = /^#[0-9a-fA-F]{6}$/.test(couleur) ? couleur : '#5B6EF5';
      db.commercants[slug].couleurTheme = couleurValide;
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      return res.end();
    });
    return;
  }

  if (chemin === '/dashboard/domaine' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { domaine } = querystring.parse(corps);
      const db = lireDB();
      const domainePropre = (domaine || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      db.commercants[slug].domainePersonnalise = domainePropre;
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      return res.end();
    });
    return;
  }

  if (chemin === '/dashboard/apropos' && req.method === 'POST') {
    const slug = slugDepuisRequete(req);
    if (!slug) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    let corps = '';
    req.on('data', chunk => (corps += chunk));
    req.on('end', () => {
      const { adresse, horaires, instagram, facebook, photoProfil } = querystring.parse(corps);
      const db = lireDB();
      db.commercants[slug].adresse = adresse || '';
      db.commercants[slug].horaires = horaires || '';
      db.commercants[slug].instagram = instagram || '';
      db.commercants[slug].facebook = facebook || '';
      db.commercants[slug].photoProfil = photoProfil || '';
      ecrireDB(db);
      res.writeHead(302, { Location: `/dashboard?lang=${url.searchParams.get('lang') || 'fr'}` });
      return res.end();
    });
    return;
  }

  // --- Page d'accueil : présentation, avant de se connecter ---
  if (chemin === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(pageAccueil(req.headers.host));
  }

  // --- Rien trouvé ---
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(pageErreur('Page introuvable.', 404));
});

// ------------------------------------------------------------
// SEED : crée automatiquement le compte de démo "Le Bon Soin"
// au premier démarrage, pour préparer une visite commerciale.
// Ne fait rien si le compte existe déjà (donc sans danger si le
// serveur redémarre plusieurs fois, ou si le commerçant a déjà
// commencé à modifier son compte).
// ------------------------------------------------------------
function creerCompteDemoLeBonSoin() {
  const db = lireDB();
  if (db.commercants['le-bon-soin']) return; // déjà créé, on ne touche à rien
  db.commercants['le-bon-soin'] = {
    nom: 'Le Bon Soin',
    sel: '7aa0fb9a7a395e7ab3550e11296ad010',
    motDePasseHash: '343026ca2bad77c072f0f12bca87491436541a6de44e1234166ed84e3f6a739b3928f43c5dc58c8a7618ddbbb553e5328c80f5b7853886465c52c66187a4a5bd',
    telephonePaiement: '',
    typeActivite: 'boutique',
    email: '',
    dateInscription: new Date().toISOString(),
    plan: 'basique',
    couleurTheme: '#B8860B',
    adresse: "En face de Hec-Tchad, N'Djaména",
    horaires: '',
    instagram: '',
    facebook: '',
    produits: [
      { nom: "Lait d'urgence effet injection 430ml", prix: 8000, prixPromo: null, photo: '', categorie: '', description: '', disponible: true, stock: null, dateAjout: Date.now() },
      { nom: 'Crème éclaircissante visage', prix: 5000, prixPromo: null, photo: '', categorie: '', description: '', disponible: true, stock: null, dateAjout: Date.now() },
      { nom: 'Huile de soin corps', prix: 4500, prixPromo: null, photo: '', categorie: '', description: '', disponible: true, stock: null, dateAjout: Date.now() },
      { nom: 'Lotion corporelle Juan', prix: 6000, prixPromo: null, photo: '', categorie: '', description: '', disponible: true, stock: null, dateAjout: Date.now() },
      { nom: 'Soin des pieds spa', prix: 5000, prixPromo: null, photo: '', categorie: '', description: '', disponible: true, stock: null, dateAjout: Date.now() },
    ],
  };
  ecrireDB(db);
  console.log('Compte démo "Le Bon Soin" créé (identifiant: le-bon-soin, mot de passe: lebonsoin2026)');
}
creerCompteDemoLeBonSoin();

serveur.listen(PORT, () => {
  console.log(`Serveur démarré : http://localhost:${PORT}`);
  console.log(`Page de connexion : http://localhost:${PORT}/login`);
});

module.exports = { creerHachage }; // utilisé par creer-compte.js
