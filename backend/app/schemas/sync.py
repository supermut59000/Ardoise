from typing import Any, Dict, List, Literal

from pydantic import BaseModel, ConfigDict, Field


class OperationWire(BaseModel):
    """
    One operation, in the exact shape the client uses (camelCase). The client can
    push and ingest these directly with no field remapping. The server's `seq` and
    `received_at` are internal and never cross the wire.

    Field constraints mirror the DB columns (String(36)/String(64)) and the
    client's own vocabulary: a malformed op is rejected as a clean 422 instead
    of blowing up MariaDB with an over-length value (a 500 the client would
    retry forever).
    """

    model_config = ConfigDict(populate_by_name=True)

    op_id: str = Field(alias="opId", min_length=1, max_length=36)
    group_id: str = Field(alias="groupId", min_length=1, max_length=36)
    entity: Literal["group", "member", "expense", "settlement"]
    entity_id: str = Field(alias="entityId", min_length=1, max_length=36)
    action: Literal["create", "update", "delete"]
    payload: Dict[str, Any]
    actor: str = Field(max_length=64)
    lamport: int
    created_at: int = Field(alias="createdAt")


class PushRequest(BaseModel):
    ops: List[OperationWire]


class PushResponse(BaseModel):
    accepted: int  # how many were newly stored (duplicates are ignored)
    cursor: int    # current max server seq for this group


class PullResponse(BaseModel):
    ops: List[OperationWire]
    cursor: int    # max seq returned; pass back as ?since= next time


class RegisterRequest(BaseModel):
    group_id: str = Field(alias="groupId")
    model_config = ConfigDict(populate_by_name=True)


class GroupOut(BaseModel):
    group_id: str = Field(serialization_alias="groupId")
    share_code: str = Field(serialization_alias="shareCode")
    model_config = ConfigDict(populate_by_name=True)
