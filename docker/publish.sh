#!/usr/bin/env bash
# agents-room imajlarını Docker Hub'a amd64 + arm64 için birlikte yükler.
#
#   docker login -u <kullanıcı>                       # önce bir kez (parola yerine Docker Hub erişim anahtarı önerilir)
#   docker/publish.sh <kullanıcı> [sürüm] [hedef]     # ör. docker/publish.sh aydinozturk 0.3.2
#
# hedef: all (varsayılan) | agent | server
# Sonuç: <kullanıcı>/agents-room-agent:<sürüm> ve <kullanıcı>/agents-room-server:<sürüm>, ikisi de :latest
set -euo pipefail
USER_NS="${1:?Kullanım: docker/publish.sh <dockerhub-kullanıcı> [sürüm] [all|agent|server]}"
VERSION="${2:-$(date +%Y.%m.%d)}"
TARGET="${3:-all}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

publish() { # <imaj-adı> <dockerfile> [ek buildx argümanları...]
  local image="$USER_NS/$1" file="$2"; shift 2
  echo "▶ $image:$VERSION ve :latest ($PLATFORMS)"
  docker buildx build --platform "$PLATFORMS" -f "$ROOT/docker/$file" "$@" \
    -t "$image:$VERSION" -t "$image:latest" --push "$ROOT"
  echo "✓ yüklendi: https://hub.docker.com/r/$image"
}

case "$TARGET" in
  all|server|agent) ;;
  *) echo "Bilinmeyen hedef: $TARGET (all|agent|server)" >&2; exit 2 ;;
esac
if [ "$TARGET" != agent ]; then
  publish agents-room-server server.Dockerfile
  echo "  Sunucu makinesinde: SERVER_IMAGE=$USER_NS/agents-room-server:$VERSION docker compose -f docker/server.compose.yaml up -d"
fi
if [ "$TARGET" != server ]; then
  publish agents-room-agent agent.Dockerfile --build-arg INSTALL_HERMES="${INSTALL_HERMES:-0}"
  echo "  Diğer makinelerde: AGENTS_IMAGE=$USER_NS/agents-room-agent:$VERSION docker compose -f docker/compose.yaml up -d"
fi
