"""server generation identity

Revision ID: e4b8f6a1c2d3
Revises: a71f3b9d02e4
Create Date: 2026-08-12 12:00:00.000000

"""
from typing import Sequence, Union
from uuid import uuid4

from alembic import op
import sqlalchemy as sa

revision: str = "e4b8f6a1c2d3"
down_revision: Union[str, None] = "a71f3b9d02e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    table = op.create_table(
        "server_meta",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("generation", sa.String(length=36), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.bulk_insert(table, [{"id": 1, "generation": str(uuid4())}])


def downgrade() -> None:
    op.drop_table("server_meta")
