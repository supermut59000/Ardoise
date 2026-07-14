from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_db
from app.schemas.sync import GroupOut, RegisterRequest
from app.services.group_service import GroupService

router = APIRouter()


@router.post("/register", response_model=GroupOut)
def register_group(body: RegisterRequest, db: Session = Depends(get_db)):
    """Register a local group for sharing and return its share code (idempotent)."""
    group = GroupService(db).register(body.group_id)
    return GroupOut(group_id=group.id, share_code=group.share_code)


@router.get("/resolve/{share_code}", response_model=GroupOut)
def resolve_code(share_code: str, db: Session = Depends(get_db)):
    """Resolve a share code to its group so another device can join."""
    group = GroupService(db).resolve(share_code)
    if not group:
        raise HTTPException(status_code=404, detail="Code de partage introuvable")
    return GroupOut(group_id=group.id, share_code=group.share_code)


@router.get("/{group_id}", response_model=GroupOut)
def get_group(group_id: str, db: Session = Depends(get_db)):
    group = GroupService(db).get(group_id)
    if not group:
        raise HTTPException(status_code=404, detail="Groupe non enregistre")
    return GroupOut(group_id=group.id, share_code=group.share_code)
