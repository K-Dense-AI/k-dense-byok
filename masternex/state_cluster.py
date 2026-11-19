"""
Multi-node state replication for MASTERNEX.os via Postgres + Raft consensus.

MASTERNEX components that need replicated shared state:
  - PRINCE federated gradient aggregations   (consistency: strong)
  - ACPLedger append-only audit rows         (consistency: monotonic)
  - GIE trajectory index (TurboQuantIndex)   (consistency: eventual)
  - Modal job status / durable task state    (consistency: strong)

Architecture:
  StateClusterManager   – Raft leader election + slot assignment
  PGReplicator          – Postgres logical replication via pgoutput WAL
  RaftNode              – Minimal single-process Raft for N ≤ 7 nodes
                          (uses asyncpg for Postgres, no external Raft lib)
  ConsistencyRouter     – Routes writes to leader / nearest replica

References:
  Ongaro & Ousterhout (2014) "In Search of an Understandable Consensus Algorithm"
  PostgreSQL 16 Logical Replication, pgoutput plugin
  Poulain et al. (2025) arXiv:2504.03011 — Raft optimisations for edge clusters
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

__all__ = [
    "RaftNode",
    "RaftRole",
    "StateClusterManager",
    "PGReplicator",
    "ConsistencyRouter",
    "ClusterConfig",
]


# ---------------------------------------------------------------------------
# Raft data types
# ---------------------------------------------------------------------------

class RaftRole(Enum):
    FOLLOWER = "follower"
    CANDIDATE = "candidate"
    LEADER = "leader"


@dataclass
class LogEntry:
    term: int
    index: int
    command: Dict          # {"table": str, "op": str, "row": dict}
    client_id: str = ""
    request_id: str = ""


@dataclass
class RaftState:
    current_term: int = 0
    voted_for: Optional[str] = None
    log: List[LogEntry] = field(default_factory=list)
    commit_index: int = 0
    last_applied: int = 0
    # Volatile
    role: RaftRole = RaftRole.FOLLOWER
    leader_id: Optional[str] = None
    votes_received: int = 0
    next_index: Dict[str, int] = field(default_factory=dict)
    match_index: Dict[str, int] = field(default_factory=dict)
    last_heartbeat: float = field(default_factory=time.time)


@dataclass
class ClusterConfig:
    """Cluster topology configuration."""
    node_id: str                        # this node's id (e.g. "node-0")
    peers: List[str]                    # other node ids
    pg_dsn: str                         # asyncpg connection string
    election_timeout_ms: Tuple[int, int] = (150, 300)  # min, max ms
    heartbeat_interval_ms: int = 50
    max_entries_per_append: int = 64


# ---------------------------------------------------------------------------
# Minimal Raft node (single-process, Postgres-backed WAL)
# ---------------------------------------------------------------------------

class RaftNode:
    """Single-node Raft implementation backed by Postgres for persistent log.

    Log entries are appended to `raft_log` table.  Cluster state is
    persisted in `raft_state`.  Network layer is left to the caller (inject
    via `send_rpc` / `receive_rpc` callbacks).

    Usage:
        node = RaftNode(cfg, send_rpc=my_send_fn, apply_fn=my_apply_fn)
        await node.start()
        # Submitting a command (leader only):
        result = await node.submit({"table": "prince_grads", "op": "insert", "row": {...}})
    """

    def __init__(
        self,
        cfg: ClusterConfig,
        send_rpc: Optional[Callable] = None,
        apply_fn: Optional[Callable] = None,
    ) -> None:
        self.cfg = cfg
        self.state = RaftState()
        self.send_rpc = send_rpc or self._noop_rpc
        self.apply_fn = apply_fn or self._noop_apply
        self._pending_commits: Dict[int, asyncio.Future] = {}
        self._pool = None
        self._running = False

    async def start(self) -> None:
        """Connect to Postgres and start background tasks."""
        try:
            import asyncpg
            self._pool = await asyncpg.create_pool(
                self.cfg.pg_dsn,
                min_size=1, max_size=4,
            )
            await self._ensure_tables()
            await self._load_persisted_state()
        except Exception as e:
            logger.warning("Postgres unavailable (%s); running in-memory mode.", e)

        self._running = True
        asyncio.create_task(self._election_timer())
        asyncio.create_task(self._heartbeat_timer())
        asyncio.create_task(self._apply_loop())
        logger.info("RaftNode %s started (role=%s)", self.cfg.node_id, self.state.role.value)

    async def stop(self) -> None:
        self._running = False
        if self._pool:
            await self._pool.close()

    # ---- Public API ----

    async def submit(self, command: Dict) -> bool:
        """Submit a command. Returns True when committed. Raises if not leader."""
        if self.state.role != RaftRole.LEADER:
            raise RuntimeError(
                f"Not the leader; redirect to {self.state.leader_id}"
            )
        entry = LogEntry(
            term=self.state.current_term,
            index=len(self.state.log),
            command=command,
        )
        self.state.log.append(entry)
        await self._persist_log_entry(entry)

        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending_commits[entry.index] = fut
        await self._broadcast_append_entries()
        try:
            return await asyncio.wait_for(fut, timeout=5.0)
        except asyncio.TimeoutError:
            self._pending_commits.pop(entry.index, None)
            return False

    def receive_message(self, msg: Dict) -> None:
        """Inject an incoming RPC message."""
        asyncio.create_task(self._handle_message(msg))

    # ---- Raft RPCs ----

    async def _handle_message(self, msg: Dict) -> None:
        rpc = msg.get("rpc")
        if rpc == "request_vote":
            await self._handle_request_vote(msg)
        elif rpc == "request_vote_reply":
            await self._handle_vote_reply(msg)
        elif rpc == "append_entries":
            await self._handle_append_entries(msg)
        elif rpc == "append_entries_reply":
            await self._handle_append_reply(msg)

    async def _handle_request_vote(self, msg: Dict) -> None:
        term, candidate, last_log_idx, last_log_term = (
            msg["term"], msg["candidate_id"],
            msg["last_log_index"], msg["last_log_term"],
        )
        granted = False
        if term > self.state.current_term:
            await self._become_follower(term)
        if (
            term == self.state.current_term
            and (self.state.voted_for is None or self.state.voted_for == candidate)
            and self._log_is_up_to_date(last_log_idx, last_log_term)
        ):
            self.state.voted_for = candidate
            granted = True
            await self._persist_state()

        await self.send_rpc(candidate, {
            "rpc": "request_vote_reply",
            "term": self.state.current_term,
            "vote_granted": granted,
            "from": self.cfg.node_id,
        })

    async def _handle_vote_reply(self, msg: Dict) -> None:
        if msg["term"] > self.state.current_term:
            await self._become_follower(msg["term"])
            return
        if (
            self.state.role == RaftRole.CANDIDATE
            and msg.get("vote_granted")
            and msg["term"] == self.state.current_term
        ):
            self.state.votes_received += 1
            quorum = (len(self.cfg.peers) + 1) // 2 + 1
            if self.state.votes_received >= quorum:
                await self._become_leader()

    async def _handle_append_entries(self, msg: Dict) -> None:
        success = False
        if msg["term"] >= self.state.current_term:
            self.state.last_heartbeat = time.time()
            self.state.leader_id = msg["leader_id"]
            await self._become_follower(msg["term"])

            prev_idx = msg["prev_log_index"]
            if prev_idx <= len(self.state.log) - 1:
                # Append new entries
                for e in msg.get("entries", []):
                    entry = LogEntry(**e)
                    if entry.index < len(self.state.log):
                        if self.state.log[entry.index].term != entry.term:
                            self.state.log = self.state.log[:entry.index]
                            self.state.log.append(entry)
                            await self._persist_log_entry(entry)
                    else:
                        self.state.log.append(entry)
                        await self._persist_log_entry(entry)
                new_commit = min(msg.get("leader_commit", 0), len(self.state.log) - 1)
                if new_commit > self.state.commit_index:
                    self.state.commit_index = new_commit
                success = True

        await self.send_rpc(msg["leader_id"], {
            "rpc": "append_entries_reply",
            "term": self.state.current_term,
            "success": success,
            "match_index": len(self.state.log) - 1,
            "from": self.cfg.node_id,
        })

    async def _handle_append_reply(self, msg: Dict) -> None:
        peer = msg["from"]
        if msg["term"] > self.state.current_term:
            await self._become_follower(msg["term"])
            return
        if self.state.role != RaftRole.LEADER:
            return
        if msg["success"]:
            self.state.match_index[peer] = msg["match_index"]
            self.state.next_index[peer] = msg["match_index"] + 1
            # Check if majority committed new entries
            for idx in range(self.state.commit_index + 1, len(self.state.log)):
                replicated = sum(
                    1 for m in self.state.match_index.values() if m >= idx
                ) + 1  # +1 for leader itself
                if replicated > len(self.cfg.peers) // 2 + 1:
                    self.state.commit_index = idx
                    if idx in self._pending_commits:
                        self._pending_commits.pop(idx).set_result(True)
        else:
            self.state.next_index[peer] = max(0, self.state.next_index.get(peer, 0) - 1)

    # ---- Leader / follower transitions ----

    async def _become_follower(self, term: int) -> None:
        self.state.current_term = term
        self.state.role = RaftRole.FOLLOWER
        self.state.voted_for = None
        await self._persist_state()

    async def _become_leader(self) -> None:
        self.state.role = RaftRole.LEADER
        self.state.leader_id = self.cfg.node_id
        last_idx = len(self.state.log) - 1
        for p in self.cfg.peers:
            self.state.next_index[p] = last_idx + 1
            self.state.match_index[p] = -1
        logger.info("Node %s became LEADER for term %d", self.cfg.node_id, self.state.current_term)
        await self._broadcast_append_entries()

    async def _start_election(self) -> None:
        self.state.current_term += 1
        self.state.role = RaftRole.CANDIDATE
        self.state.voted_for = self.cfg.node_id
        self.state.votes_received = 1
        await self._persist_state()
        last = self.state.log[-1] if self.state.log else None
        for peer in self.cfg.peers:
            await self.send_rpc(peer, {
                "rpc": "request_vote",
                "term": self.state.current_term,
                "candidate_id": self.cfg.node_id,
                "last_log_index": last.index if last else -1,
                "last_log_term": last.term if last else -1,
            })

    # ---- Background tasks ----

    async def _election_timer(self) -> None:
        while self._running:
            timeout = random.randint(*self.cfg.election_timeout_ms) / 1000
            await asyncio.sleep(timeout)
            if self.state.role != RaftRole.LEADER:
                elapsed = time.time() - self.state.last_heartbeat
                if elapsed > timeout:
                    await self._start_election()

    async def _heartbeat_timer(self) -> None:
        interval = self.cfg.heartbeat_interval_ms / 1000
        while self._running:
            await asyncio.sleep(interval)
            if self.state.role == RaftRole.LEADER:
                await self._broadcast_append_entries()

    async def _apply_loop(self) -> None:
        while self._running:
            while self.state.last_applied < self.state.commit_index:
                self.state.last_applied += 1
                entry = self.state.log[self.state.last_applied]
                await self.apply_fn(entry.command)
            await asyncio.sleep(0.01)

    async def _broadcast_append_entries(self) -> None:
        for peer in self.cfg.peers:
            ni = self.state.next_index.get(peer, len(self.state.log))
            entries = self.state.log[ni:ni + self.cfg.max_entries_per_append]
            prev_idx = ni - 1
            prev_term = self.state.log[prev_idx].term if prev_idx >= 0 and self.state.log else -1
            await self.send_rpc(peer, {
                "rpc": "append_entries",
                "term": self.state.current_term,
                "leader_id": self.cfg.node_id,
                "prev_log_index": prev_idx,
                "prev_log_term": prev_term,
                "entries": [e.__dict__ for e in entries],
                "leader_commit": self.state.commit_index,
            })

    # ---- Helpers ----

    def _log_is_up_to_date(self, last_log_idx: int, last_log_term: int) -> bool:
        if not self.state.log:
            return True
        my_last = self.state.log[-1]
        if last_log_term != my_last.term:
            return last_log_term > my_last.term
        return last_log_idx >= my_last.index

    async def _ensure_tables(self) -> None:
        if not self._pool:
            return
        async with self._pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS raft_log (
                    idx INTEGER PRIMARY KEY,
                    term INTEGER NOT NULL,
                    command JSONB NOT NULL,
                    client_id TEXT,
                    request_id TEXT
                );
                CREATE TABLE IF NOT EXISTS raft_state (
                    node_id TEXT PRIMARY KEY,
                    current_term INTEGER,
                    voted_for TEXT
                );
            """)

    async def _persist_log_entry(self, entry: LogEntry) -> None:
        if not self._pool:
            return
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO raft_log(idx,term,command,client_id,request_id) "
                    "VALUES($1,$2,$3,$4,$5) ON CONFLICT(idx) DO UPDATE "
                    "SET term=$2, command=$3",
                    entry.index, entry.term, json.dumps(entry.command),
                    entry.client_id, entry.request_id,
                )
        except Exception as e:
            logger.warning("Failed to persist log entry: %s", e)

    async def _persist_state(self) -> None:
        if not self._pool:
            return
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO raft_state(node_id,current_term,voted_for) "
                    "VALUES($1,$2,$3) ON CONFLICT(node_id) DO UPDATE "
                    "SET current_term=$2, voted_for=$3",
                    self.cfg.node_id, self.state.current_term, self.state.voted_for,
                )
        except Exception as e:
            logger.warning("Failed to persist state: %s", e)

    async def _load_persisted_state(self) -> None:
        if not self._pool:
            return
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT current_term, voted_for FROM raft_state WHERE node_id=$1",
                self.cfg.node_id,
            )
            if row:
                self.state.current_term = row["current_term"]
                self.state.voted_for = row["voted_for"]
            rows = await conn.fetch(
                "SELECT idx, term, command, client_id, request_id FROM raft_log ORDER BY idx"
            )
            self.state.log = [
                LogEntry(
                    term=r["term"], index=r["idx"],
                    command=r["command"],
                    client_id=r["client_id"] or "",
                    request_id=r["request_id"] or "",
                )
                for r in rows
            ]

    @staticmethod
    async def _noop_rpc(peer_id: str, msg: Dict) -> None:
        pass  # caller wires real network transport

    @staticmethod
    async def _noop_apply(command: Dict) -> None:
        pass


