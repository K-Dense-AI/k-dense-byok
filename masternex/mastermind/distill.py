"""
Knowledge distillation from frontier models into Mastermind via the BYOK gateway.

Three distillation modes:
  1. top-k logit distillation  – soft cross-entropy on top-K teacher log-probs
                                  (requires teacher to return per-token logprobs)
  2. sequence-level KD         – generate teacher trajectories, train student
                                  with hard labels (works with any BYOK provider)
  3. speculative verification  – use Mastermind as draft, teacher as verifier,
                                  build preference pairs for SimPO/DPO

References:
  Hinton et al. (2015) "Distilling the knowledge in a neural network"
  Gu et al. (2024) "MiniLLM: Knowledge distillation of large language models"
  Kim & Rush (2016) "Sequence-level knowledge distillation"
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import torch
import torch.nn.functional as F

logger = logging.getLogger(__name__)

__all__ = [
    "DistillConfig",
    "DistillCorpusBuilder",
    "logit_distill_loss",
    "sequence_kd_loss",
]


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass
class DistillConfig:
    """Configuration for knowledge distillation runs."""
    # Teacher provider (must be configured in BYOK gateway)
    teacher_provider: str = "openrouter"           # or "anthropic", "openai", "mastermind_local"
    teacher_model: str = "qwen/qwen2.5-7b-instruct"
    temperature: float = 1.0                        # teacher sampling temperature
    top_k_logits: int = 50                          # logits to request from teacher
    max_tokens: int = 256                           # max teacher output tokens

    # Distillation mode
    mode: str = "sequence_kd"   # "sequence_kd" | "logit" | "speculative"

    # Output
    output_dir: str = "runs/distill"
    cache_dir: str = "runs/distill/cache"
    max_examples: int = 10_000

    # Soft-label temperature (Hinton et al.)
    kd_temperature: float = 4.0
    kd_alpha: float = 0.5                           # blend: alpha*KD + (1-alpha)*CE

    # Prompt sources for synthetic trajectory generation
    seed_prompts: List[str] = field(default_factory=lambda: [
        "Write a Python function that",
        "Explain the concept of",
        "Solve the following problem:",
        "What is the best approach to",
    ])


# ---------------------------------------------------------------------------
# Corpus builder: generate & cache teacher trajectories
# ---------------------------------------------------------------------------

class DistillCorpusBuilder:
    """Calls the BYOK gateway to generate teacher trajectories and caches them.

    Uses the existing masternex.connectors.byok.BYOKGateway.  Each trajectory
    is SHA3-256–hashed and stored in the cache directory, so repeated runs
    never re-request the same (prompt, model, temperature) triple.

    Example:
        cfg = DistillConfig(teacher_model="qwen/qwen2.5-7b-instruct")
        builder = DistillCorpusBuilder(cfg)
        builder.build(seed_prompts=cfg.seed_prompts, n_per_prompt=20)
        # → runs/distill/cache/*.jsonl
    """

    def __init__(self, cfg: DistillConfig) -> None:
        self.cfg = cfg
        self.cache = Path(cfg.cache_dir)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.output = Path(cfg.output_dir)
        self.output.mkdir(parents=True, exist_ok=True)

    def _cache_key(self, prompt: str) -> str:
        h = hashlib.sha3_256(
            f"{self.cfg.teacher_provider}/{self.cfg.teacher_model}/"
            f"{self.cfg.temperature}/{prompt}".encode()
        ).hexdigest()[:16]
        return h

    def _load_cached(self, key: str) -> Optional[str]:
        p = self.cache / f"{key}.json"
        if p.exists():
            return json.loads(p.read_text())["completion"]
        return None

    def _save_cached(self, key: str, prompt: str, completion: str) -> None:
        p = self.cache / f"{key}.json"
        p.write_text(json.dumps({"prompt": prompt, "completion": completion}))

    def _call_teacher(self, prompt: str) -> str:
        """Call the BYOK gateway synchronously (runs async loop internally)."""
        import asyncio
        try:
            from masternex.connectors.byok import BYOKGateway  # type: ignore
        except ImportError:
            logger.warning("BYOKGateway not found; returning placeholder completion.")
            return f"[placeholder completion for: {prompt[:40]}]"

        async def _inner():
            gw = BYOKGateway()
            result = await gw.infer(
                provider=self.cfg.teacher_provider,
                model=self.cfg.teacher_model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.cfg.max_tokens,
                temperature=self.cfg.temperature,
            )
            return result.get("content", result.get("text", ""))

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(1) as ex:
                    fut = ex.submit(asyncio.run, _inner())
                    return fut.result(timeout=60)
            else:
                return loop.run_until_complete(_inner())
        except Exception as e:
            logger.warning("Teacher call failed: %s", e)
            return ""

    def build(
        self,
        seed_prompts: Optional[List[str]] = None,
        n_per_prompt: int = 10,
    ) -> Path:
        """Generate and cache `n_per_prompt` completions per seed prompt.

        Returns the path to the merged JSONL corpus file.
        """
        prompts = seed_prompts or self.cfg.seed_prompts
        out_file = self.output / "teacher_corpus.jsonl"
        written = 0
        with open(out_file, "w", encoding="utf-8") as fh:
            for prompt in prompts:
                for _ in range(n_per_prompt):
                    key = self._cache_key(prompt)
                    completion = self._load_cached(key)
                    if completion is None:
                        completion = self._call_teacher(prompt)
                        if completion:
                            self._save_cached(key, prompt, completion)
                    if completion:
                        full_text = prompt + completion
                        fh.write(json.dumps({"text": full_text}) + "\n")
                        written += 1
                        if written >= self.cfg.max_examples:
                            break
                if written >= self.cfg.max_examples:
                    break
        logger.info("DistillCorpusBuilder: wrote %d examples to %s", written, out_file)
        return out_file


# ---------------------------------------------------------------------------
# Loss functions
# ---------------------------------------------------------------------------

def logit_distill_loss(
    student_logits: torch.Tensor,
    teacher_log_probs: torch.Tensor,
    hard_labels: torch.Tensor,
    temperature: float = 4.0,
    alpha: float = 0.5,
    ignore_index: int = -100,
) -> torch.Tensor:
    """Soft-label KD loss (Hinton et al., 2015).

    Args:
        student_logits   : (B, T, V) raw logits from student
        teacher_log_probs: (B, T, V) log-probabilities from teacher
        hard_labels      : (B, T) int — ground-truth next tokens
        temperature      : distillation temperature τ
        alpha            : weight on KD term; (1-alpha) on hard CE
        ignore_index     : token id to ignore in hard CE (default -100)

    Returns:
        scalar loss
    """
    B, T, V = student_logits.shape

    # Soft KD term
    student_soft = F.log_softmax(student_logits / temperature, dim=-1)
    teacher_soft = F.softmax(teacher_log_probs / temperature, dim=-1)
    kd_loss = F.kl_div(student_soft, teacher_soft, reduction="batchmean") * (temperature ** 2)

    # Hard CE term
    ce_loss = F.cross_entropy(
        student_logits.view(B * T, V),
        hard_labels.view(B * T),
        ignore_index=ignore_index,
    )

    return alpha * kd_loss + (1.0 - alpha) * ce_loss


def sequence_kd_loss(
    student_logits: torch.Tensor,
    teacher_tokens: torch.Tensor,
    ignore_index: int = -100,
) -> torch.Tensor:
    """Sequence-level KD: student learns to predict teacher-generated tokens.

    Equivalent to standard cross-entropy on teacher outputs.
    Works with any BYOK provider that returns token text (no logprobs needed).

    Args:
        student_logits : (B, T, V)
        teacher_tokens : (B, T) int   — teacher-generated next tokens
        ignore_index   : id to mask

    Returns:
        scalar CE loss
    """
    B, T, V = student_logits.shape
    return F.cross_entropy(
        student_logits.view(B * T, V),
        teacher_tokens.view(B * T),
        ignore_index=ignore_index,
    )


# ---------------------------------------------------------------------------
# Speculative distillation: build SimPO preference pairs
# ---------------------------------------------------------------------------

def speculative_preference_pairs(
    student_completions: List[str],
    teacher_completions: List[str],
    prompts: List[str],
) -> List[Dict]:
    """Create preference pairs where teacher completion = chosen, student = rejected.

    Used to build a DPO/SimPO dataset without an explicit reward model.
    Format: [{"prompt": ..., "chosen": ..., "rejected": ...}, ...]
    """
    assert len(prompts) == len(student_completions) == len(teacher_completions)
    pairs = []
    for prompt, teacher, student in zip(prompts, teacher_completions, student_completions):
        if teacher and student and teacher != student:
            pairs.append({
                "prompt": prompt,
                "chosen": teacher,     # teacher is preferred
                "rejected": student,   # student draft is rejected
            })
    return pairs
