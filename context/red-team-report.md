# Red team — Ardoise

**Cible** : `https://ardoise.ouiouibaguette.fr/` (prod, instance "moi + amis de confiance")
**Date** : 2026-08-27 · **Profil** : grey box (code + infra + probes live)
**Périmètre** : la surface web complète (Caddy → nginx → FastAPI → MariaDB) + PWA. Hors périmètre : le serveur lui-même (OS, Docker daemon), le domaine `ouiouibaguette.fr` au-delà de ce sous-domaine.
**Règles** : non destructif ; toute donnée d'essai confinée dans un groupe poubelle ; les tests avec clé passent par `scripts/red-team-keyed.sh` (à lancer sur le serveur).

---

## Résumé exécutif

L'app a **survécu au red team sans clé** : aucun chemin ne permet à un inconnu de lire
une dépense, écrire une op, ou faire tomber le serveur. L'auth (F1) est active, le
timing est constant, il n'y a ni endpoint caché, ni fuite dans le bundle, ni oracle
par les headers.

Les deux failles restantes sont toutes deux **derrière la clé** (profil "ami ou clé
fuitée") et tournent autour du **fan-out push** :

| # | Finding | Impact | Fix |
|---|---|---|---|
| **F11** | **SSRF** : le serveur POST vers l'URL d'endpoint choisie par l'abonné (`http://` acceptée) | Scan du réseau interne, POST vers des services internes | 1 `field_validator` : exiger `https://` |
| **F10** | **DoS** : `webpush()` sans timeout + session DB retenue pendant le fan-out → 16 endpoints "hold" épuisent le pool (5+10) → toute l'API 500 | Indisponibilité réversible et répétable de TOUS les endpoints DB | 1 mot : `timeout=5` dans `_send` |

Les deux se corrigent en **~3 lignes** dans `backend/`. Avec ces 2 fixes + F8 (bornes
lamport/createdAt) + le rebuild d'image (F4), l'app est, à mon avis, **suffisamment
robuste pour rester exposée** avec le modèle de menace "amis de confiance + 1 clé".

---

## Attaquants et objectifs

| Profil | Objectif | Résultat |
|---|---|---|
| **A0** inconnu (aucun secret) | lire une dépense / écrire une op / crasher le serveur | ❌ échec — 401 partout, surface = {static, ping, health, 401} |
| **A1** connaît un code de partage | lire + écrire le groupe, spam de notifications | ✅ accès complet (par design, D40) ; + F3 spam push |
| **A2** clé fuitée (backup, shoulder) | tout + faire tomber le serveur | ✅ tout, **+ F10 (DoS) + F11 (SSRF)** |
| **A3** appareil ami bugué/malveillant | casser la sync des autres | ✅ **F8** (op poison 10^40 → sync briqué) ; **+ F10** (un seul appareil peut déclencher 16 pushes) |

---

## Findings classés (détails + preuves : `context/security-audit.md`)

### F10 — DoS par fan-out sans timeout — MOYEN-HAUT (A2/A3)

```
subscribe(endpoint=http://hold.example/...) sur le groupe G
→ des pushes au groupe G (attaquant, OU un seul appareil ami qui ré-essaie
   toutes les 20 s : chaque push spawn UNE NOUVELLE tâche, les précédentes
   restant bloquées → 15 sessions accumulées en ~5 min = DoS seule source)
→ N tâches background, chacune : SessionLocal() → _send() → requests.post(timeout=None)
→ N connexions TCP retenues INFINIMENT (le hold accepte mais ne répond jamais)
→ 15 = pool DB saturé (5+10) → la 16e tâche et TOUTES les nouvelles requêtes DB
   attendent pool_timeout=30 s → 500
→ tuer le hold → RST → libération → API revenue. Répétable à l'infini.
```
Preuve code : `push_service.py::_send` (pas de `timeout=`), `pywebpush/__init__.py`
L358 (`requests.post(endpoint, timeout=timeout)` avec `timeout=None` par défaut),
`notify_task` (session ouverte autour du fan-out), `config.py` (pool 5+10, 30 s).
Preuve live : **en attente** — script phase D (hold server 8098, 16 pushes, latence pull).

### F11 — SSRF via l'endpoint push — MOYEN (A2/A3)

L'`endpoint` de subscribe est `str(max_length=500)`, aucune validation de scheme.
`pywebpush` le poste tel quel (requests, `http://` inclus). Chaque push au groupe
concerné = un POST sortant du conteneur backend vers l'URL de l'attaquant.
Cibles intéressantes : `http://172.17.0.1:<port>/` (hôte docker), les autres
conteneurs du bridge. L'oracle = timing (RST rapide vs accept-sans-réponse).
Preuve code : `schemas/push.py` L16, `push_service.py` L146, `pywebpush` L358.
Preuve live : **en attente** — script phase A (listener 8099, hit capturé).

### F8 — Ints non bornés → 500 → sync briqué — MOYEN (A3)

`lamport`/`created_at` sans bornes ; `10^40` passe Pydantic, MariaDB refuse en
commit → 500 ; le client ré-essaie le même batch **pour toujours**. Entrée réelle :
fichier d'import JSON (la validation `Number.isFinite` laisse passer `1e40`,
double fini). Fix : `Field(ge=0, le=2**63-1)` + bornage dans `parseJsonExport`.
Preuve live : en attente — script phase B.

