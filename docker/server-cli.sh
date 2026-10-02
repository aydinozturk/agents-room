#!/usr/bin/env bash
# Sunucu konteynerinde yönetim komutları:  docker exec <konteyner> agents-room <komut>
#   token            panel girişi için admin token'ı
#   secret           diğer makinelerin ekip kurarken istediği kayıt sırrı
#   status           odalar, agent'lar, görevler
#   agent add|list|revoke ..., room add ...   (server/src/cli.ts)
set -euo pipefail
DATA="$(dirname "${AGENTS_ROOM_DB:-/data/agents-room.db}")"
case "${1:-help}" in
  token)
    if [ -s "$DATA/admin.token" ]; then cat "$DATA/admin.token"
    else echo "admin.token yok. Yenisi: agents-room agent add admin2 --kind human --role admin" >&2; exit 1; fi ;;
  secret)
    if [ -n "${AGENTS_ROOM_ENROLL_SECRET:-}" ]; then echo "$AGENTS_ROOM_ENROLL_SECRET"
    elif [ -s "$DATA/enroll.secret" ]; then cat "$DATA/enroll.secret"
    else echo "Kayıt sırrı yok (AGENTS_ROOM_ENROLL=off olabilir)." >&2; exit 1; fi ;;
  help|-h|--help)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) exec node /app/src/cli.ts "$@" ;;
esac
