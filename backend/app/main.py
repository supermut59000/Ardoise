from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api.v1.api import api_router
from app.core.config import settings
from app.core.database import SessionLocal

app = FastAPI(
    title=settings.PROJECT_NAME,
    description=settings.PROJECT_DESCRIPTION,
    version=settings.VERSION,
    openapi_url=f"{settings.API_V1_STR}/openapi.json" if settings.DEBUG else None,
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key", "Accept"],
)

app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/")
def root():
    return {"message": "Ardoise API", "version": settings.VERSION}


@app.get("/health")
def health_check():
    db = None
    try:
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        return {"status": "healthy"}
    except Exception:
        # 503, not 200: the Docker healthcheck and any monitor must see a DB
        # outage as unhealthy, not a green "unhealthy" body.
        return JSONResponse(
            status_code=503, content={"status": "unhealthy", "db": "unreachable"}
        )
    finally:
        # Close even when execute() throws, or each probe during an outage
        # leaks a session.
        if db is not None:
            db.close()
