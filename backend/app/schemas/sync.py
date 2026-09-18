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
    # Bounded to BIGINT: 10^40 passes unbounded int Pydantic, then MariaDB
    # rejects it at commit -> 500 the client retries forever (red-team F8).
    lamport: int = Field(ge=0, le=2**63 - 1)
    created_at: int = Field(alias="createdAt", ge=0, le=2**63 - 1)


class PushRequest(BaseModel):
    ops: List[OperationWire]
    # Set by the client when re-pushing its whole log after server data loss
    # (self-heal reseed). Real activity stays silent only above the batch cap,
    # but a heal is NOT live activity and must never ring anyone's phone, so it
    # opts out of the notification fan-out entirely.
    reseed: bool = False


class PushResponse(BaseModel):
    accepted: int  # how many were newly stored (duplicates are ignored)
    cursor: int  # current max server seq for this group


class PullResponse(BaseModel):
    ops: List[OperationWire]
    cursor: int  # max seq returned; pass back as ?since= next time
    server_generation: str = Field(serialization_alias="serverGeneration")
    model_config = ConfigDict(populate_by_name=True)


class SyncRequest(BaseModel):
    """
    Push + pull in one round trip: the server applies `ops` (idempotent, same
    rules as POST /ops) and returns everything with seq > `since` — including
    the ops just accepted, so a device never needs a second request to learn
    the seq of its own ops.
    """

    ops: List[OperationWire]
    since: int = Field(0, ge=0)
    reseed: bool = False


class SyncResponse(BaseModel):
    accepted: int  # how many of the pushed ops were newly stored
    ops: List[OperationWire]  # everything with seq > since, seq order
    cursor: int  # pass back as `since` next time
    server_generation: str = Field(serialization_alias="serverGeneration")
    model_config = ConfigDict(populate_by_name=True)


class RegisterRequest(BaseModel):
    group_id: str = Field(alias="groupId", min_length=1, max_length=36)
    model_config = ConfigDict(populate_by_name=True)


class GroupOut(BaseModel):
    group_id: str = Field(serialization_alias="groupId")
    share_code: str = Field(serialization_alias="shareCode")
    server_generation: str = Field(serialization_alias="serverGeneration")
    model_config = ConfigDict(populate_by_name=True)
