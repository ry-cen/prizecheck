from test_catalog import claim_current
import json
from uuid import uuid4

from fastapi.testclient import TestClient

from app.art_urls import art_url
from app.games.pokemon.catalog.catalog import claim_run, execute_run
from app.main import app, connect
from test_catalog import Source, headers, reset_catalog

client = TestClient(app)
USER = "catalog-reader"


class SearchSource(Source):
    def __init__(self, names):
        super().__init__(ids=tuple(names))
        self.names = names

    def fetch(self, source_id):
        number = source_id.split("-")[-1]
        return {"id": source_id, "name": self.names[source_id], "localId": number,
                "set": {"id": "fixture", "name": "Fixture Set"}, "category": "Pokemon",
                "image": "https://assets.tcgdex.net/en/fixture/card-1" if source_id == "card-1" else None,
                "variants": {"normal": True, "reverse": source_id == "card-1"}}


def promote(names):
    reset_catalog()
    with connect() as conn:
        conn.execute("INSERT INTO catalog_run DEFAULT VALUES")
        execute_run(conn, claim_current(conn), SearchSource(names))


def search(**params):
    path = "/api/catalog/search"
    return client.get(path, params=params, headers=headers(USER, "GET", path))


def test_unavailable_literal_prefix_unicode_and_detail():
    reset_catalog()
    unavailable = search(name="Pik")
    assert unavailable.status_code == 200 and unavailable.json()["available"] is False
    promote({"card-1": "Pikachu", "card-2": "Pik%literal", "card-3": "Pik_literal", "card-4": "Énergie"})
    assert [item["name"] for item in search(name="Pik%").json()["printings"]] == ["Pik%literal"]
    assert [item["name"] for item in search(name="Pik_").json()["printings"]] == ["Pik_literal"]
    assert [item["name"] for item in search(name="éner").json()["printings"]] == ["Énergie"]
    result = search(name="Pikachu").json()
    printing = result["printings"][0]
    assert printing["low_image_url"] == art_url(printing["id"], "https://assets.tcgdex.net/en/fixture/card-1", "small")
    assert printing["identity_name"] == "Pikachu"
    assert printing["source"] == "tcgdex"
    assert len(printing["editions"]) == 2
    path = f'/api/catalog/printings/{printing["id"]}'
    detail = client.get(path, headers=headers(USER, "GET", path)).json()
    assert detail["printing"]["high_image_url"] == art_url(printing["id"], "https://assets.tcgdex.net/en/fixture/card-1", "large")
    assert "assets.tcgdex.net" not in json.dumps(detail) and "assets.tcgdex.net" not in json.dumps(result)
    assert detail["last_success"] and detail["revision"] == 1
    assert search(name="Missing").json()["printings"] == []
    assert search(name=" ").status_code == 422


def test_keyset_cursor_filter_binding_and_revision_change():
    promote({f"card-{i}": f"Pikachu {i:02d}" for i in range(1, 36)})
    first = search(name="Pik").json()
    assert len(first["printings"]) == 30 and first["next_cursor"]
    second = search(name="Pik", cursor=first["next_cursor"]).json()
    assert len(second["printings"]) == 5 and second["next_cursor"] is None
    assert not {item["id"] for item in first["printings"]} & {item["id"] for item in second["printings"]}
    assert search(name="Other", cursor=first["next_cursor"]).status_code == 422
    with connect() as conn:
        conn.execute("UPDATE catalog_state SET revision=revision+1")
    changed = search(name="Pik", cursor=first["next_cursor"])
    assert changed.status_code == 409 and changed.json()["detail"]["code"] == "CATALOG_CHANGED"


def test_set_number_returns_multiple_printings_and_absent_image():
    promote({"card-1": "Pikachu", "card-2": "Raichu"})
    with connect() as conn:
        generation = conn.execute("SELECT active_generation FROM catalog_state").fetchone()["active_generation"]
        printing = conn.execute("SELECT id, identity_id FROM catalog_printing WHERE source_id='card-2'").fetchone()
        conn.execute("UPDATE catalog_generation_printing SET collector_number='1' WHERE generation_id=%s AND printing_id=%s", (generation, printing["id"]))
    page = search(set_id="FIXTURE", number="1").json()
    assert [item["name"] for item in page["printings"]] == ["Pikachu", "Raichu"]
    assert page["printings"][1]["low_image_url"] is None
    assert all(item["set_name"] == "Fixture Set" for item in page["printings"])
    assert client.get("/api/catalog/search?name=Pik").status_code == 401
    assert client.get(f'/api/catalog/printings/{uuid4()}', headers=headers(USER, "GET", f'/api/catalog/printings/{uuid4()}')).status_code == 401
