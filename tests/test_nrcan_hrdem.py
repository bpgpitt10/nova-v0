"""NRCan HRDEM (Canada) elevation: STAC parsing and COG window reads onto a course grid."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "course_model"))
import nrcan_hrdem  # noqa: E402


def feature(fid, dtm=True, dsm=True):
    assets = {}
    if dtm:
        assets["dtm"] = {"href": f"https://example.test/{fid}-dtm.tif"}
    if dsm:
        assets["dsm"] = {"href": f"https://example.test/{fid}-dsm.tif"}
    assets["thumbnail"] = {"href": f"https://example.test/{fid}.png"}
    return {"id": fid, "assets": assets}


def test_search_takes_the_first_collection_with_dtm(monkeypatch):
    calls = []

    def fake_post(url, body, **_):
        calls.append(body["collections"][0])
        if body["collections"][0] == "hrdem-mosaic-1m":
            return {"features": []}
        return {"features": [feature("a"), feature("b", dsm=False), feature("c", dtm=False)]}

    monkeypatch.setattr(nrcan_hrdem, "_post_json", fake_post)
    found = nrcan_hrdem.search((-61.31, 46.23, -61.27, 46.26))
    assert calls == ["hrdem-mosaic-1m", "hrdem-lidar"]
    assert found["collection"] == "hrdem-lidar"
    assert [i["id"] for i in found["items"]] == ["a", "b"]
    assert found["items"][0]["dsm"].endswith("a-dsm.tif")
    assert found["items"][1]["dsm"] is None
    assert nrcan_hrdem.describe(found)["hasDsm"] is True


def test_search_none_when_nothing_covers(monkeypatch):
    monkeypatch.setattr(nrcan_hrdem, "_post_json", lambda *a, **k: {"features": []})
    assert nrcan_hrdem.search((0, 0, 1, 1)) is None


def test_asset_key_variants():
    assert nrcan_hrdem._asset_href({"DTM": {"href": "https://x/dtm.tif"}}, "dtm") == "https://x/dtm.tif"
    assert nrcan_hrdem._asset_href({"dsm-cog": {"href": "https://x/s.tif"}}, "dsm") == "https://x/s.tif"
    assert nrcan_hrdem._asset_href({"thumbnail": {"href": "https://x/t.png"}}, "dtm") is None


def test_read_to_grid_reprojects_a_window_and_mosaics(tmp_path):
    np = pytest.importorskip("numpy")
    rasterio = pytest.importorskip("rasterio")
    from affine import Affine

    # Two 1 m tiles in Canada Atlas Lambert (EPSG:3979), side by side, with a
    # plane z = 100 + 0.01 * x so values can be checked after reprojection.
    def write(path, x0):
        h, w = 400, 400
        transform = Affine(1.0, 0.0, x0, 0.0, -1.0, 1_000_400.0)
        xs = x0 + np.arange(w) + 0.5
        data = np.tile(100 + 0.01 * (xs - 2_400_000), (h, 1)).astype("float32")
        with rasterio.open(path, "w", driver="GTiff", width=w, height=h, count=1, dtype="float32",
                           crs="EPSG:3979", transform=transform, nodata=-9999.0) as dst:
            dst.write(data, 1)
        return str(path)

    a = write(tmp_path / "a.tif", 2_400_000.0)
    b = write(tmp_path / "b.tif", 2_400_400.0)
    # Target: a 300 m x 100 m box straddling both tiles, 1 m, same CRS.
    dst = Affine(1.0, 0.0, 2_400_250.0, 0.0, -1.0, 1_000_300.0)
    grid = nrcan_hrdem.read_to_grid([a, b], "EPSG:3979", dst, 300, 100)
    assert grid.shape == (100, 300)
    assert np.isfinite(grid).mean() > 0.99
    x_mid = 2_400_250.0 + 150.5
    assert abs(grid[50, 150] - (100 + 0.01 * (x_mid - 2_400_000))) < 0.02
    # A target fully outside every tile stays NaN.
    far = nrcan_hrdem.read_to_grid([a, b], "EPSG:3979", Affine(1, 0, 0, 0, -1, 0), 10, 10)
    assert np.isnan(far).all()
