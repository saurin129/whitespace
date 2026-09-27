"""
Data store connection layer for the MCP tool layer (Coverage/Traffic/
Demographics/Sentiment MCP tools read and write through this instead of
hitting external APIs on every call - see CLAUDE.md "Architecture" and
MCP_TOOL_SCHEMAS.md "Data store and the anomaly-removal step").

This is entirely optional infrastructure. The core Flask app (app.py) does
not import this module and has zero dependency on a database being
configured - it only matters once the MCP tools in the roadmap get built.

Setup: provision a Postgres database with the PostGIS extension available
(Neon and Supabase both support this on their free tiers - see README's
"Data store" section for exact steps), run migrations/schema.sql against
it once, then set the DATABASE_URL environment variable to its connection
string. This is optional enough that "unset" should just mean "caching is
off," not a broken app.
"""

import os
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv

# Load .env here too (app.py does the same), so scripts that import db
# directly - migrations/apply.py, scripts/import_zctas.py - see DATABASE_URL.
# No-op on Vercel; never overrides a variable already set in the environment.
load_dotenv(Path(__file__).resolve().parent / ".env")

try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None


def get_db_url():
    return os.environ.get("DATABASE_URL", "")


# True only if both a DATABASE_URL is configured AND psycopg2 is installed
# (it's in requirements.txt, but this degrades gracefully rather than
# crashing at import time if someone's skipped it - same CACHE_ENABLED
# pattern already used for the on-disk boundary/ZCTA caches in app.py).
DB_ENABLED = bool(get_db_url()) and psycopg2 is not None


@contextmanager
def get_connection():
    """A short-lived connection per call, not a pooled/persistent one - this
    matches how Vercel serverless functions actually run (each invocation is
    its own process, so an app-level connection pool doesn't help there the
    way it would on a long-running server). If read/write volume ever
    justifies pooling, use a pooled connection string from the provider
    (Neon and Supabase both offer one, usually a "pgbouncer" or "pooler"
    variant of DATABASE_URL) rather than adding pooling logic here.

    Raises RuntimeError if the store isn't configured - callers should check
    DB_ENABLED first and fall back to a live API call instead of catching
    this, the same way CACHE_ENABLED is checked before touching the disk
    cache.
    """
    if not DB_ENABLED:
        raise RuntimeError(
            "No data store configured (DATABASE_URL unset, or psycopg2 not "
            "installed). Check db.DB_ENABLED before calling this."
        )
    conn = psycopg2.connect(get_db_url())
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_all(query, params=None):
    """Run a SELECT, return a list of dict rows."""
    with get_connection() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params or ())
            return [dict(row) for row in cur.fetchall()]


def execute(query, params=None):
    """Run an INSERT/UPDATE/DELETE. Commits via get_connection()'s context
    manager; nothing returned, since each MCP tool's writes tend to be
    multi-row upserts better expressed as their own SQL (executemany, or
    INSERT ... ON CONFLICT) rather than forced through one generic helper.
    """
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(query, params or ())


# Table-specific read/write helpers (e.g. upsert_restaurant_location(),
# get_cached_locations()) intentionally aren't here yet - they belong with
# whichever MCP tool actually needs them (Coverage MCP, Traffic MCP, etc.,
# tasks #9-12 in CLAUDE.md's Roadmap), once each tool's real query patterns
# are known, rather than guessed at up front.
