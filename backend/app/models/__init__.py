"""Import all models here so Alembic autogenerate and Base.metadata see them."""
from app.models.group import Group
from app.models.operation import Operation

__all__ = ["Group", "Operation"]
