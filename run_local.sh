#!/usr/bin/env bash
# Runs migrations + security/order tests against a throw-away LOCAL PostgreSQL (>=15). No Supabase account needed.
# Usage: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres ./supabase/tests/run_local.sh
# The stub file fakes just enough of Supabase (auth.users, auth.uid(), storage, anon/authenticated roles).
set -euo pipefail
cd "$(dirname "$0")/.."
DB="market_test_$$"
psql -d postgres -v ON_ERROR_STOP=1 -q -c "create database $DB"
trap 'psql -d postgres -q -c "drop database if exists $DB"' EXIT
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f tests/00_supabase_stub.sql
for f in migrations/*.sql; do echo "applying $f"; psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -d "$DB" -q -P pager=off -f tests/01_security_and_orders.sql
echo "Review the output: every '... blocked?' row must say 'blocked' (RLS-filtered updates show 0 rows changed)."
