from typing import List

from pydantic import BaseModel, ConfigDict, Field, field_validator


class PushKeys(BaseModel):
    """The browser subscription's encryption keys, as PushSubscription.toJSON() gives them."""

    p256dh: str
    auth: str


class SubscribeRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    endpoint: str = Field(max_length=500)

    @field_validator("endpoint")
    @classmethod
    def _https_only(cls, v: str) -> str:
        # Real push services (FCM) are https; pywebpush POSTs this URL as-is,
        # so accepting http:// would let a subscriber steer the server at the
        # docker host / bridge network (SSRF, red-team F11).
        if not v.startswith("https://"):
            raise ValueError("endpoint doit être une URL https")
        return v

    keys: PushKeys
    device_id: str = Field(alias="deviceId", max_length=64)
    group_ids: List[str] = Field(alias="groupIds")


class UnsubscribeRequest(BaseModel):
    endpoint: str = Field(max_length=500)


class VapidPublicKeyOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    public_key: str = Field(serialization_alias="publicKey")
