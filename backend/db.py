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

# A serverless host gives every invocation a fresh, empty, read-only
# filesystem. SQLite there does not fail -- it quietly starts from nothing on
# each cold start, so an organiser would create a race and find it gone a
# minute later. Refusing to boot is far kinder than losing a race day.
if DATABASE_URL.startswith("sqlite") and os.getenv("VERCEL"):
    raise RuntimeError(
        "DATABASE_URL is not set. This deployment is serverless, where SQLite "
        "silently loses all data between requests. Point DATABASE_URL at a "
        "Postgres instance (Vercel Postgres, Neon and Supabase all have a free "
        "tier) and redeploy."
    )

# check_same_thread is a SQLite-only quirk: FastAPI serves requests on a
# threadpool, and SQLite objects to being touched from a thread other than the
# one that created them unless we say otherwise.
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(DATABASE_URL, connect_args=connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
