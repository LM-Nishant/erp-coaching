#!/bin/sh
# Validates and installs the TLS certificates before nginx starts (see /usr/local/bin/erp-certs).
set -eu
exec /usr/local/bin/erp-certs
