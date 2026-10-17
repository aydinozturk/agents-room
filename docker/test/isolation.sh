#!/usr/bin/env bash
# Agent başına Linux kullanıcısı modunun kabul testi. Agent imajında root olarak, repo /src'ye bağlıyken çalışır:
#   docker run --rm -u root -v "$PWD":/src:ro --entrypoint bash aydinozturk/agents-room-agent:<sürüm> /src/docker/test/isolation.sh
# Sahte bir token'lı git sunucusu, gerçek agents-room sunucusu ve gerçek entrypoint ile iki işçi başlatır; her işçinin
# "claude" oturumu bir yoklama betiğidir ve sonuçları kendi HOME'una yazar. Sonuç satırları stdout'a basılır.
# "fallback" argümanıyla model girişi ortamdan verilmez: ekip uyarıyla ortak node kullanıcısına döner.
set -euo pipefail
MODE="${1:-isolated}"
export HOME=/root
# Repodaki güncel betikler imajdakilerin yerine.
rm -rf /opt/agents-room/scripts /opt/agents-room/skills
cp -r /src/scripts /src/skills /opt/agents-room/
cp /src/docker/entrypoint.sh /opt/agents-room/docker/entrypoint.sh
chown -R node:node /opt/agents-room
cp -r /src/server /tmp/server

T=/tmp/iso TOKEN=github_pat_isolation_789
mkdir -p $T/git $T/srv /opt/fake
git init -q --bare -b main $T/git/proje.git
git -C $T/git/proje.git config http.receivepack true
node /tmp/server/test/fixtures/git-http-server.ts $T/git $TOKEN > $T/gitport &
until [[ -s $T/gitport ]]; do sleep 0.2; done
GITPORT=$(cat $T/gitport)
AGENTS_ROOM_DB=$T/srv/db.sqlite AGENTS_ROOM_PORT=7700 AGENTS_ROOM_HOST=127.0.0.1 AGENTS_ROOM_ENROLL_SECRET=sir \
  node /tmp/server/src/index.ts > $T/srv.log 2>&1 &
until curl -fs 127.0.0.1:7700/healthz >/dev/null; do sleep 0.3; done

