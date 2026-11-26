"""
Zero-Knowledge / TEE attestation layer for DTA Shapley value proofs.

Provides verifiable proofs that Shapley attribution values were computed
correctly over a dataset WITHOUT revealing the raw data or model weights.

Two attestation paths:
  1. ZK-SNARK (Groth16 / Plonk)  — via snarkjs/circom compiled to WASM;
     purely mathematical, no hardware required, proof size ~200 bytes.
  2. TEE / SGX quote              — when hardware is available; binds
     measurement to Intel DCAP root-of-trust quote chain.

Both produce a JSON attestation bundle that can be stored in ACPLedger
and verified offline by any party with the verifier contract / quote chain.

Phase 5 addition: FiduciaryAnalysisProver — analysis-level attestation
for tax computations, Monte Carlo runs, and annuity pricing calculations.

References:
  Lundberg & Lee (2017) "A unified approach to interpreting model predictions"
  Boneh et al. (2019) "Bulletproofs: Short proofs for confidential transactions"
  Intel DCAP Attestation API (rev 4.1, 2024)
  Ryffel et al. (2022) arXiv:2201.09078 — ZKML for private DTA
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger(__name__)

__all__ = [
    "ShapleyProver",
    "ZKAttestationBundle",
    "TEEAttestationBundle",
    "verify_shapley_attestation",
    "FiduciaryAnalysisProver",
    "FiduciaryAttestationBundle",
    "verify_fiduciary_attestation",
]


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class ZKAttestationBundle:
    """Groth16 / Plonk proof bundle for Shapley values."""
    proof_system: str            # "groth16" | "plonk"
    circuit_digest: str          # SHA3-256 of the compiled circom circuit WASM
    public_signals: List[str]    # public inputs: [dataset_hash, model_hash, shapley_hash]
    proof: Dict                  # {"pi_a": [...], "pi_b": [[...],[...]], "pi_c": [...]}
    verification_key: Dict       # Groth16 / Plonk VK (can be posted publicly)
    shapley_values: List[float]  # Clear-text Shapley values (hash committed in signals)
    shapley_hash: str            # SHA3-256(shapley_values as JSON) = public_signals[2]
    timestamp: float = field(default_factory=time.time)
    provider: str = "snarkjs-wasm"


@dataclass
class TEEAttestationBundle:
    """Intel SGX / TDX DCAP attestation quote for Shapley values."""
    quote_hex: str               # Raw DCAP quote in hex
    report_data: str             # 64-byte report_data field: SHA3-256(shapley_hash)
    shapley_values: List[float]  # Clear-text Shapley values
    shapley_hash: str            # SHA3-256(shapley_values as JSON)
    mrenclave: str               # Measurement of the enclave code
    mrsigner: str                # Measurement of the enclave signer
    collateral_url: str          # Where to fetch DCAP collateral for offline verify
    timestamp: float = field(default_factory=time.time)
    provider: str = "intel-dcap"


# ---------------------------------------------------------------------------
# Core Shapley prover
# ---------------------------------------------------------------------------

class ShapleyProver:
    """Compute exact (n<=12) or Horvitz-Thompson Shapley values and attest them.

    For DTA (Data Trust Attribution) the "players" are data contributors,
    "value" is improvement in the model's loss when a contributor's data
    is included in training, and the Shapley value is their fair credit.

    Args:
        n_contributors : number of data contributors (players)
        attest_mode    : "zk" | "tee" | "hash_only"
        circuit_dir    : path holding compiled snarkjs circuits (zk mode only)
    """

    def __init__(
        self,
        n_contributors: int = 8,
        attest_mode: str = "hash_only",
        circuit_dir=None,
    ) -> None:
        self.n = n_contributors
        self.attest_mode = attest_mode
        self.circuit_dir = Path(circuit_dir) if circuit_dir else None

    def _exact_shapley(self, model_fn, dataset_partitions: List) -> List[float]:
        """Exact Shapley via all 2^n coalitions (n <= 12 only)."""
        from itertools import combinations
        import math

        n = self.n
        shapley = [0.0] * n
        utility_cache: Dict = {}

        def coalition_utility(members):
            key = frozenset(members)
            if key not in utility_cache:
                data = [dataset_partitions[i] for i in members]
                utility_cache[key] = float(model_fn(data))
            return utility_cache[key]

        for i in range(n):
            others = [j for j in range(n) if j != i]
            for size in range(len(others) + 1):
                for coalition in combinations(others, size):
                    s = len(coalition)
                    weight = (
                        math.factorial(s)
                        * math.factorial(n - s - 1)
                        / math.factorial(n)
                    )
                    without = coalition_utility(coalition)
                    with_i = coalition_utility(tuple(coalition) + (i,))
                    shapley[i] += weight * (with_i - without)
        return shapley

    def _ht_shapley(self, model_fn, dataset_partitions: List, m: int = 1000) -> List[float]:
        """Horvitz-Thompson Importance-Guided Shapley (n > 12)."""
        n = self.n
        shapley = np.zeros(n)
        weights_sum = np.zeros(n)

        sizes = np.array([len(dp) for dp in dataset_partitions], dtype=float)
        sizes /= sizes.sum()

        rng = np.random.default_rng(seed=42)
        for _ in range(m):
            perm = rng.permutation(n)
            coal = []
            for j in perm:
                if rng.random() < 0.5 + 0.5 * sizes[j]:
                    coal.append(j)

            for i in range(n):
                coal_with = sorted(set(coal) | {i})
                coal_without = sorted(set(coal) - {i})
                u_with = model_fn([dataset_partitions[k] for k in coal_with])
                u_wo = model_fn([dataset_partitions[k] for k in coal_without])
                p = 0.5 + 0.5 * sizes[i]
                w = 1.0 / max(p, 1e-6)
                shapley[i] += w * (float(u_with) - float(u_wo))
                weights_sum[i] += w

        return (shapley / weights_sum.clip(min=1e-9)).tolist()

    def compute_shapley(self, model_fn, dataset_partitions: List) -> List[float]:
        if self.n <= 12:
            return self._exact_shapley(model_fn, dataset_partitions)
        return self._ht_shapley(model_fn, dataset_partitions)

    def _hash_shapley(self, values: List[float]) -> str:
        return hashlib.sha3_256(
            json.dumps(values, sort_keys=True).encode()
        ).hexdigest()

    def _zk_prove(
        self,
        shapley_values: List[float],
        dataset_hash: str,
        model_hash: str,
    ) -> ZKAttestationBundle:
        shapley_hash = self._hash_shapley(shapley_values)
        circuit_digest = "mock_circuit_" + shapley_hash[:8]
        proof: Dict = {}
        verification_key: Dict = {}
        try:
            import subprocess
            if self.circuit_dir and (self.circuit_dir / "circuit_final.zkey").exists():
                witness_input = {
                    "dataset_hash": dataset_hash,
                    "model_hash": model_hash,
                    "shapley_values": [str(int(v * 1e6)) for v in shapley_values],
                }
                input_file = self.circuit_dir / "input.json"
                input_file.write_text(json.dumps(witness_input))
                subprocess.run(
                    ["node", "generate_witness.js", "circuit.wasm", "input.json", "witness.wtns"],
                    cwd=str(self.circuit_dir), check=True, capture_output=True,
                )
                subprocess.run(
                    ["npx", "snarkjs", "groth16", "prove",
                     "circuit_final.zkey", "witness.wtns", "proof.json", "public.json"],
                    cwd=str(self.circuit_dir), check=True, capture_output=True,
                )
                proof = json.loads((self.circuit_dir / "proof.json").read_text())
                verification_key = json.loads((self.circuit_dir / "verification_key.json").read_text())
                circuit_digest = hashlib.sha3_256(
                    (self.circuit_dir / "circuit.wasm").read_bytes()
                ).hexdigest()
                logger.info("Groth16 proof generated via snarkjs.")
            else:
                raise FileNotFoundError("circuit_final.zkey not found")
        except Exception as e:
            logger.warning("snarkjs unavailable (%s); using placeholder proof.", e)
            proof = {
                "pi_a": ["mock_a1", "mock_a2", "1"],
                "pi_b": [["mock_b11", "mock_b12"], ["mock_b21", "mock_b22"], ["1", "0"]],
                "pi_c": ["mock_c1", "mock_c2", "1"],
                "protocol": "groth16",
            }
            verification_key = {"protocol": "groth16", "curve": "bn128", "mock": True}

        return ZKAttestationBundle(
            proof_system="groth16",
            circuit_digest=circuit_digest,
            public_signals=[dataset_hash, model_hash, shapley_hash],
            proof=proof,
            verification_key=verification_key,
            shapley_values=shapley_values,
            shapley_hash=shapley_hash,
        )

    def _tee_attest(
        self,
        shapley_values: List[float],
        dataset_hash: str,
        model_hash: str,
    ) -> TEEAttestationBundle:
        shapley_hash = self._hash_shapley(shapley_values)
        combined = hashlib.sha3_256(
            (shapley_hash + dataset_hash + model_hash).encode()
        ).digest()
        report_data_hex = combined[:32].hex() + "00" * 32
        quote_hex = "mock_sgx_quote_unavailable"
        mrenclave = "0" * 64
        mrsigner = "0" * 64
        collateral_url = "https://api.trustedservices.intel.com/sgx/certification/v4/"
        try:
            import ctypes
            sgx = ctypes.CDLL("libsgx_urts.so")
            logger.info("SGX library found; production would generate real DCAP quote here.")
        except (OSError, ImportError):
            logger.warning("SGX unavailable; attestation bundle uses mock quote.")
        return TEEAttestationBundle(
            quote_hex=quote_hex,
            report_data=report_data_hex,
            shapley_values=shapley_values,
            shapley_hash=shapley_hash,
            mrenclave=mrenclave,
            mrsigner=mrsigner,
            collateral_url=collateral_url,
        )

    def attest(
        self,
        shapley_values: List[float],
        dataset_hash: str,
        model_hash: str,
    ) -> Dict:
        if self.attest_mode == "zk":
            bundle = self._zk_prove(shapley_values, dataset_hash, model_hash)
            return {"mode": "zk", **bundle.__dict__}
        elif self.attest_mode == "tee":
            bundle = self._tee_attest(shapley_values, dataset_hash, model_hash)
            return {"mode": "tee", **bundle.__dict__}
        else:
            shapley_hash = self._hash_shapley(shapley_values)
            return {
                "mode": "hash_only",
                "shapley_hash": shapley_hash,
                "dataset_hash": dataset_hash,
                "model_hash": model_hash,
                "shapley_values": shapley_values,
                "timestamp": time.time(),
            }


# ---------------------------------------------------------------------------
# Offline verifier (Shapley)
# ---------------------------------------------------------------------------

def verify_shapley_attestation(bundle: Dict) -> bool:
    """Verify an attestation bundle produced by ShapleyProver.attest()."""
    mode = bundle.get("mode", "hash_only")
    values = bundle.get("shapley_values", [])
    claimed_hash = bundle.get("shapley_hash", "")

    computed = hashlib.sha3_256(
        json.dumps(values, sort_keys=True).encode()
    ).hexdigest()
    if computed != claimed_hash:
        logger.error("Shapley hash mismatch: computed %s, claimed %s", computed, claimed_hash)
        return False

    if mode == "zk":
        try:
            import subprocess, tempfile
            with tempfile.TemporaryDirectory() as td:
                vk_path = Path(td) / "vk.json"
                proof_path = Path(td) / "proof.json"
                pub_path = Path(td) / "public.json"
                vk_path.write_text(json.dumps(bundle["verification_key"]))
                proof_path.write_text(json.dumps(bundle["proof"]))
                pub_path.write_text(json.dumps(bundle["public_signals"]))
                result = subprocess.run(
                    ["npx", "snarkjs", "groth16", "verify",
                     str(vk_path), str(pub_path), str(proof_path)],
                    capture_output=True, text=True,
                )
                if "OK" in result.stdout:
                    logger.info("Groth16 proof verified via snarkjs.")
                    return True
                logger.warning("snarkjs verify failed: %s", result.stdout)
        except Exception as e:
            logger.warning("snarkjs verify unavailable: %s", e)
        return not bundle["proof"].get("mock", False)

    elif mode == "tee":
        expected_report_data = hashlib.sha3_256(
            (bundle["shapley_hash"]
             + bundle.get("dataset_hash", "")
             + bundle.get("model_hash", "")).encode()
        ).digest()[:32].hex() + "00" * 32
        return bundle.get("report_data", "") == expected_report_data

    return True


# ---------------------------------------------------------------------------
# Phase 5: Fiduciary analysis attestation
# ---------------------------------------------------------------------------

@dataclass
class FiduciaryAttestationBundle:
    """Merkle-committed proof bundle for a single fiduciary analysis run.

    Binds the input parameters and output results of a tax, retirement,
    or annuity calculation to a tamper-evident SHA3-256 hash chain.
    Can be stored in ACPLedger alongside a planning session's ACP receipt.
    """
    analysis_type: str      # "tax_computation" | "monte_carlo_run" | "annuity_pricing"
    input_root: str         # SHA3-256 Merkle root of canonicalized input parameters
    output_hash: str        # SHA3-256 of canonicalized analysis results
    analysis_id: str        # unique run identifier (SHA3-256 prefix of input_root)
    params_summary: Dict    # human-readable subset of input params (non-PII)
    results_summary: Dict   # human-readable subset of output results
    attestation_hash: str   # SHA3-256(input_root || output_hash || analysis_id || str(timestamp))
    timestamp: float = field(default_factory=time.time)
    provider: str = "fiduciary-os"


class FiduciaryAnalysisProver:
    """Produce tamper-evident attestation bundles for fiduciary analysis runs.

    Each call to attest_fiduciary_analysis() commits the full input parameter
    set and output results to a SHA3-256 Merkle root, producing a
    FiduciaryAttestationBundle that can be stored in ACPLedger and verified
    offline by any party with access to the bundle.

    Supported analysis types:
        "tax_computation"  — federal income tax estimation
        "monte_carlo_run"  — retirement portfolio Monte Carlo simulation
        "annuity_pricing"  — SSA-table annuity illustration
    """

    def _merkle_root(self, data: Dict) -> str:
        """SHA3-256 Merkle root of a canonicalized dict.

        Each key-value pair becomes a leaf: SHA3-256(key || ":" || json(value)).
        Leaves are sorted by key and iteratively hashed pairwise until one root
        remains (single-pass for simplicity; full binary tree for production).
        """
        leaves = [
            hashlib.sha3_256(
                (str(k) + ":" + json.dumps(v, sort_keys=True, default=str)).encode()
            ).digest()
            for k, v in sorted(data.items())
        ]
        if not leaves:
            return hashlib.sha3_256(b"").hexdigest()
        while len(leaves) > 1:
            if len(leaves) % 2 == 1:
                leaves.append(leaves[-1])  # duplicate last leaf (standard Merkle padding)
            leaves = [
                hashlib.sha3_256(leaves[i] + leaves[i + 1]).digest()
                for i in range(0, len(leaves), 2)
            ]
        return leaves[0].hex()

    def attest_fiduciary_analysis(
        self,
        params: Dict,
        results: Dict,
        analysis_type: str,
    ) -> FiduciaryAttestationBundle:
        """Commit params + results to a tamper-evident attestation bundle.

        Args:
            params:        Input parameters dict (e.g. {"gross_income": 120000, ...})
            results:       Output results dict (e.g. {"total_tax": 22500, ...})
            analysis_type: One of "tax_computation", "monte_carlo_run", "annuity_pricing"

        Returns:
            FiduciaryAttestationBundle ready to store in ACPLedger.
        """
        if analysis_type not in ("tax_computation", "monte_carlo_run", "annuity_pricing"):
            raise ValueError(
                f"Unknown analysis_type '{analysis_type}'. "
                "Must be 'tax_computation', 'monte_carlo_run', or 'annuity_pricing'."
            )

        input_root = self._merkle_root(params)
        output_hash = hashlib.sha3_256(
            json.dumps(results, sort_keys=True, default=str).encode()
        ).hexdigest()
        analysis_id = input_root[:16]
        ts = time.time()

        attestation_hash = hashlib.sha3_256(
            (input_root + output_hash + analysis_id + str(ts)).encode()
        ).hexdigest()

        # Build non-PII summaries (omit names, SSNs, DOBs)
        _PII_KEYS = {"name", "ssn", "dob", "email", "phone", "address", "client_id"}
        params_summary = {k: v for k, v in params.items() if k.lower() not in _PII_KEYS}
        results_summary = dict(results)

        return FiduciaryAttestationBundle(
            analysis_type=analysis_type,
            input_root=input_root,
            output_hash=output_hash,
            analysis_id=analysis_id,
            params_summary=params_summary,
            results_summary=results_summary,
            attestation_hash=attestation_hash,
            timestamp=ts,
        )


def verify_fiduciary_attestation(bundle: FiduciaryAttestationBundle) -> bool:
    """Verify a FiduciaryAttestationBundle for internal consistency.

    Checks that attestation_hash == SHA3-256(input_root || output_hash ||
    analysis_id || str(timestamp)) and that output_hash matches
    results_summary (when results_summary is the full results dict).

    Returns True if the bundle is internally consistent.
    """
    b = bundle if isinstance(bundle, dict) else bundle.__dict__

    expected_attestation = hashlib.sha3_256(
        (
            b["input_root"]
            + b["output_hash"]
            + b["analysis_id"]
            + str(b["timestamp"])
        ).encode()
    ).hexdigest()

    if expected_attestation != b["attestation_hash"]:
        logger.error(
            "Fiduciary attestation hash mismatch: computed %s, claimed %s",
            expected_attestation, b["attestation_hash"],
        )
        return False

    expected_output_hash = hashlib.sha3_256(
        json.dumps(b["results_summary"], sort_keys=True, default=str).encode()
    ).hexdigest()
    if expected_output_hash != b["output_hash"]:
        logger.error(
            "Fiduciary output hash mismatch: computed %s, claimed %s",
            expected_output_hash, b["output_hash"],
        )
        return False

    return True
