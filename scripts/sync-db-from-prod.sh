#!/usr/bin/env bash
#
# Replace the local dev databases with a copy of production.
#
# Dev reads from two different databases and they drift independently:
#
#   .wrangler/state/v3/d1/miniflare-D1DatabaseObject/  astro dev, wrangler dev
#   data.db                                            emdash CLI, type generation
#
# Both are refreshed here, because a stale data.db makes type generation
# rewrite emdash-env.d.ts against a schema that no longer matches.
#
# Production is only ever read from. Every write goes to a local file.
#
#   ./scripts/sync-db-from-prod.sh          prompts before touching anything
#   ./scripts/sync-db-from-prod.sh --yes    no prompt
#
set -euo pipefail

DB_NAME="${DB_NAME:-jess}"
LOCAL_ORIGIN="${LOCAL_ORIGIN:-http://localhost:4321}"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

MINIFLARE_DIR=".wrangler/state/v3/d1/miniflare-D1DatabaseObject"
BACKUP_DIR=".db-backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="$BACKUP_DIR/prod-$STAMP.sql"
FTS_SQL="$BACKUP_DIR/prod-$STAMP.fts.sql"

if [[ "${1:-}" != "--yes" && "${1:-}" != "-y" ]]; then
	echo "This overwrites your local dev databases with production data:"
	echo "  $MINIFLARE_DIR"
	echo "  data.db"
	echo
	echo "Production is not modified. Current local copies are backed up to $BACKUP_DIR/."
	read -r -p "Continue? [y/N] " reply
	[[ "$reply" == [yY] ]] || { echo "Aborted."; exit 1; }
fi

mkdir -p "$BACKUP_DIR"

# `d1 export` refuses to dump a database containing fts5 virtual tables, so
# the search indexes are excluded here and rebuilt from their source tables
# further down. Their shadow tables (_data/_idx/_docsize/_config) belong to
# fts5 and are recreated with the virtual table, so they are skipped too.
echo "==> Listing exportable tables"
TABLE_ARGS=()
TABLE_COUNT=0
while IFS= read -r table; do
	[[ -n "$table" ]] || continue
	TABLE_ARGS+=(--table "$table")
	TABLE_COUNT=$((TABLE_COUNT + 1))
done < <(
	npx wrangler d1 execute "$DB_NAME" --remote --json --command "
		SELECT name FROM sqlite_master
		WHERE type = 'table'
		  AND name NOT LIKE 'sqlite_%'
		  AND name <> '_cf_KV'
		  AND name NOT IN (SELECT name FROM sqlite_master WHERE sql LIKE '%VIRTUAL TABLE%')
		  AND name NOT LIKE '%\\_data' ESCAPE '\\'
		  AND name NOT LIKE '%\\_idx' ESCAPE '\\'
		  AND name NOT LIKE '%\\_docsize' ESCAPE '\\'
		  AND name NOT LIKE '%\\_config' ESCAPE '\\'
		ORDER BY name;" 2>/dev/null |
		python3 -c "import sys,json;[print(r['name']) for r in json.load(sys.stdin)[0]['results']]"
)
[[ $TABLE_COUNT -gt 0 ]] || { echo "No tables returned -- is wrangler logged in?" >&2; exit 1; }
echo "    $TABLE_COUNT tables"

echo "==> Exporting $DB_NAME from production"
npx wrangler d1 export "$DB_NAME" --remote --output="$DUMP" -y "${TABLE_ARGS[@]}" >/dev/null

# Rebuild statements for the excluded indexes: create the virtual table,
# repopulate it from its content table, then restore the sync triggers.
npx wrangler d1 execute "$DB_NAME" --remote --json --command "
	SELECT type, name, sql FROM sqlite_master
	WHERE sql LIKE '%VIRTUAL TABLE%' OR type = 'trigger';" 2>/dev/null |
	python3 -c "
import sys, json
rows = json.load(sys.stdin)[0]['results']
out = []
for r in [r for r in rows if r['type'] == 'table']:
    name = r['name'].replace('\"', '\"\"')
    out.append(r['sql'] + ';')
    out.append('INSERT INTO \"%s\"(\"%s\") VALUES(\'rebuild\');' % (name, name))
out += [r['sql'] + ';' for r in rows if r['type'] == 'trigger']
print('\n'.join(out))
" >"$FTS_SQL"
echo "    $(grep -c 'INSERT INTO' "$DUMP" || true) inserts, $(wc -l <"$FTS_SQL" | tr -d ' ') lines of search index DDL"

echo "==> Backing up local databases"
if [[ -d "$MINIFLARE_DIR" ]]; then
	tar -czf "$BACKUP_DIR/miniflare-$STAMP.tar.gz" "$MINIFLARE_DIR"
	echo "    $BACKUP_DIR/miniflare-$STAMP.tar.gz"
fi
if [[ -f data.db ]]; then
	cp data.db "$BACKUP_DIR/data-$STAMP.db"
	echo "    $BACKUP_DIR/data-$STAMP.db"
fi

echo "==> Loading into the wrangler dev database"
# Wiping first: the dump contains CREATE TABLE, which collides with the
# tables already there. Miniflare recreates the directory on next use.
rm -rf "$MINIFLARE_DIR"
npx wrangler d1 execute "$DB_NAME" --local --file="$DUMP" -y >/dev/null
npx wrangler d1 execute "$DB_NAME" --local --file="$FTS_SQL" -y >/dev/null

echo "==> Loading into data.db"
rm -f data.db data.db-journal
sqlite3 data.db <"$DUMP"
sqlite3 data.db <"$FTS_SQL"

# emdash:site_url is what getSiteBaseUrl() reads to build admin and
# magic-link URLs, and it takes precedence over astro.config.mjs. Carried
# over from production it makes local logins email links to the live site.
echo "==> Repointing site URL at $LOCAL_ORIGIN"
SET_ORIGIN="UPDATE options SET value = '\"$LOCAL_ORIGIN\"' WHERE name = 'emdash:site_url';"
npx wrangler d1 execute "$DB_NAME" --local -y --command "$SET_ORIGIN" >/dev/null
sqlite3 data.db "$SET_ORIGIN"

echo
echo "Synced. data.db now has:"
sqlite3 data.db \
	"SELECT '  collections: ' || (SELECT COUNT(*) FROM _emdash_collections)
	      || ', users: '     || (SELECT COUNT(*) FROM users)
	      || ', media: '     || (SELECT COUNT(*) FROM media)
	      || ', search rows: ' || (SELECT COUNT(*) FROM _emdash_fts_projects)
	      || ', site_url: '  || (SELECT value FROM options WHERE name = 'emdash:site_url');"

cat <<EOF

Two things the database cannot carry across:
  - Passkeys are bound to the production domain and will not work on
    localhost. Sign in via /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
  - Media rows point at R2 objects that are not in local storage, so
    images render broken until the bucket is synced separately.
EOF