### F1–F7 (audit précédent, statut)

- **F1 (CRITIQUE) corrigée** ✓ — 401 live confirmés partout.
- **F2/F3** — résorbés par F1 (restent "par design" si clé fuitée).
- **F4 (MOYEN, ops)** — rebuild image pour starlette ≥1.0.1 (CVE-2026-48710) :
  **toujours à faire sur le serveur**.
- **F5 (BAS)** — pas de CSP. **F6 (INFO)** — header `X-XSS-Protection`. **F7** —
  nettoyage DB du groupe d'audit.

---

## Ce qui a tenu (matrice de durcissement, tout vérifié live le 27/08)

| Domaine | Résultat |
|---|---|
| TLS | 1.0/1.1 refusés · 1.2 ECDHE-ECDSA-AES128-GCM · 1.3 AES128-GCM · HSTS preload |
| Auth | 401 uniforme · **timing constant** (p50 0.068 s identique clé L=1/8/32/1000) · `compare_digest` |
| Surface | 24 chemins cachés testés : rien · `/docs` fermé · `/.env` `/.git` = SPA |
| Headers | Host spoof sans effet · XFF ignorés · CORS fermé (pas d'ACAO evil origin) · pas de cache sur l'API |
| Protocole | méthodes 405 uniformes · content-type switching 401 uniforme · URL/header 100 Ko coupés · 100 headers OK |
| Frontend | bundle 637 KB sans URL dev ni source maps · SW n'intercepte pas /api · React échappe tout · QR en fragment |
| Wire | validation 422 propre · body cap ~10-12 MB · SQLi path params neutralisés (401/404 paramétrés) |
| Infra | 1 entrée WAN (Caddy) · backend+MariaDB non exposés · port 80 → 308 https |

---

## Actions recommandées (ordre)

1. **Lancer `sh scripts/red-team-keyed.sh` sur le serveur** → coller la sortie
   (confirme F10/F11/F8 live ou infirme).
2. **3 lignes backend** : `timeout=5` dans `_send` (F10) · validator `https://`
   sur `endpoint` (F11) · `Field(ge=0, le=2**63-1)` sur lamport/created_at (F8).
3. **Rebuild image** (F4) : `docker compose build --pull && docker compose up -d`.
4. **CSP + retrait `X-XSS-Protection`** dans le snippet Caddy (F5/F6) — un jour.
5. **Nettoyage DB** (F7 + débris red team, SQL dans le script).

**Verdict** : exposée à l'internet avec le modèle "amis + 1 clé", l'app tient —
**à condition de faire les points 2 et 3**. Sans eux, un ami qui pousse 16 ops en
parallèle (ou un export JSON mal formé) suffit à la faire tomber ou à la griller.