cat > /opt/fake/claude <<'PROBE'
#!/usr/bin/env bash
# Yoklama: agent kullanıcısı olarak neye erişebildiğini yazar ve kendi dalına push eder.
me=$(id -un)
{
  echo "user=$me"
  echo "env=[${AGENTS_ROOM_ENROLL_SECRET:-}${GH_TOKEN:-}${AGENTS_ROOM_GIT_TOKEN:-}${GITHUB_TOKEN:-}]"
  sudo -n true >/dev/null 2>&1 && echo "sudo=yes" || echo "sudo=no"
  for p in $(pgrep -f 'run-agent.sh|team.ts'); do
    o=$(stat -c %U /proc/$p 2>/dev/null) || continue
    [[ "$o" == "$me" ]] && continue
    cat /proc/$p/environ >/dev/null 2>&1 && echo "environ:$o=readable" || echo "environ:$o=denied"
  done
  # Diğer agent'ların kimlik dosyaları (adlar team.json'dan; klasör listelenemediği için yollar açıkça denenir).
  for n in $(node -e 'console.log(JSON.parse(require("fs").readFileSync("/data/workspaces/iso/team.json","utf8")).agents.map(a=>a.name).join(" "))'); do
    [[ "ar-$n" == "$me" ]] && continue
    cat "/home/node/.config/agents-room/teams/iso/$n.env" >/dev/null 2>&1 && echo "envfile:$n=readable" || echo "envfile:$n=denied"
  done
  for d in /data/workspaces/iso/* /data/agents/iso/*; do
    [[ -d "$d" && "$(stat -c %U "$d")" != "$me" && "$(stat -c %U "$d")" != root ]] || continue
    ls "$d" >/dev/null 2>&1 && echo "dir:$d=readable" || echo "dir=denied"
  done
  printf 'umask=%s\n' "$(umask)"
  git checkout -q -b "ar/iso/t1-$(basename "$PWD")" origin/main && echo "$me" > "probe-$me.txt" && git add . \
    && git commit -qm "probe $me" && git push -q origin HEAD && echo "push=ok" || echo "push=fail"
} > "$HOME/probe.tmp.$$" 2>&1
mv "$HOME/probe.tmp.$$" "$HOME/probe-$(basename "$PWD").txt"
echo '{"type":"result","result":"probe done"}'
PROBE
chmod 755 /opt/fake/claude

LOGIN=(CLAUDE_CODE_OAUTH_TOKEN=dummy-oauth)
[[ "$MODE" == fallback ]] && LOGIN=(AGENTS_ROOM_SKIP_LOGIN_CHECK=1)
start_team() {
  env "${LOGIN[@]}" PATH=/opt/fake:$PATH AGENTS_ROOM_SERVER=http://127.0.0.1:7700 AGENTS_ROOM_ENROLL_SECRET=sir AGENTS_ROOM_ROOM=iso \
    AGENTS_ROOM_REPO=http://127.0.0.1:$GITPORT/proje.git AGENTS_ROOM_GIT_TOKEN=$TOKEN CLAUDE_WORKERS=2 ORCHESTRATORS=0 \
    AGENTS_ROOM_WAKE_SEC=5 \
    /opt/agents-room/docker/entrypoint.sh start > "$1" 2>&1 &
  TEAM_PID=$!
}
start_team $T/team.log

deadline=$((SECONDS + 120))
until grep -q 'Ekip ayakta' $T/team.log 2>/dev/null; do
  (( SECONDS < deadline )) || { echo "FAIL: ekip başlamadı"; cat $T/team.log; exit 1; }
  sleep 0.5
done
names=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/data/workspaces/iso/team.json","utf8")).agents.map(a=>a.name).join(" "))')
ADMIN=$(cat $T/srv/admin.token)
for n in $names; do
  curl -fs -X POST 127.0.0.1:7700/api/tasks -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
    -d "{\"room\":\"iso\",\"title\":\"probe $n\",\"assignee\":\"$n\"}" >/dev/null
done
probe() { ls /data/agents/iso/$1/probe-$1.txt /home/node/probe-$1.txt 2>/dev/null | head -n 1; }
for n in $names; do
  until [[ -n "$(probe $n)" ]]; do
    (( SECONDS < deadline )) || { echo "FAIL: $n yoklaması yok"; cat $T/team.log; exit 1; }
    sleep 0.5
  done
done
echo "isolated=$(grep -c 'kendi Linux kullanıcısıyla' $T/team.log)"
echo "warned=$(grep -c 'ortak kullanıcıyla (node' $T/team.log)"
grep -q "$TOKEN" $T/team.log && echo "teamlog=token-leak" || echo "teamlog=clean"
for n in $names; do echo "== $n"; cat "$(probe $n)"; done
# Yeniden başlatma: aynı adlar kendi token'larıyla döner, kopyalar agent kullanıcısıyla vekil üzerinden güncellenir.
kill -TERM $TEAM_PID; wait $TEAM_PID 2>/dev/null || true
start_team $T/team2.log
until grep -q 'Ekip ayakta' $T/team2.log 2>/dev/null; do
  (( SECONDS < deadline + 60 )) || { echo "FAIL: ekip yeniden başlamadı"; cat $T/team2.log; exit 1; }
  sleep 0.5
done
names2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/data/workspaces/iso/team.json","utf8")).agents.map(a=>a.name).join(" "))')
[[ "$names2" == "$names" ]] && echo "restart_names=same" || echo "restart_names=changed ($names → $names2)"
grep -q 'güncellenemedi\|yerine .* kullanılacak' $T/team2.log && { echo "restart=warn"; grep 'güncellenemedi\|kullanılacak' $T/team2.log; } || echo "restart=ok"
kill -TERM $TEAM_PID; wait $TEAM_PID 2>/dev/null || true
echo "== branches"
git --git-dir $T/git/proje.git for-each-ref --format='%(refname:short)' 'refs/heads/ar/'
