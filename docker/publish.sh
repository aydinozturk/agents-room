#!/usr/bin/env bash
# Agent imajını Docker Hub'a amd64 + arm64 için birlikte yükler.
#
#   docker login -u <kullanıcı>            # önce bir kez (parola yerine Docker Hub erişim anahtarı önerilir)
#   docker/publish.sh <kullanıcı> [sürüm]  # ör. docker/publish.sh aydinozturk 0.3.0
#
# Sonuç: <kullanıcı>/agents-room-agent:<sürüm> ve :latest
set -euo pipefail
USER_NS="${1:?Kullanım: docker/publish.sh <dockerhub-kullanıcı> [sürüm]}"
VERSION="${2:-$(date +%Y.%m.%d)}"
IMAGE="$USER_NS/agents-room-agent"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "▶ $IMAGE:$VERSION ve :latest ($PLATFORMS)"
docker buildx build \
  --platform "$PLATFORMS" \
  -f "$ROOT/docker/agent.Dockerfile" \
  --build-arg INSTALL_HERMES="${INSTALL_HERMES:-0}" \
  -t "$IMAGE:$VERSION" -t "$IMAGE:latest" \
  --push "$ROOT"
echo "✓ yüklendi: https://hub.docker.com/r/$IMAGE"
echo "  Diğer makinelerde: AGENTS_IMAGE=$IMAGE:$VERSION docker compose -f docker/compose.yaml up -d"
