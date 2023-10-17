#!/bin/sh
BASE_DIR="$(cd "$(dirname "$0")"; pwd)" # https://stackoverflow.com/a/52293841
exec "$BASE_DIR/node/node" "$BASE_DIR/myspace.js" "$@"