# ---------------------------------------------------------------------------
# Postgres WAL-based replicator (leader writes, followers read via pgoutput)
# ---------------------------------------------------------------------------

class PGReplicator:
    """Stream Postgres logical replication to in-process subscribers.

    Uses asyncpg's replication protocol to subscribe to WAL changes on the
    specified slot.  Dispatches change events to registered callbacks.

    Usage:
        rep = PGReplicator(dsn, slot="masternex_slot")
        rep.on("prince_grads", handle_grad_insert)
        await rep.start()
    """

    def __init__(self, dsn: str, slot: str = "masternex_slot") -> None:
        self.dsn = dsn
        self.slot = slot
        self._handlers: Dict[str, List[Callable]] = {}
        self._conn = None
        self._running = False

    def on(self, table: str, fn: Callable) -> None:
        self._handlers.setdefault(table, []).append(fn)

    async def start(self) -> None:
        try:
            import asyncpg
            self._conn = await asyncpg.connect(self.dsn)
            try:
                await self._conn.execute(
                    f"SELECT pg_create_logical_replication_slot($1, 'pgoutput') "
                    f"WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name=$1)",
                    self.slot,
                )
            except Exception:
                pass  # slot already exists

            self._running = True
            asyncio.create_task(self._stream_loop())
            logger.info("PGReplicator started on slot %s", self.slot)
        except Exception as e:
            logger.warning("PGReplicator could not connect: %s", e)

    async def stop(self) -> None:
        self._running = False
        if self._conn:
            await self._conn.close()

    async def _stream_loop(self) -> None:
        try:
            import asyncpg
            async with self._conn.transaction():
                async for msg in self._conn.cursor(
                    "START_REPLICATION SLOT $1 LOGICAL 0/0 (proto_version '1', "
                    "publication_names 'masternex_pub')",
                    self.slot,
                ):
                    if not self._running:
                        break
                    await self._dispatch(msg)
        except Exception as e:
            logger.warning("Replication stream error: %s", e)

    async def _dispatch(self, msg: Any) -> None:
        # In production: parse pgoutput binary protocol
        # For now: best-effort JSON extraction
        try:
            data = json.loads(msg) if isinstance(msg, str) else {}
            table = data.get("table", "")
            for fn in self._handlers.get(table, []):
                await fn(data)
        except Exception as e:
            logger.debug("Dispatch error: %s", e)


