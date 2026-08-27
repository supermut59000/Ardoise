#!/usr/bin/env sh
# Sonde robustesse Ardoise — à exécuter SUR LE SERVEUR, dans le repo.
# Teste l'API auth (via loopback 127.0.0.1:8065) avec la clé du .env racine.
# Tout le contenu d'essai est confiné à UN groupe créé ici ; le SQL de
# nettoyage est affiché à la fin (il n'y a pas d'endpoint de suppression de groupe).
#
# Usage:  sh scripts/security-probe.sh
set -u
B="${BACKEND:-http://127.0.0.1:8065}"
KEY="$(grep -E '^API_KEY=' .env | cut -d= -f2-)"
if [ -z "$KEY" ]; then echo "API_KEY introuvable dans .env racine"; exit 1; fi
H="X-API-Key: $KEY"
J="Content-Type: application/json"
G="$(python3 -c 'import uuid;print(uuid.uuid4())' 2>/dev/null || uuidgen)"
T() { printf '\n### %s\n' "$1"; }
C() { curl -sS --max-time 30 -w '  [HTTP %{http_code}]' "$@"; }

T "0. auth-check (sanity)"
C "$B/api/v1/system/auth-check" -H "$H"; echo

T "0b. register groupe poubelle"
C "$B/api/v1/groups/register" -X POST -H "$H" -H "$J" -d "{\"groupId\":\"$G\"}"; echo

# F8a: lamport qui déborde BIGINT (attendu si vulnérable : 500, jamais stocké)
T "1. lamport = 10^40 (overflow BIGINT)"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{},\"actor\":\"probe\",\"lamport\":10000000000000000000000000000000000000000,\"createdAt\":1}]}"
echo

# F8b: createdAt qui déborde
T "2. createdAt = 10^40"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{},\"actor\":\"probe\",\"lamport\":1,\"createdAt\":10000000000000000000000000000000000000000}]}"
echo

# F8c: NaN / Infinity dans le payload (JSON Python les accepte ; MariaDB JSON ne valide pas à l'INSERT si le type est LONGTEXT)
T "3. NaN / Infinity dans le payload"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')\",\"groupId\":\"$G\",\"entity\":\"expense\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{\"amountCents\":NaN,\"note\":Infinity},\"actor\":\"probe\",\"lamport\":1,\"createdAt\":1}]}"
echo

# F8d: op valide de contrôle (doit faire 200/accepted:1)
T "4. op valide de contrôle"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"$G\",\"action\":\"create\",\"payload\":{\"name\":\"PROBE\"},\"actor\":\"probe\",\"lamport\":1,\"createdAt\":1}]}"
echo

# F9: gros batch (~9 Mo, ~20 000 ops) — combien de temps, tout est-il stocké ?
T "5. batch ~20 000 ops (~9 Mo)"
python3 - "$G" <<'EOF' > /tmp/probe-big.json
import json, sys, uuid
g = sys.argv[1]
ops = [{"opId": str(uuid.uuid4()), "groupId": g, "entity": "group", "entityId": "x",
        "action": "create", "payload": {"name": "p" * 300}, "actor": "probe",
        "lamport": i, "createdAt": 1} for i in range(20000)]
print(json.dumps({"ops": ops}))
EOF
ls -l /tmp/probe-big.json
time C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" --data @/tmp/probe-big.json
echo

T "6. pull depuis 0 (combien d'ops sont passées ?)"
C "$B/api/v1/groups/$G/ops?since=0" -H "$H" | head -c 200; echo

printf '\n--- NETTOYAGE (à exécuter dans MariaDB) ---\n'
printf "DELETE FROM operations WHERE group_id = '%s';\nDELETE FROM groups WHERE id = '%s';\nrm /tmp/probe-big.json\n" "$G" "$G"
