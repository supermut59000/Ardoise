# Security audit — Ardoise (contexte persistant)

> **Si tu es en train de travailler sur l'audit sécurité d'Ardoise : lis ce fichier d'abord, et mets-le à jour à chaque étape.** Il survit aux compactions.

## Objectif

L'instance publique `https://ardoise.ouiouibaguette.fr/` est exposée sur internet.
Trouver **toutes les vulnérabilités que l'utilisateur n'a pas vues** pour renforcer
l'app par la suite. Livrable : évaluation classée par impact, **pas** les corrections
(ça vient seulement si l'utilisateur le demande).

Méthode : skill `/app-audit` — contexte d'abord, code en lecture complète, chaque
finding validé par un scénario concret dérivé du code réel (phase 6).

## Contraintes / philosophie

- Instance "moi + amis de confiance", `API_KEY` partagé, pas de comptes par utilisateur.
- Risques **déjà acceptés et documentés** (DEPLOY.md "Accepted risks" + D40) : pas
  d'authz par utilisateur, pas de rate limiting, pas de validation serveur du contenu
  des ops, QR = bearer credential réutilisable. → On cherche ce qui est en DEÇÀ de ça.
- Topologie : Caddy (WAN) → frontend:3060 (LAN, nginx) → backend:8000 → MariaDB.
  Backend + MariaDB non publiés. `DEBUG=false` censé couper /docs.
- Ledger : `context/03_decisions.md` (D1–D41).

## État

- [x] Lecture docs + backend complet + frontend surface + infra
- [x] Decision ledger + risques acceptés
- [x] Secrets dans l'historique git (→ rien, que des exemples)
- [x] Sondage live (register/push/pull/subscribe/documents/headers/body caps)
- [x] Phase 6 : scénarios concrets construits et testés live
- [x] Rapport final (ci-dessous)

## FINDINGS (classés par impact)

### F1 — CRITIQUE — L'auth est DÉSACTIVÉE en production (API_KEY vide)

Preuve live (2026-08-26, sans aucune clé) :
- `POST /api/v1/groups/register` → **200** (a créé un vrai groupe, id `58c8152e-fc29-439a-aece-e5a49b0e915a`, code `ZHNC6CJB`)
- `POST /api/v1/groups/{id}/ops` → **200** `{"accepted":1,"cursor":121}` (op injectée, donnée réelle présente : cursor global 121)
- `GET /api/v1/groups/{id}/ops?since=0` → **200** (op relue)
- `GET /api/v1/groups/resolve/{code}` → **200/404** (oracle de code ouvert)
- `POST /api/v1/push/subscribe` + `unsubscribe` → **200** (VAPID public key servie = push ACTIF)
- `GET /api/v1/system/auth-check` (sans clé) → **200** → le dialogue "Mot de passe" de
  l'app valide **n'importe quelle chaîne** : l'utilisateur croit que le mot de passe
  marche, alors que le serveur n'en exige aucun.

Cause (code) : `backend/app/api/deps.py` `require_api_key` est un no-op quand
`settings.API_KEY` est vide ; `config.py` default `API_KEY=""`.

**Diagnostic précis (confirmé avec l'utilisateur)** : la clé EST définie dans
`backend/.env` sur le serveur, mais elle est MASQUÉE. Chaîne : compose interpole
`API_KEY=${API_KEY:-}` depuis le `.env` RACINE (à côté de docker-compose.yml) ;
celui-ci n'ayant pas la clé, compose injecte l'env var **vide** dans le
conteneur ; dans pydantic-settings (`env_file=".env"`), l'env var (même vide)
a priorité sur la valeur du fichier `.env` monté. → `settings.API_KEY == ""`.
Vérif serveur : `docker inspect ardoise-backend --format
'{{range .Config.Env}}{{println .}}{{end}}' | grep API_KEY` (attendu : vide).
Fix : clé dans le `.env` RACINE, `docker compose up -d backend` (recreate, pas
restart), tous les appareils ré-entrent la clé. Une seule source de vérité :
le `.env` racine (DEPLOY.md).

Impact : lecture/écriture de TOUS les groupes dont le code de partage est connu
(les amis ont les QR/links ; photo/screenshot/collège de scan = accès complet :
toutes les dépenses + injection de fausses dépenses/membres visibles par tout le
monde du groupe + spam des notifications push). N'importe qui peut aussi polluer
la base avec des groupes/ops poubelle (pas de rate limit).

Fix : sur le serveur — `API_KEY=$(openssl rand -base64 32)` dans le `.env` à côté
du docker-compose, `docker compose up -d backend`, TOUS les appareils ré-entrent
le mot de passe une fois (menu → Mot de passe du serveur). Vérifier ensuite :
`resolve` sans clé → 401, `auth-check` avec clé fausse → 401. Le mot de passe
saisi avant ne vaut rien : les anciennes entrées sont des chaînes aléatoires
acceptées par le no-op (à ré-entrer partout).

### F2 — HAUT — Avec F1, le code de partage 8 chars EST la seule clé

Concrètement : un QR vu/photographié (risque déjà accepté en D40, qui prévoyait
clé + code) suffit désormais seul pour lire tout l'historique d'un groupe et
y écrire. L'oracle `resolve` est ouvert mais l'énumération complète 31^8 ≈ 8,5e11
n'est PAS faisable à un débit raisonnable (~20 ans à 100 connexions parallèles,
73 ms/req mesuré) → l'attaque réelle est "code vu quelque part", pas brute force.
Se résorbe avec F1.

### F3 — MOYEN — Push actif + subscribe ouvert (conséquence F1)

VAPID configuré sur l'instance (`/push/vapid-public-key` → 200 avec vraie clé
publique). Quiconque connaît un code de groupe peut pousser des ops → fan-out de
notifications push vers TOUS les abonnés du groupe (spam téléphonique). Avec F1
corrigé, ce point rentre dans la frontière de confiance acceptée.

