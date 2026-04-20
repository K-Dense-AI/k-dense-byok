"""Unit tests for ``kady_agent/anndata_preview.py``.

Builds a tiny in-memory AnnData, writes it to tmp_path, and exercises the
summary + embedding PNG pipeline end-to-end.
"""

from __future__ import annotations

from pathlib import Path

import pytest

anndata = pytest.importorskip("anndata")
np = pytest.importorskip("numpy")
pd = pytest.importorskip("pandas")

from kady_agent import anndata_preview as ap


@pytest.fixture
def tiny_h5ad(tmp_path: Path) -> Path:
    n_obs, n_vars = 40, 6
    rng = np.random.default_rng(0)
    X = rng.random((n_obs, n_vars), dtype=np.float32)
    obs = pd.DataFrame(
        {
            "cell_type": pd.Categorical(
                ["A", "B", "A", "C"] * (n_obs // 4)
            ),
            "n_counts": np.linspace(1.0, 100.0, n_obs),
            "is_doublet": [i % 5 == 0 for i in range(n_obs)],
        },
        index=[f"cell-{i}" for i in range(n_obs)],
    )
    var = pd.DataFrame(
        {"gene_symbol": [f"G{i}" for i in range(n_vars)]},
        index=[f"gene-{i}" for i in range(n_vars)],
    )
    obsm = {
        "X_umap": rng.normal(size=(n_obs, 2)).astype(np.float32),
        "X_pca": rng.normal(size=(n_obs, 3)).astype(np.float32),
        "X_bad": rng.random((n_obs, 1)).astype(np.float32),  # <2 dims, skipped
    }
    adata = anndata.AnnData(X=X, obs=obs, var=var, obsm=obsm)
    adata.layers["normalized"] = X * 2
    out = tmp_path / "tiny.h5ad"
    adata.write_h5ad(out)
    return out


def test_summarize_h5ad_basic_shape(tiny_h5ad: Path):
    summary = ap.summarize_h5ad(tiny_h5ad)
    assert summary["n_obs"] == 40
    assert summary["n_vars"] == 6
    assert summary["X"]["shape"] == [40, 6]
    assert any(layer["name"] == "normalized" for layer in summary["layers"])

    embeddings = {e["key"]: e for e in summary["embeddings"]}
    assert "X_umap" in embeddings
    assert "X_pca" in embeddings
    assert "X_bad" not in embeddings  # <2 columns
    assert summary["default_embedding"] == "X_umap"

    cols = {c["name"]: c for c in summary["obs_columns"]}
    assert cols["cell_type"]["dtype"] == "categorical"
    assert cols["is_doublet"]["dtype"] == "bool"
    assert "min" in cols["n_counts"] and "max" in cols["n_counts"]


def test_render_embedding_png_caches(tiny_h5ad: Path, tmp_path: Path):
    cache = tmp_path / "cache"
    data_a = ap.render_embedding_png(tiny_h5ad, "X_umap", None, cache)
    assert data_a.startswith(b"\x89PNG")

    # Cached hit: same bytes.
    data_b = ap.render_embedding_png(tiny_h5ad, "X_umap", None, cache)
    assert data_b == data_a
    # Exactly one PNG in the cache.
    pngs = list(cache.glob("*.png"))
    assert len(pngs) == 1


def test_render_embedding_png_different_color_new_cache_entry(
    tiny_h5ad: Path, tmp_path: Path
):
    cache = tmp_path / "cache"
    ap.render_embedding_png(tiny_h5ad, "X_umap", None, cache)
    ap.render_embedding_png(tiny_h5ad, "X_umap", "cell_type", cache)
    pngs = list(cache.glob("*.png"))
    assert len(pngs) == 2


def test_render_embedding_png_missing_key_raises(tiny_h5ad: Path, tmp_path: Path):
    with pytest.raises(KeyError):
        ap.render_embedding_png(tiny_h5ad, "X_missing", None, tmp_path / "c")


def test_jsonable_coerces_nan():
    assert ap._jsonable(float("nan")) is None
    assert ap._jsonable(float("inf")) is None
    assert ap._jsonable([1, float("nan"), 3]) == [1, None, 3]


def test_default_embedding_priority_order():
    assert ap._default_embedding([{"key": "X_pca"}, {"key": "X_umap"}]) == "X_umap"
    assert ap._default_embedding([{"key": "X_tsne"}]) == "X_tsne"
    assert ap._default_embedding([]) is None
