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

from app import config
from app.db import init_db
from app.routers import auth as auth_router
from app.routers import media as media_router
from app.routers import projects as projects_router
from app.routers import sync as sync_router
from app.routers import tracks as tracks_router

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
app.include_router(sync_router.router,     prefix="/api")
app.include_router(media_router.router,    prefix="/api")
app.include_router(tracks_router.router,   prefix="/api")


# ---------------------------------------------------------------------------
# Health check (no auth required)
# ---------------------------------------------------------------------------

@app.get("/api/health", tags=["health"])
def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


# ---------------------------------------------------------------------------
# Middleware: request body size limits, security headers, and Cache-Control
# ---------------------------------------------------------------------------

_CSP_POLICY = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' blob: data:; "
    "connect-src 'self' https://cdn.jsdelivr.net; "
    "manifest-src 'self'; "
    "worker-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)


@app.middleware("http")
async def security_and_limits_middleware(request: Request, call_next):
    path = request.url.path

    # Enforce request body size limits before reading body
    if request.method in ("POST", "PUT", "PATCH") and path.startswith("/api/"):
        is_media = path.startswith("/api/media/")
        max_bytes = config.MAX_UPLOAD_BYTES if is_media else config.MAX_JSON_BODY_BYTES
        content_len = request.headers.get("content-length")
        if content_len is not None:
            try:
                if int(content_len) > max_bytes:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": f"Request body exceeds maximum size of {max_bytes} bytes."},
                    )
            except ValueError:
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length header."})
        elif not is_media:
            # Chunked non-media request without Content-Length: read and bound body
            chunks: list[bytes] = []
            total = 0
            async for chunk in request.stream():
                total += len(chunk)
                if total > max_bytes:
                    return JSONResponse(
                        status_code=413,
                        content={"detail": f"Request body exceeds maximum size of {max_bytes} bytes."},
                    )
                chunks.append(chunk)
            body = b"".join(chunks)
            request._body = body

    response: Response = await call_next(request)

    # Security headers on all responses
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Content-Security-Policy", _CSP_POLICY)

    # Cache-Control and Service-Worker headers
    if path in ("/sw.js", "/manifest.json"):
        response.headers["Service-Worker-Allowed"] = "/"
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    elif path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    elif path in ("/", "/index.html"):
        response.headers.setdefault("Cache-Control", "no-cache, must-revalidate")
    elif path.startswith(("/js/", "/css/", "/icons/")):
        response.headers.setdefault("Cache-Control", "public, max-age=3600, must-revalidate")

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
