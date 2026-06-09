"""Standalone .h5ad preview helper invoked by the TS backend as a subprocess.

This is the only Python left in the app — not a service, just a CLI the Node
server shells out to for AnnData introspection/plotting (h5py/anndata/matplotlib
have no practical TS equivalent). Ported from kady_agent/anndata_preview.py.

Usage:
  python anndata_helper.py summarize <h5ad_path>
      -> prints JSON summary to stdout
  python anndata_helper.py embedding <h5ad_path> <obsm_key> <color|-> <cache_dir> <out_png>
      -> writes a 320x320 PNG to <out_png>

Exit codes: 0 ok; 3 deps missing; 4 not found (KeyError); 5 bad value; 1 other.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import sys
from pathlib import Path
from typing import Any, Optional

_EMBEDDING_PRIORITY = ("X_umap", "X_tsne", "X_pca")
_EMBEDDING_PREFIXES = ("X_umap", "X_tsne", "X_pca", "X_draw_graph", "X_spatial")
_MAX_POINTS = 20_000
_COL_PREVIEW_LIMIT = 200
_CATEGORICAL_TOP_N = 5


class DepsMissing(RuntimeError):
    pass


def _import_anndata():
    try:
        import anndata as ad
        return ad
    except ImportError as exc:
        raise DepsMissing("anndata is not installed (uv add anndata h5py matplotlib scipy)") from exc


def _import_matplotlib():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        return matplotlib, plt
    except ImportError as exc:
        raise DepsMissing("matplotlib is not installed (uv add anndata h5py matplotlib scipy)") from exc


def _jsonable(value: Any) -> Any:
    if value is None:
        return None
    try:
        import numpy as np
    except ImportError:
        np = None
    if np is not None:
        if isinstance(value, np.generic):
            item = value.item()
            if isinstance(item, float) and (math.isnan(item) or math.isinf(item)):
                return None
            return item
        if isinstance(value, np.ndarray):
            return [_jsonable(v) for v in value.tolist()]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _column_stats(series) -> dict:
    import numpy as np
    import pandas as pd

    dtype = str(series.dtype)
    n = len(series)
    if isinstance(series.dtype, pd.CategoricalDtype) or dtype == "category":
        cats = list(series.cat.categories[:_CATEGORICAL_TOP_N])
        vc = series.value_counts(dropna=True).head(_CATEGORICAL_TOP_N)
        return {
            "dtype": "categorical",
            "n_unique": int(series.cat.categories.size),
            "categories": [_jsonable(c) for c in cats],
            "top": [{"value": _jsonable(idx), "count": int(cnt)} for idx, cnt in vc.items()],
        }
    if pd.api.types.is_numeric_dtype(series):
        arr = series.to_numpy()
        arr = arr[~pd.isna(arr)] if arr.size else arr
        if arr.size == 0:
            return {"dtype": dtype, "n_unique": 0}
        return {
            "dtype": dtype,
            "n_unique": int(pd.Series(arr).nunique()),
            "min": _jsonable(float(np.min(arr))),
            "max": _jsonable(float(np.max(arr))),
            "mean": _jsonable(float(np.mean(arr))),
        }
    if pd.api.types.is_bool_dtype(series):
        return {"dtype": "bool", "n_unique": int(series.nunique(dropna=True)),
                "n_true": int(series.sum()), "n_false": int(n - series.sum())}
    vc = series.astype(str).value_counts(dropna=True).head(_CATEGORICAL_TOP_N)
    return {"dtype": dtype, "n_unique": int(series.nunique(dropna=True)),
            "top": [{"value": str(idx), "count": int(cnt)} for idx, cnt in vc.items()]}


def _describe_dataframe(df, limit: int = _COL_PREVIEW_LIMIT) -> list:
    cols = list(df.columns)
    selected = cols[:limit] if len(cols) > limit else cols
    out = []
    for name in selected:
        try:
            stats = _column_stats(df[name])
        except Exception as exc:
            stats = {"dtype": "unknown", "error": str(exc)}
        out.append({"name": str(name), **stats})
    return out


def _matrix_info(mat) -> dict:
    info: dict = {}
    shape = getattr(mat, "shape", None)
    if shape is not None:
        info["shape"] = [int(s) for s in shape]
    dtype = getattr(mat, "dtype", None)
    if dtype is not None:
        info["dtype"] = str(dtype)
    try:
        import scipy.sparse as sp
        info["sparse"] = bool(sp.issparse(mat))
    except ImportError:
        info["sparse"] = False
    return info


def _list_embeddings(obsm_keys, obsm) -> list:
    out = []
    for key in obsm_keys:
        try:
            arr = obsm[key]
            shape = getattr(arr, "shape", None)
            if shape is None or len(shape) < 2 or shape[1] < 2:
                continue
        except Exception:
            continue
        if not any(key == p or key.startswith(p + "_") or key.startswith(p) for p in _EMBEDDING_PREFIXES):
            continue
        out.append({"key": key, "shape": [int(s) for s in shape]})
    return out


def _default_embedding(embeddings) -> Optional[str]:
    keys = {e["key"] for e in embeddings}
    for pref in _EMBEDDING_PRIORITY:
        if pref in keys:
            return pref
    return embeddings[0]["key"] if embeddings else None


def summarize(path: Path) -> dict:
    ad = _import_anndata()
    try:
        from importlib.metadata import version as _pkg_version
        anndata_version = _pkg_version("anndata")
    except Exception:
        anndata_version = getattr(ad, "__version__", "unknown")
    adata = ad.read_h5ad(str(path), backed="r")
    try:
        obsm_keys = list(adata.obsm.keys()) if adata.obsm is not None else []
        embeddings = _list_embeddings(obsm_keys, adata.obsm)
        try:
            x_info = _matrix_info(adata.X) if adata.X is not None else {}
        except Exception as exc:
            x_info = {"error": str(exc)}
        layers = []
        if adata.layers is not None:
            for name in list(adata.layers.keys()):
                try:
                    layers.append({"name": name, **_matrix_info(adata.layers[name])})
                except Exception as exc:
                    layers.append({"name": name, "error": str(exc)})
        return {
            "n_obs": int(adata.n_obs),
            "n_vars": int(adata.n_vars),
            "X": x_info,
            "layers": layers,
            "obs_columns": _describe_dataframe(adata.obs),
            "var_columns": _describe_dataframe(adata.var),
            "obs_column_count": int(adata.obs.shape[1]),
            "var_column_count": int(adata.var.shape[1]),
            "obsm_keys": obsm_keys,
            "varm_keys": list(adata.varm.keys()) if adata.varm is not None else [],
            "uns_keys": [str(k) for k in (adata.uns.keys() if adata.uns is not None else [])],
            "obsp_keys": list(adata.obsp.keys()) if adata.obsp is not None else [],
            "varp_keys": list(adata.varp.keys()) if adata.varp is not None else [],
            "embeddings": embeddings,
            "default_embedding": _default_embedding(embeddings),
            "file_size": int(path.stat().st_size),
            "anndata_version": anndata_version,
        }
    finally:
        try:
            adata.file.close()
        except Exception:
            pass


def _cache_key(path: Path, key: str, color: Optional[str]) -> str:
    raw = f"{path.resolve()}|{path.stat().st_mtime_ns}|{key}|{color or ''}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def render_embedding(path: Path, key: str, color: Optional[str], cache_dir: Path, out_png: Path) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"{_cache_key(path, key, color)}.png"
    if cached.is_file():
        out_png.write_bytes(cached.read_bytes())
        return
    ad = _import_anndata()
    _, plt = _import_matplotlib()
    import numpy as np

    adata = ad.read_h5ad(str(path), backed="r")
    try:
        if adata.obsm is None or key not in adata.obsm:
            raise KeyError(f"obsm key not found: {key}")
        coords = np.asarray(adata.obsm[key])
        if coords.ndim < 2 or coords.shape[1] < 2:
            raise ValueError(f"obsm[{key}] is not a 2D embedding")
        xs = coords[:, 0].astype(float)
        ys = coords[:, 1].astype(float)
        color_values = None
        color_is_categorical = False
        if color:
            try:
                import pandas as pd
                if color in adata.obs.columns:
                    series = adata.obs[color]
                    if isinstance(series.dtype, pd.CategoricalDtype) or not pd.api.types.is_numeric_dtype(series):
                        codes, _ = pd.factorize(series, sort=True)
                        color_values = codes.astype(float)
                        color_is_categorical = True
                    else:
                        color_values = series.to_numpy(dtype=float)
            except Exception:
                color_values = None
        n = xs.shape[0]
        if n > _MAX_POINTS:
            rng = np.random.default_rng(seed=0)
            idx = rng.choice(n, size=_MAX_POINTS, replace=False)
            xs, ys = xs[idx], ys[idx]
            if color_values is not None:
                color_values = color_values[idx]
        fig, ax = plt.subplots(figsize=(3.2, 3.2), dpi=100)
        try:
            kw = {"s": 4, "linewidths": 0, "alpha": 0.7}
            if color_values is not None:
                ax.scatter(xs, ys, c=color_values, cmap="tab20" if color_is_categorical else "viridis", **kw)
            else:
                ax.scatter(xs, ys, c="#6366f1", **kw)
            ax.set_xticks([]); ax.set_yticks([])
            for spine in ax.spines.values():
                spine.set_visible(False)
            ax.set_aspect("equal", adjustable="datalim")
            fig.tight_layout(pad=0.1)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", dpi=100, bbox_inches="tight", pad_inches=0.05)
        finally:
            plt.close(fig)
        data = buf.getvalue()
    finally:
        try:
            adata.file.close()
        except Exception:
            pass
    out_png.write_bytes(data)
    try:
        cached.write_bytes(data)
    except OSError:
        pass


def main(argv: list) -> int:
    try:
        cmd = argv[1]
        if cmd == "summarize":
            print(json.dumps(summarize(Path(argv[2]))))
            return 0
        if cmd == "embedding":
            color = argv[4]
            render_embedding(Path(argv[2]), argv[3], None if color == "-" else color, Path(argv[5]), Path(argv[6]))
            return 0
        sys.stderr.write(f"unknown command: {cmd}\n")
        return 1
    except DepsMissing as exc:
        sys.stderr.write(str(exc) + "\n")
        return 3
    except KeyError as exc:
        sys.stderr.write(str(exc) + "\n")
        return 4
    except ValueError as exc:
        sys.stderr.write(str(exc) + "\n")
        return 5
    except Exception as exc:
        sys.stderr.write(str(exc) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
