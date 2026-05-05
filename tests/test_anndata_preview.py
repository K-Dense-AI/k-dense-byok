from __future__ import annotations

import math

import numpy as np
import pandas as pd


def test_jsonable_matrix_and_embedding_helpers() -> None:
    from kady_agent import anndata_preview as preview

    assert preview._jsonable(np.float64(1.5)) == 1.5
    assert preview._jsonable(float("nan")) is None
    assert preview._jsonable(np.array([1, np.nan])) == [1, None]

    matrix = np.ones((2, 3), dtype=np.float32)
    assert preview._matrix_info(matrix) == {
        "shape": [2, 3],
        "dtype": "float32",
        "sparse": False,
    }

    obsm = {
        "X_umap": np.zeros((4, 2)),
        "X_bad": np.zeros((4, 1)),
        "not_embedding": np.zeros((4, 2)),
    }
    embeddings = preview._list_embeddings(list(obsm.keys()), obsm)
    assert embeddings == [{"key": "X_umap", "shape": [4, 2]}]
    assert preview._default_embedding(embeddings) == "X_umap"
    assert preview._default_embedding([]) is None


def test_column_stats_for_common_pandas_dtypes() -> None:
    from kady_agent import anndata_preview as preview

    numeric = preview._column_stats(pd.Series([1.0, 2.0, math.nan]))
    assert numeric["min"] == 1.0
    assert numeric["max"] == 2.0

    categorical = preview._column_stats(pd.Series(pd.Categorical(["a", "b", "a"])))
    assert categorical["dtype"] == "categorical"
    assert categorical["top"][0] == {"value": "a", "count": 2}

    boolean = preview._column_stats(pd.Series([True, False, True], dtype=bool))
    assert boolean["dtype"] == "bool"
    assert boolean["min"] == 0.0
    assert boolean["max"] == 1.0

    text = preview._column_stats(pd.Series(["x", "x", "y"]))
    assert text["top"][0] == {"value": "x", "count": 2}


def test_describe_dataframe_handles_bad_columns(monkeypatch) -> None:
    from kady_agent import anndata_preview as preview

    df = pd.DataFrame({"a": [1], "b": [2]})
    original = preview._column_stats

    def fake_stats(series):
        if series.name == "b":
            raise RuntimeError("bad dtype")
        return original(series)

    monkeypatch.setattr(preview, "_column_stats", fake_stats)
    rows = preview._describe_dataframe(df)
    assert rows[0]["name"] == "a"
    assert rows[1]["error"] == "bad dtype"