### F4 — MOYEN — Image backend potentiellement antérieure au bump CVE (D41)

D41 a bumpé fastapi 0.141.1 / starlette ≥1.0.1 (CVE-2026-48710 BadHost) et
demande un rebuild de l'image. Le build frontend date du 2026-08-13 (jour de D41),
mais le backend n'est pas vérifiable à distance. À faire sur le serveur :
`docker compose build --pull && docker compose up -d` puis dans le conteneur
`python -c "import starlette; print(starlette.__version__)"` → attendu ≥1.0.1.

### F5 — BAS — Pas de CSP

Aucun header Content-Security-Policy (headers live : HSTS preload ✓, XFO ✓,
nosniff ✓, referrer-policy ✓, Permissions-Policy ✓, mais pas de CSP). Impact bas
(React échappe tout, zéro ressource tierce, zéro `dangerouslySetInnerHTML`),
MAIS D40 note explicitement que "prévenir le XSS fait partie de la frontière"
(clé en localStorage + fragment d'invite lisibles par un script sur l'origine).
Une CSP paranoïaque est un tripwire bon marché :
`default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self'; manifest-src 'self'`
(à tester sur l'app : styles inline Tailwind v4, fonts locales).

### F6 — INFO — Header légué `X-XSS-Protection: 1; mode=block`

Déjà noté en D33 (OWASP recommande de le retirer). 1 ligne dans le snippet Caddy
partagé : `header - X-XSS-Protection`.

### F7 — INFO / à nettoyer — Artefacts d'audit dans la base

Groupe de test `58c8152e-fc29-439a-aece-e5a49b0e915a` (code `ZHNC6CJB`, 1 op
"AUDIT-TEST-GROUP-IGNORE-ME") créé pendant l'audit ; le subscribe test a été
dés-abonné proprement. Cleanup SQL (si désiré) :
```sql
DELETE FROM groups WHERE id = '58c8152e-fc29-439a-aece-e5a49b0e915a';
DELETE FROM operations WHERE group_id = '58c8152e-fc29-439a-aece-e5a49b0e915a';
```
Attention : si des ops poubelle ont été injectées par d'autres avant la correction
de F1, elles sont DANS le log et déjà foldées sur les appareils des amis →
nettoyer la base + "quitter/rejoindre" du groupe sur les appareils.

## Round 2 — offensive (2026-08-26) — RÉSULTATS

**F1 corrigée par l'utilisateur entre les 2 rounds** : toutes les routes sync/
push/system-auth-check renvoient 401 sans clé. Seuls `ping`/`health` restent
ouverts (by design). La surface sans clé = exactement la frontière documentée
en DEPLOY.md.

Durcissements confirmés live (sans clé) :
- CORS : origine malveillante → pas de `Access-Control-Allow-Origin` (preflight
  400) ; le browser bloque la lecture cross-origin. ✓
- URL de 100 Ko → connexion coupée au proxy (limite nginx/Caddy). ✓
- `..%2f` path-as-is → 400 nginx. ✓ · méthode inconnue → 405. ✓
- `/docs`, `/openapi.json` → fallback SPA (docs fermées). ✓

Reste à tester AVEC clé (script `scripts/security-probe.sh`, à lancer sur le
serveur — l'utilisateur doit coller la sortie) : overflow int (F8a/b),
NaN/Infinity (F8c), gros batch 20k ops (F9).

### F8 — MOYEN — Ints non bornés → 500 → sync d'un appareil briqué (à confirmer via le script)

`OperationWire.lamport` / `.created_at` sont `int` SANS bornes (sync.py).
Python n'a pas d'int 64 bits : 10^40 passe Pydantic, puis MariaDB rejette le
BIGINT en commit → 500, rollback, rien stocké. Mais le client (engine.ts)
ré-essaie le MÊME batch toutes les 20 s pour toujours : un appareil dont le log
contient une telle op (fichier d'import édité — la validation d'import B2 ne
vérifie QUE amountCents/weights, pas lamport ; ou client buggy) ne syncera
PLUS JAMAIS ce groupe. Scénario concret : export JSON contenant
`lamport: 10000000000000000000000000000000000000000` → `JSON.parse` donne 1e40,
qui est un double FINI : la validation d'import `Number.isFinite` (export.ts:71)
la LAISSE PASSER → replay → push → 500 pour toujours. (Le import valide la
finité, pas la bornage 64 bits.)
Fix (1-2 lignes) : `Field(ge=0, le=2**63-1)` sur lamport + created_at, et la
même validation dans `parseJsonExport`.

### F9 — INFO — Pas de cap sur le nombre d'ops par batch

`ops: List[OperationWire]` sans max_length ; le seul cap est le body nginx
(~10 Mo ≈ 20-25 k ops). Échelle amis : sans importance. Avec clé fuite :
un script peut faire grossir le log sans limite (seq, stockage, pulls). À
documenter, pas à coder (risque accepté du modèle clé partagée).

### Race opId concurrent → 500 (déjà accepté en D34, ne pas re-proposer)

2 pushes simultanés du même opId : un commit prend la violation d'unicité →
500, auto-guéri au tick suivant. Accepté explicitement, leave as-is.

## Red team (2026-08-27) — nouveaux findings

### F10 — MOYEN-HAUT (avec clé) — Fan-out push sans timeout → épuisement du pool DB → DoS API

Chaîne (vérifiée en code, live en attente du script phase D) :
1. `push_service.py` `_send` appelle `webpush(...)` SANS paramètre timeout.
2. `pywebpush` 2.0.3 (`__init__.py` L344-366) : `requests.post(endpoint, timeout=None)`
   → aucun timeout applicatif ; un endpoint qui accepte le TCP mais ne répond
   jamais bloque INFINIMENT (l'OS ne time out que si la connexion est refusée).
3. `notify_task` ouvre `SessionLocal()` AVANT le fan-out et la garde ouverte
   pendant tout le loop (close en finally) → chaque fan-out bloqué retient une
   connexion du pool (5+10=15, pool_timeout 30 s).
4. Attaque : subscribe un endpoint "hold" pour un groupe G (URL choisie par le
   client, voir F11) → 16 pushes parallèles (même par des AMIS, pas besoin de
   l'attaquant) → 15 sessions retenues → TOUTES les routes qui touchent la DB
   (resolve/register/pull/push) attendent 30 s puis 500. `ping`/`health` (sans
   DB) restent 200 → l'app a l'air "en vie" alors qu'elle est morte.
5. Récupération : tuer le serveur hold → RST → les tâches libèrent → API OK.
   DoS réversible et répétable = le pire des DoS.
Profil : A2 (clé fuitée) ou A3 (n'importe quel appareil ami, la clé est
partagée). Fix (1 ligne) : `timeout=5` dans `_send` (+ optionnellement passer
à `send_async`).

### F11 — MOYEN (avec clé) — SSRF : le serveur POST vers une URL choisie par le client

`_send` → `webpush(subscription_info={"endpoint": subscription.endpoint, ...})`
→ pywebpush poste SANS vérifier le scheme (`http://`, `file://`… tout passe
à requests). L'endpoint vient du body `subscribe` (`Field(max_length=500)`,
aucune validation de scheme). Chaque push au groupe concerné déclenche donc
un POST sortant du SERVEUR vers l'URL de l'attaquant :
- scan de ports du réseau docker/hôte (`http://172.17.0.1:PORT/` — timing : RST
  rapide vs timeout lent),
- POST de données (payload push chiffré, mais headers VAPID visibles) vers des
  services internes,
- combiné avec F10 : l'URL hold est aussi l'arme de DoS.
Même fix que F10 en plus : exiger `https://` dans le schema subscribe
(`field_validator`) — les vrais services push (Mozilla/FCM) sont https.
Preuve live en attente : script phase A (listener 127.0.0.1:8099, endpoint
`http://172.17.0.1:8099/ssrf-proof`, hit logué dans /tmp/rt-ssrf-hit.txt).

### NON-findings red team (vérifiés live 2026-08-27)

- TLS 1.0/1.1 refusés ; 1.2 ECDHE-ECDSA-AES128-GCM, 1.3 AES128-GCM. ✓
- Host header spoofé (evil/localhost/127.0.0.1:8065) → même réponse 200, pas
  de vhost mismatch, pas de fuite. ✓ · XFF/X-Real-IP ignorés (aucune logique). ✓
- Pas de headers de cache sur l'API → pas de cache poisoning 200/401. ✓
- Path fuzzing 24 chemins cachés : que des 404 backend ou fallback SPA. ✓
- `/API/V1/...` (majuscules) = fallback SPA (text/html), `//api//...` atteint
  FastAPI → 404 JSON propre. ✓ · cas-sensitive sur les routes réelles. ✓
- Method tampering PUT/PATCH/DELETE/OPTIONS : 405 uniformes. ✓
- Content-type switching (XML/form/text/plain/bogus charset) : 401 uniforme
  (l'auth précède le parse du body — pas d'oracle 422/401). ✓
- Oracle timing auth-check : p50 ~0.068 s IDENTIQUE sans clé / clé L=1 / L=8 /
  L=32 / L=1000 → `compare_digest` constant-time confirmé. ✓
- Bundle JS 637 KB : aucune URL dev (localhost:8065/8000), pas de `VITE_*`,
  pas de source maps, pas de `process.env`. ✓
- sw.js (workbox 7.4) : n'intercepte PAS /api (pas de cache d'API), handler
  push présent. ✓ · manifest propre.
- Header 100 Ko → coupé par le proxy (limite nginx/Caddy). ✓ · 100 headers OK.
- `/.env`, `/.git/config` → fallback SPA (HTML). ✓
- Port 80 → 308 → https. ✓ · HTTP/1.0 HEAD → 405. ✓
- Port 8099/8098 (listeners du script) : hors périmètre (à fermer si utilisés).

## NON-findings vérifiés (phase 6, ne pas re-auditer)

- Brute force des share codes : 31^8 infeasible (calcul ci-dessus).
- `/docs` + `/api/v1/openapi.json` : les 200 sont le fallback SPA (nginx sert
  index.html) ; la vraie route FastAPI répond 404 → docs bien fermées (DEBUG ok).
- CORS : confiné aux origines localhost, inerte en prod (tout passe en
  same-origin via nginx). Cross-origin avec X-API-Key = bloqué par preflight.
- Body size : 4.6 MB passe (422 valide), ~11.4+ MB → 413. Cap nginx 10m / Caddy
  12MB effectif (le "risque accepté" de taille de payload est en fait couvert).
- Secrets dans git : que des fichiers d'exemple ; `.env` réel jamais committé.
- Injection SQL : tout passe par SQLAlchemy paramétré / Pydantic ; pas de
  raw-string dans les requêtes ; `resolve` fait `.upper()` côté code.
- XSS : pas de `dangerouslySetInnerHTML`, pas de `eval`, pas de `href` dynamique
  avec données utilisateur, SW n'affiche que du texte, QR en data URL.
- SSRF push (endpoint forgé) : derrière la clé → dans la frontière de confiance.
- `X-Forwarded-For` spoofable : aucune logique ne s'en sert.
- VAPID : seule la clé PUBLIQUE est servie.
- `/health`, `/system/ping`, `/` (version 0.1.0) : liveness by design (DEPLOY.md).

## Déjà bien défendu

- Une seule entrée WAN (Caddy), HSTS preload, HTTPS/HTTP3, app 1 origine.
- Backend loopback-only, MariaDB non publiée, pool DB borné (5+10), pool_recycle.
- Constance temps sur la comparaison de clé (`secrets.compare_digest`).
- Validation wire (422 propre, confirmée live) ; dédup par opId idempotent.
- QR : credential dans le fragment (jamais dans les logs HTTP), effacé de la
  barre d'adresse avant appel réseau, même en hashchange (D41).
- Pas de session/cookie, stateless, PWA offline-first → pas de surface de session.
- `sw.js` + `index.html` no-cache, assets hashés immutable.
