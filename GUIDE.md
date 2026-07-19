# Guide — SaaS Menu QR Code

## C'est quoi, dans ce dossier

- `server.js` → le cerveau du site (le backend). Pas besoin d'installer quoi que ce soit, ça marche avec Node.js tout seul.
- `db.json` → le classeur (la base de données). Un tiroir par commerçant.
- `creer-compte.js` → le script pour ajouter un vrai commerçant.
- `public/style.css` → l'apparence des pages.

## Tester sur ton téléphone/PC dès maintenant

```
cd saas-menu
node creer-compte.js chez-fatime "Chez Fatimé" motDePasseSolide123
node server.js
```

Puis ouvre `http://localhost:3000/login` et connecte-toi avec `chez-fatime` / `motDePasseSolide123`.

## Ajouter un vrai commerçant

```
node creer-compte.js <slug> "<Nom affiché>" <mot-de-passe>
```

Le `slug` devient l'adresse publique : `/menu/<slug>` — **c'est ce lien qu'il faut mettre dans le générateur de QR code.**

## Héberger pour de vrai (sans carte bancaire)

1. Va sur **render.com**, crée un compte gratuit (email suffit, pas de carte pour le plan gratuit "Web Service").
2. Mets ce dossier sur GitHub (un compte GitHub gratuit, pas de carte non plus).
3. Sur Render : "New Web Service" → connecte ton dépôt GitHub → Build command : (laisser vide) → Start command : `node server.js`.
4. Render te donne une adresse du genre `tonsite.onrender.com`. C'est cette adresse + `/menu/<slug>` que tu mets dans le QR code.

⚠️ Une limite du plan gratuit Render : le service "s'endort" après 15 minutes sans visite, et met quelques secondes à se réveiller à la prochaine visite. Pour un vrai client payant plus tard, un plan payant règle ça — mais pour démarrer et tester avec HorSolar ou un restaurant, c'est largement suffisant.

⚠️ Autre point important : sur Render, le fichier `db.json` peut être effacé à chaque redémarrage du service (plan gratuit = pas de stockage permanent garanti). Pour un vrai lancement avec plusieurs clients qui comptent sur toi, il faudra passer à une vraie base de données externe (ex: Supabase, qui a aussi un plan gratuit sans carte) plutôt que le fichier `db.json`. Pour tester le concept avec ton premier client, `db.json` suffit très bien.

## Générer le QR code

Une fois l'adresse publique connue (`https://tonsite.onrender.com/menu/chez-fatime`), n'importe quel générateur de QR code gratuit en ligne (qr-code-generator.com par exemple) transforme ce lien en image à imprimer.

## Et après ?

Quand tu veux ajouter un vrai paiement automatique ou un vrai nom de domaine, on en reparle — mais rien de tout ça n'est bloquant pour démarrer avec ton premier client.
