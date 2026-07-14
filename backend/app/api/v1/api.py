from fastapi import APIRouter, Depends

from app.api.deps import require_api_key
from app.api.v1.endpoints import groups, ops, push, system

api_router = APIRouter()
api_router.include_router(system.router, prefix="/system", tags=["system"])

# Sync and push endpoints are gated by the shared instance password (X-API-Key).
api_router.include_router(
    groups.router, prefix="/groups", tags=["groups"], dependencies=[Depends(require_api_key)]
)
api_router.include_router(
    ops.router, prefix="/groups", tags=["ops"], dependencies=[Depends(require_api_key)]
)
api_router.include_router(
    push.router, prefix="/push", tags=["push"], dependencies=[Depends(require_api_key)]
)
