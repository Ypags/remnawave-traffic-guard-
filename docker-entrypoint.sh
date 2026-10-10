#!/bin/sh
set -e

# Bind-mount ./data с хоста часто принадлежит root (создали через sudo/docker
# как root). Контейнер пишет от пользователя node — без chown будет EACCES.
mkdir -p /app/data
chown -R node:node /app/data

exec su-exec node "$@"
