"""
Sequence-packing dataloader for Mastermind pretraining.

Eliminates padding waste by packing variable-length documents into fixed-size
blocks of BLOCK_SIZE bytes, tracking document boundaries so SSM state can be
reset at each boundary (preventing cross-document context leakage).

Data pipeline:
  JSONL corpus  →  ByteTokenizer  →  PackingBuffer  →  PackedBatch

Each PackedBatch carries:
  tokens     : (B, T) int32  raw byte ids
  boundaries : (B, T) bool   True at the first byte of each new document
  labels     : (B, T) int32  same as tokens, shifted right (next-byte prediction)

Usage:
  loader = PackedDataLoader("path/to/corpus.jsonl", block=1024, batch=8)
  for batch in loader:
      model.reset_states_at(batch.boundaries)
      loss = model(batch.tokens, labels=batch.labels)

References:
  Krell et al. (2022) "Efficient sequence packing without cross-contamination"
  Ziegler & Rush (2019) document-boundary state resets in RNN LMs
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Generator, Iterable, List, Optional

import torch

__all__ = [
    "PackedBatch",
    "PackedDataLoader",
    "pack_examples",
]


@dataclass
class PackedBatch:
    tokens: torch.Tensor      # (B, T) int32
    boundaries: torch.Tensor  # (B, T) bool — True = first byte of new doc
    labels: torch.Tensor      # (B, T) int32  (-100 at last position of each doc)
    doc_ids: torch.Tensor     # (B, T) int32  which document each position belongs to


class _PackingBuffer:
    """Greedy first-fit packing buffer.

    Collects tokenised documents and flushes complete blocks of size `block`.
    Each flush returns (tokens, boundaries) for one sequence of exactly `block`
    bytes. Documents that span a block boundary are split; the continuation
    starts with boundary=True in the next block.
    """

    def __init__(self, block: int) -> None:
        self.block = block
        self._buf: List[int] = []
        self._bnd: List[bool] = []  # boundary flags
        self._doc: List[int] = []   # document ids

    def add(self, tokens: List[int], doc_id: int) -> None:
        is_first = True
        for tok in tokens:
            self._buf.append(tok)
            self._bnd.append(is_first)
            self._doc.append(doc_id)
            is_first = False

    def flush_complete(self) -> Generator[tuple, None, None]:
        """Yield complete blocks of size `block` until fewer remain."""
        while len(self._buf) >= self.block:
            yield (
                self._buf[: self.block],
                self._bnd[: self.block],
                self._doc[: self.block],
            )
            self._buf = self._buf[self.block :]
            self._bnd = self._bnd[self.block :]
            self._doc = self._doc[self.block :]

    def flush_final(self) -> Optional[tuple]:
        """Flush a partial block (last block of an epoch), zero-padded."""
        if not self._buf:
            return None
        pad = self.block - len(self._buf)
        toks = self._buf + [0] * pad
        bnds = self._bnd + [False] * pad
        docs = self._doc + [-1] * pad
        self._buf.clear()
        self._bnd.clear()
        self._doc.clear()
        return toks, bnds, docs


def pack_examples(
    token_sequences: Iterable[List[int]],
    block: int = 1024,
    drop_last: bool = True,
) -> Generator[tuple, None, None]:
    """Pack an iterable of token sequences into fixed-size blocks.

    Yields (tokens_list, boundaries_list, doc_ids_list) tuples of length `block`.
    With drop_last=True, the final partial block is discarded.
    """
    buf = _PackingBuffer(block)
    for doc_id, seq in enumerate(token_sequences):
        buf.add(seq, doc_id)
        yield from buf.flush_complete()
    if not drop_last:
        final = buf.flush_final()
        if final is not None:
            yield final


class PackedDataLoader:
    """Iterable dataset + dataloader for packed byte sequences.

    Reads a JSONL corpus where each line has {"text": "..."} or {"bytes": [...]}.
    Tokenises with Mastermind's ByteTokenizer (256 raw bytes + 6 special tokens).

    Args:
        path       : path to JSONL corpus file
        block      : sequence length (tokens per sample)
        batch      : batch size
        shuffle    : shuffle documents each epoch
        seed       : random seed for shuffling
        drop_last  : drop the final partial batch if < batch size
        max_docs   : cap on number of documents to load (None = unlimited)
    """

    # Mastermind special token ids (must match ByteTokenizer in tokenizer.py)
    PAD_ID = 256
    BOS_ID = 257
    EOS_ID = 258

    def __init__(
        self,
        path: str | Path,
        block: int = 1024,
        batch: int = 8,
        shuffle: bool = True,
        seed: int = 42,
        drop_last: bool = True,
        max_docs: Optional[int] = None,
    ) -> None:
        self.path = Path(path)
        self.block = block
        self.batch = batch
        self.shuffle = shuffle
        self.seed = seed
        self.drop_last = drop_last
        self.max_docs = max_docs
        self._rng = random.Random(seed)

    def _load_docs(self) -> List[List[int]]:
        docs: List[List[int]] = []
        with open(self.path, "r", encoding="utf-8") as f:
            for i, line in enumerate(f):
                if self.max_docs and i >= self.max_docs:
                    break
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if "text" in obj:
                    raw = obj["text"].encode("utf-8", errors="replace")
                    tokens = [self.BOS_ID] + list(raw) + [self.EOS_ID]
                elif "bytes" in obj:
                    tokens = [self.BOS_ID] + list(obj["bytes"]) + [self.EOS_ID]
                else:
                    continue
                docs.append(tokens)
        return docs

    def __iter__(self) -> Generator[PackedBatch, None, None]:
        docs = self._load_docs()
        if self.shuffle:
            self._rng.shuffle(docs)

        # Collect packed blocks
        blocks: List[tuple] = list(pack_examples(docs, self.block, self.drop_last))

        # Batch them
        for start in range(0, len(blocks) - self.batch + 1, self.batch):
            batch_blocks = blocks[start : start + self.batch]
            if len(batch_blocks) < self.batch and self.drop_last:
                break

            toks = torch.tensor([b[0] for b in batch_blocks], dtype=torch.int32)
            bnds = torch.tensor([b[1] for b in batch_blocks], dtype=torch.bool)
            docs_t = torch.tensor([b[2] for b in batch_blocks], dtype=torch.int32)

            # Labels: next-byte prediction; -100 at EOS positions
            labels = toks.clone()
            labels[:, :-1] = toks[:, 1:]
            labels[:, -1] = -100

            yield PackedBatch(tokens=toks, boundaries=bnds, labels=labels, doc_ids=docs_t)

    def __len__(self) -> int:
        docs = self._load_docs()
        total_toks = sum(len(d) for d in docs)
        n_blocks = total_toks // self.block
        return n_blocks // self.batch
