"""Apply migrations/schema.sql to DATABASE_URL, for machines without psql.

    python migrations/apply.py

Equivalent to `psql "$DATABASE_URL" -f migrations/schema.sql`. Safe to re-run -
every statement in schema.sql is idempotent.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402  (needs the sys.path tweak above)

SCHEMA_FILE = Path(__file__).resolve().parent / "schema.sql"


def main():
    if not db.DB_ENABLED:
        sys.exit("DATABASE_URL isn't set (or psycopg2 isn't installed) - see README's Data store section.")

    sql = SCHEMA_FILE.read_text()
    with db.get_connection() as conn:
        with conn.cursor() as cur:
            # No params, so psycopg2 sends the file as-is (multiple statements
            # in one call is fine) without treating any '%' in it as a placeholder.
            cur.execute(sql)

    tables = db.fetch_all(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name"
    )
    print("Schema applied. Tables:", ", ".join(t["table_name"] for t in tables))


if __name__ == "__main__":
    main()