# ---------------------------------------------------------------------------
# Consistency router
# ---------------------------------------------------------------------------

class ConsistencyRouter:
    """Routes reads/writes to leader or nearest replica based on consistency level.

    consistency_levels:
      "strong"    → always leader
      "monotonic" → any replica that is at or ahead of last-read LSN
      "eventual"  → round-robin over all replicas
    """

    def __init__(self, nodes: List[RaftNode]) -> None:
        self.nodes = nodes
        self._last_lsn: int = 0
        self._rr_index: int = 0

    def _leader(self) -> Optional[RaftNode]:
        for n in self.nodes:
            if n.state.role == RaftRole.LEADER:
                return n
        return None

    async def write(self, command: Dict, consistency: str = "strong") -> bool:
        node = self._leader()
        if node is None:
            raise RuntimeError("No leader available; cluster may be partitioned.")
        result = await node.submit(command)
        if result:
            self._last_lsn = node.state.commit_index
        return result

    async def read(
        self, fn: Callable, consistency: str = "eventual"
    ) -> Any:
        """Execute a read fn(node) on the appropriate node."""
        if consistency == "strong":
            node = self._leader()
        elif consistency == "monotonic":
            # Prefer a replica caught up to our last write
            node = next(
                (n for n in self.nodes if n.state.commit_index >= self._last_lsn),
                self._leader(),
            )
        else:
            node = self.nodes[self._rr_index % len(self.nodes)]
            self._rr_index += 1

        if node is None:
            raise RuntimeError("No suitable node for read.")
        return await fn(node)


