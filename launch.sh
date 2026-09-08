#!/bin/sh
# Boot-time. Runs as the non-root app user on every container start.
set -eu

# Migrations run here, not at build: DATABASE_URL only exists at runtime.
node packages/db/dist/migrate.js

# exec so the server becomes PID 1 and receives SIGTERM directly on redeploy.
exec node packages/api/dist/server.js
