"""
backend/app/main.py
FastAPI application factory for FieldSync.

Responsibilities:
  • Create and configure the FastAPI app instance.
  • Register routers under /api.
  • Run init_db() at startup.
  • Mount ../frontend as StaticFiles at "/" (html=True) so the PWA is served.
  • Add Service-Worker-Allowed: / and Cache-Control: no-cache for sw.js and
    manifest.json so the Service Worker can control the full origin scope.
"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import auth as auth_router
from app.routers import projects as projects_router

# ---------------------------------------------------------------------------
# Lifespan: initialise database on startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

app = FastAPI(
    title="FieldSync API",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# API routers
# ---------------------------------------------------------------------------

app.include_router(auth_router.router,     prefix="/api")
app.include_router(projects_router.router, prefix="/api")


# ---------------------------------------------------------------------------
# Health check (no auth required)
# ---------------------------------------------------------------------------

@app.get("/api/health", tags=["health"])
def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Middleware: inject Service-Worker and cache headers for sw.js / manifest.json
# ---------------------------------------------------------------------------

@app.middleware("http")
async def sw_headers_middleware(request: Request, call_next):
    response: Response = await call_next(request)
    path = request.url.path
    if path in ("/sw.js", "/manifest.json"):
        # Allow the SW to control the full origin scope.
        response.headers["Service-Worker-Allowed"] = "/"
        # Prevent browsers from caching these files so updates propagate.
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# ---------------------------------------------------------------------------
# Static files — mount the frontend at "/"
# Must come AFTER all /api routes so API paths take priority.
# ---------------------------------------------------------------------------

_FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

if _FRONTEND_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(_FRONTEND_DIR), html=True),
        name="frontend",
    )
