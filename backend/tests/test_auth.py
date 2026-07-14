from app.core.config import settings
from tests.conftest import make_op


def test_auth_disabled_by_default(client):
    # No API_KEY configured -> endpoints are open.
    assert client.post("/api/v1/groups/register", json={"groupId": "g1"}).status_code == 200
    assert client.get("/api/v1/system/auth-check").status_code == 200


class TestApiKeyEnforced:
    def setup_method(self):
        settings.API_KEY = "s3cret"

    def teardown_method(self):
        settings.API_KEY = ""

    def test_sync_requires_key(self, client):
        assert client.post("/api/v1/groups/register", json={"groupId": "g1"}).status_code == 401

    def test_wrong_key_rejected(self, client):
        r = client.post(
            "/api/v1/groups/register",
            json={"groupId": "g1"},
            headers={"X-API-Key": "nope"},
        )
        assert r.status_code == 401

    def test_correct_key_accepted(self, client):
        r = client.post(
            "/api/v1/groups/register",
            json={"groupId": "g1"},
            headers={"X-API-Key": "s3cret"},
        )
        assert r.status_code == 200

    def test_auth_check_reflects_key(self, client):
        assert client.get("/api/v1/system/auth-check").status_code == 401
        assert client.get("/api/v1/system/auth-check", headers={"X-API-Key": "s3cret"}).status_code == 200

    def test_push_pull_gated(self, client):
        headers = {"X-API-Key": "s3cret"}
        client.post("/api/v1/groups/register", json={"groupId": "g1"}, headers=headers)
        # without key
        assert client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]}).status_code == 401
        assert client.get("/api/v1/groups/g1/ops?since=0").status_code == 401
        # with key
        assert client.post("/api/v1/groups/g1/ops", json={"ops": [make_op("o1", "g1", 1)]}, headers=headers).status_code == 200
        assert client.get("/api/v1/groups/g1/ops?since=0", headers=headers).status_code == 200

    def test_ping_stays_open(self, client):
        # /system/ping is not gated (basic liveness).
        assert client.get("/api/v1/system/ping").status_code == 200
