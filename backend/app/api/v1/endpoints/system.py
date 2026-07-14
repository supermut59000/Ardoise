from fastapi import APIRouter, Depends

from app.api.deps import require_api_key

router = APIRouter()


@router.get("/ping")
def ping():
    return {"status": "ok"}


@router.get("/auth-check", dependencies=[Depends(require_api_key)])
def auth_check():
    """Validate the shared password. The client calls this once to confirm the
    key before storing it. 200 = valid (or no password configured); 401 = wrong."""
    return {"status": "ok"}
