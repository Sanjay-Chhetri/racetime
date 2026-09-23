"""Vercel serverless entrypoint.

Vercel's Python runtime looks for a module in `api/` exporting an ASGI `app`.
Everything else is the same application that `uvicorn backend.main:app` runs
locally, so there is no second copy of the routing to keep in step.
"""
import sys
from pathlib import Path

# The function runs with `api/` as the working directory, so the project root
# has to be on the path before `backend` can be imported.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.main import app  # noqa: E402

__all__ = ["app"]