# ---------------------------------------------------------------------------
# High-level cluster manager
# ---------------------------------------------------------------------------

class StateClusterManager:
    """Bootstrap a local Raft cluster for MASTERNEX shared state.

    Manages:
      - PRINCE federated gradient ledger (strong)
      - ACPLedger rows (monotonic)
      - GIE vector index metadata (eventual)
      - Modal job state (strong)

    Args:
        configs: list of ClusterConfig, one per node (can be 1 for single-node mode)
        apply_fn: callback(command) applied when an entry is committed
    """

    def __init__(
        self,
        configs: List[ClusterConfig],
        apply_fn: Optional[Callable] = None,
    ) -> None:
        self._nodes: List[RaftNode] = []
        self._router: Optional[ConsistencyRouter] = None
        self._configs = configs
        self._apply_fn = apply_fn
        # Simple in-process message bus (replaces real network in single-host mode)
        self._bus: Dict[str, RaftNode] = {}

    async def start(self) -> None:
        for cfg in self._configs:
            node = RaftNode(
                cfg,
                send_rpc=self._make_send_rpc(),
                apply_fn=self._apply_fn or self._noop,
            )
            self._nodes.append(node)
            self._bus[cfg.node_id] = node
            await node.start()

        self._router = ConsistencyRouter(self._nodes)
        logger.info(
            "StateClusterManager started with %d nodes: %s",
            len(self._nodes), [c.node_id for c in self._configs],
        )

    async def stop(self) -> None:
        for n in self._nodes:
            await n.stop()

    def _make_send_rpc(self) -> Callable:
        async def send(peer_id: str, msg: Dict) -> None:
            if peer_id in self._bus:
                self._bus[peer_id].receive_message(msg)
        return send

    async def write(self, command: Dict, consistency: str = "strong") -> bool:
        if self._router is None:
            raise RuntimeError("Cluster not started.")
        return await self._router.write(command, consistency)

    async def read(self, fn: Callable, consistency: str = "eventual") -> Any:
        if self._router is None:
            raise RuntimeError("Cluster not started.")
        return await self._router.read(fn, consistency)

    @staticmethod
    async def _noop(command: Dict) -> None:
        pass
