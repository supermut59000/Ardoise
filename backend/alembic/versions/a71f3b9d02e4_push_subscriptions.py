"""push subscriptions

Revision ID: a71f3b9d02e4
Revises: c2dc57cd3548
Create Date: 2026-07-14 22:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a71f3b9d02e4'
down_revision: Union[str, None] = 'c2dc57cd3548'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'push_subscriptions',
        sa.Column('endpoint', sa.String(length=500), nullable=False),
        sa.Column('p256dh', sa.String(length=255), nullable=False),
        sa.Column('auth', sa.String(length=255), nullable=False),
        sa.Column('device_id', sa.String(length=64), nullable=False),
        sa.Column('group_ids', sa.JSON(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('endpoint'),
    )
    op.create_index(
        op.f('ix_push_subscriptions_device_id'), 'push_subscriptions', ['device_id'], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_push_subscriptions_device_id'), table_name='push_subscriptions')
    op.drop_table('push_subscriptions')
