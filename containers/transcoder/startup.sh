#!/bin/sh
set -eu

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

mkdir -p "${R2_MOUNT_PATH}" /tmp/reelnova-transcode
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
/usr/local/bin/tigrisfs --endpoint "${endpoint}" -f "${R2_BUCKET_NAME}" "${R2_MOUNT_PATH}" &

attempt=0
until mountpoint -q "${R2_MOUNT_PATH}"; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 30 ]; then
    echo "R2 FUSE mount did not become ready" >&2
    exit 1
  fi
  sleep 1
done

exec node /app/server.mjs
