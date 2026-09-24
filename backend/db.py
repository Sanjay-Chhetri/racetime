"""Database connection.

Defaults to SQLite so the app runs with zero setup. Point DATABASE_URL at a
Postgres instance for production; nothing else in the code needs to change.
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./racetime.db")

# Some providers hand out the legacy "postgres://" prefix, which SQLAlchemy
# dropped support for. Normalise it rather than making the operator notice.
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Every hosted platform gives the app a filesystem it does not keep. On a
# serverless host that is per-request; on a container host it is per-deploy.
# Either way SQLite does not error, it just quietly starts from nothing, so an
# organiser creates a race and finds it gone. That is worth shouting about.
_SERVERLESS = ("VERCEL", "AWS_LAMBDA_FUNCTION_NAME")
_CONTAINER = ("RAILWAY_ENVIRONMENT", "RENDER", "FLY_APP_NAME", "DYNO")

if DATABASE_URL.startswith("sqlite"):
    if any(os.getenv(v) for v in _SERVERLESS):
        # Per-request loss is instant and total; refusing to boot is kinder.
        raise RuntimeError(
            "DATABASE_URL is not set. This deployment is serverless, where "
            "SQLite silently loses all data between requests. Point "
            "DATABASE_URL at a Postgres instance (Neon, Supabase and Vercel "
            "Postgres all have a free tier) and redeploy."
        )
    if any(os.getenv(v) for v in _CONTAINER):
        # Here the data survives until the next deploy, so the app still runs
        # -- but nobody should discover this the morning after a race.
        import warnings
        warnings.warn(
            "DATABASE_URL is not set, so this deployment is using SQLite on a "
            "disk the platform does not keep. Every race you create will be "
            "erased on the next deploy or restart. Attach a Postgres database "
            "and set DATABASE_URL.",
            RuntimeWarning, stacklevel=2,
        )

# check_same_thread is a SQLite-only quirk: FastAPI serves requests on a
# threadpool, and SQLite objects to being touched from a thread other than the
# one that created them unless we say otherwise.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine_kwargs = {"connect_args": connect_args, "pool_pre_ping": True}

if any(os.getenv(v) for v in _SERVERLESS) and not DATABASE_URL.startswith("sqlite"):
    # Serverless invocations do not share memory, so SQLAlchemy's usual pool is
    # not a pool at all -- it is one private pool per concurrent invocation,
    # each holding connections open. Under load that exhausts the database's
    # connection limit while most of those connections sit idle.
    #
    # NullPool opens a connection per request and closes it again. The pooling
    # belongs to the provider's own pooler, which is shared across invocations:
    # on Neon that is the connection string whose host contains "-pooler".
    from sqlalchemy.pool import NullPool
    engine_kwargs["poolclass"] = NullPool
    engine_kwargs.pop("pool_pre_ping")   # meaningless without a pool

engine = create_engine(DATABASE_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
