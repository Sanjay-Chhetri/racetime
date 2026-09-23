"""Database connection.

Defaults to SQLite so the app runs with zero setup. Point DATABASE_URL at a
Postgres instance for production; nothing else in the code needs to change.
"""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./racetime.db")

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
