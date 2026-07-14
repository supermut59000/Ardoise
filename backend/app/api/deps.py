"""Shared API dependencies."""
import secrets

from fastapi import Header, HTTPException

from app.core.config import settings
from app.core.database import get_db

__all__ = ["get_db", "require_api_key"]


def require_api_key(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    """
    Gate sync endpoints behind the shared instance password. No-op when API_KEY
    is unset (local dev). Constant-time comparison avoids timing leaks.
    """
    if not settings.API_KEY:
        return
    if not x_api_key or not secrets.compare_digest(x_api_key, settings.API_KEY):
        raise HTTPException(status_code=401, detail="Mot de passe du serveur invalide")
