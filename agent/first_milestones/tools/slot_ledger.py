"""Concurrency-safe 48h Slot Hold & Capacity Ledger (`slot_ledger.py`).

Persists temporary pathway slot reservations across `Part_C_Intake_Coordinator`,
`Multidisciplinary_Eval_Hub`, and `EI_Therapy_Vendor` CareNodes so concurrent intake
coordinators do not double-book the last available evaluation or therapy slot.

Backends:
  - **Cloud Firestore (`A4I_SLOT_LEDGER_BACKEND=firestore`):** Uses atomic
    `@firestore.transactional` read-check-write transactions over `a4i_slot_holds`
    and `a4i_slot_provider_locks`.
  - **Thread-safe SQLite (default):** Uses `agent/.runtime/slot_ledger.db` (or
    `A4I_SLOT_LEDGER_DB` override) with `PRAGMA journal_mode=WAL`, `RLock`, and
    serialized `BEGIN IMMEDIATE` write transactions.

Capacity invariant enforced atomically:
  `active_waitlist_count + active_holds_count + 1 <= monthly_slot_capacity`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import sqlite3
import threading
from typing import Any
from uuid import uuid4

from .bq_client import VALID_STATES, get_config, load_local_state_frames

logger = logging.getLogger(__name__)

_SQLITE_LOCK = threading.RLock()
_FIRESTORE_COLLECTION_HOLDS = "a4i_slot_holds"
_FIRESTORE_COLLECTION_LOCKS = "a4i_slot_provider_locks"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _default_sqlite_path() -> Path:
    override = os.environ.get("A4I_SLOT_LEDGER_DB", "").strip()
    if override:
        return Path(override)
    agent_dir = Path(__file__).resolve().parents[2]  # .../agent
    return agent_dir / ".runtime" / "slot_ledger.db"


def _resolve_backend_mode() -> str:
    mode = os.environ.get("A4I_SLOT_LEDGER_BACKEND", "sqlite").strip().lower()
    if mode == "firestore":
        try:
            from google.cloud import firestore  # noqa: F401

            return "firestore"
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "A4I_SLOT_LEDGER_BACKEND=firestore requested but unavailable (%s); falling back to SQLite.",
                exc,
            )
    return "sqlite"


def _connect_sqlite(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(db_path),
        timeout=10.0,
        isolation_level=None,
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS slot_holds (
            hold_id TEXT PRIMARY KEY,
            state_code TEXT NOT NULL,
            case_reference TEXT NOT NULL,
            coordinator_id TEXT NOT NULL,
            eval_hub_id TEXT NOT NULL,
            vendor_id TEXT NOT NULL,
            provider_ids_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            released_at TEXT
        );
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_slot_holds_state_status
          ON slot_holds (state_code, status, expires_at);
        """
    )
    return conn


def _expire_stale_sqlite_holds(conn: sqlite3.Connection, now_iso: str) -> None:
    conn.execute(
        """
        UPDATE slot_holds
           SET status = 'EXPIRED'
         WHERE status = 'ACTIVE' AND expires_at <= ?;
        """,
        (now_iso,),
    )


def _count_active_holds_sqlite(
    conn: sqlite3.Connection,
    state_code: str,
    now_iso: str,
) -> dict[str, int]:
    rows = conn.execute(
        """
        SELECT provider_ids_json
          FROM slot_holds
         WHERE state_code = ? AND status = 'ACTIVE' AND expires_at > ?;
        """,
        (state_code, now_iso),
    ).fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        try:
            pids = json.loads(row["provider_ids_json"])
        except Exception:  # noqa: BLE001
            continue
        if isinstance(pids, list):
            for pid in pids:
                pid_str = str(pid).strip()
                if pid_str:
                    counts[pid_str] = counts.get(pid_str, 0) + 1
    return counts


def _get_firestore_client() -> Any:
    from google.cloud import firestore

    project = get_config()["project"] or None
    return firestore.Client(project=project)


def _get_active_hold_counts_firestore(state_code: str, now_iso: str) -> dict[str, int]:
    db = _get_firestore_client()
    query = (
        db.collection(_FIRESTORE_COLLECTION_HOLDS)
        .where("state_code", "==", state_code)
        .where("status", "==", "ACTIVE")
    )
    counts: dict[str, int] = {}
    for doc in query.stream():
        data = doc.to_dict() or {}
        if str(data.get("expires_at", "")) <= now_iso:
            continue
        for pid in data.get("provider_ids") or []:
            pid_str = str(pid).strip()
            if pid_str:
                counts[pid_str] = counts.get(pid_str, 0) + 1
    return counts


def get_active_hold_counts(state_code: str) -> dict[str, int]:
    """Returns `{provider_id: active_hold_count}` for active non-expired holds in `state_code`."""
    raw_state = (state_code or get_config()["state"]).strip().upper()
    clean_state = raw_state if raw_state in VALID_STATES else get_config()["state"]
    now_iso = _utc_now().isoformat()

    if _resolve_backend_mode() == "firestore":
        try:
            return _get_active_hold_counts_firestore(clean_state, now_iso)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Firestore hold count lookup failed (%s); falling back to SQLite.", exc)

    db_path = _default_sqlite_path()
    if not db_path.is_file():
        return {}

    with _SQLITE_LOCK:
        conn = _connect_sqlite(db_path)
        try:
            return _count_active_holds_sqlite(conn, clean_state, now_iso)
        finally:
            conn.close()


def reserve_pathway_slot(
    state_code: str = "MS",
    coordinator_id: str = "",
    eval_hub_id: str = "",
    vendor_id: str = "",
    case_reference: str = "",
    hold_hours: int = 48,
) -> dict[str, Any]:
    """Atomically reserves a 48-hour capacity hold across specified Part C pathway providers.

    Enforces `active_waitlist_count + active_holds + 1 <= monthly_slot_capacity` inside an
    isolated transaction (Firestore `@firestore.transactional` or SQLite WAL `BEGIN IMMEDIATE`).
    Never stores or reads `audit_*` demographic data.
    """
    raw_state = (state_code or get_config()["state"]).strip().upper()
    if raw_state not in VALID_STATES:
        return {
            "status": "validation_error",
            "error_code": "INVALID_STATE_CODE",
            "state_code": raw_state,
            "message": f"state_code must be one of {VALID_STATES} (received {state_code!r}).",
        }
    clean_state = raw_state

    if isinstance(hold_hours, bool):
        return {
            "status": "validation_error",
            "error_code": "INVALID_HOLD_HOURS",
            "state_code": clean_state,
            "message": "hold_hours must be an integer between 1 and 168.",
        }
    try:
        hold_h = int(hold_hours)
    except (TypeError, ValueError):
        hold_h = -1
    if hold_h < 1 or hold_h > 168:
        return {
            "status": "validation_error",
            "error_code": "INVALID_HOLD_HOURS",
            "state_code": clean_state,
            "message": "hold_hours must be an integer between 1 and 168.",
        }

    coord_id = (coordinator_id or "").strip().upper()
    eval_id = (eval_hub_id or "").strip().upper()
    vend_id = (vendor_id or "").strip().upper()
    requested_pids = list(dict.fromkeys(pid for pid in (coord_id, eval_id, vend_id) if pid))

    prov = load_local_state_frames(clean_state)["providers"]
    prov_by_id = {str(r["provider_id"]): r for _, r in prov.iterrows()}

    if not requested_pids:
        sample_uncongested = [
            str(r["provider_id"])
            for _, r in prov.iterrows()
            if str(r["node_role"]) in ("Multidisciplinary_Eval_Hub", "EI_Therapy_Vendor")
            and int(r["active_waitlist_count"]) < int(r["monthly_slot_capacity"])
        ][:4]
        return {
            "status": "validation_error",
            "error_code": "NO_PROVIDERS_SPECIFIED",
            "state_code": clean_state,
            "message": (
                "Specify at least one provider ID (`coordinator_id`, `eval_hub_id`, or `vendor_id`) "
                "to reserve a 48-hour pathway slot hold."
            ),
            "sample_available_providers": sample_uncongested,
        }

    for pid in requested_pids:
        if pid not in prov_by_id:
            return {
                "status": "validation_error",
                "error_code": "PROVIDER_NOT_FOUND_IN_ACTIVE_STATE",
                "state_code": clean_state,
                "provider_id": pid,
                "message": f"Provider '{pid}' was not found in active state '{clean_state}'.",
            }

    now_dt = _utc_now()
    created_iso = now_dt.isoformat()
    expires_iso = (now_dt + timedelta(hours=hold_h)).isoformat()
    hold_id = f"HOLD-{clean_state}-{uuid4().hex[:8].upper()}"
    clean_case_ref = (case_reference or "").strip() or f"CASE-{hold_id[-8:]}"

    backend = _resolve_backend_mode()
    if backend == "firestore":
        try:
            return _reserve_firestore(
                clean_state=clean_state,
                hold_id=hold_id,
                case_reference=clean_case_ref,
                coord_id=coord_id,
                eval_id=eval_id,
                vend_id=vend_id,
                requested_pids=requested_pids,
                prov_by_id=prov_by_id,
                hold_h=hold_h,
                created_iso=created_iso,
                expires_iso=expires_iso,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Firestore reservation failed (%s); falling back to SQLite.", exc)

    return _reserve_sqlite(
        clean_state=clean_state,
        hold_id=hold_id,
        case_reference=clean_case_ref,
        coord_id=coord_id,
        eval_id=eval_id,
        vend_id=vend_id,
        requested_pids=requested_pids,
        prov_by_id=prov_by_id,
        hold_h=hold_h,
        created_iso=created_iso,
        expires_iso=expires_iso,
    )


def _reserve_sqlite(
    *,
    clean_state: str,
    hold_id: str,
    case_reference: str,
    coord_id: str,
    eval_id: str,
    vend_id: str,
    requested_pids: list[str],
    prov_by_id: dict[str, Any],
    hold_h: int,
    created_iso: str,
    expires_iso: str,
) -> dict[str, Any]:
    db_path = _default_sqlite_path()
    with _SQLITE_LOCK:
        conn = _connect_sqlite(db_path)
        try:
            conn.execute("BEGIN IMMEDIATE;")
            _expire_stale_sqlite_holds(conn, created_iso)
            active_counts = _count_active_holds_sqlite(conn, clean_state, created_iso)

            utilization_after: dict[str, dict[str, Any]] = {}
            for pid in requested_pids:
                meta = prov_by_id[pid]
                cap = max(1, int(meta["monthly_slot_capacity"]))
                wl = int(meta["active_waitlist_count"])
                holds_now = active_counts.get(pid, 0)
                remaining_before = cap - wl - holds_now
                if remaining_before < 1:
                    conn.execute("ROLLBACK;")
                    return {
                        "status": "capacity_exhausted",
                        "error_code": "SLOT_CAPACITY_EXHAUSTED",
                        "backend": f"sqlite_wal ({db_path.name})",
                        "state_code": clean_state,
                        "exhausted_provider_id": pid,
                        "monthly_slot_capacity": cap,
                        "active_waitlist_count": wl,
                        "active_hold_count": holds_now,
                        "remaining_slots": remaining_before,
                        "message": (
                            f"Cannot reserve slot at {pid}: monthly_slot_capacity={cap}, "
                            f"active_waitlist={wl}, active_48h_holds={holds_now} (0 slots left)."
                        ),
                    }
                new_holds = holds_now + 1
                utilization_after[pid] = {
                    "monthly_slot_capacity": cap,
                    "active_waitlist_count": wl,
                    "active_holds": new_holds,
                    "remaining_slots": cap - wl - new_holds,
                    "utilization_ratio": round((wl + new_holds) / cap, 2),
                }

            conn.execute(
                """
                INSERT INTO slot_holds (
                    hold_id, state_code, case_reference, coordinator_id,
                    eval_hub_id, vendor_id, provider_ids_json, status,
                    created_at, expires_at, released_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, NULL);
                """,
                (
                    hold_id,
                    clean_state,
                    case_reference,
                    coord_id,
                    eval_id,
                    vend_id,
                    json.dumps(requested_pids),
                    created_iso,
                    expires_iso,
                ),
            )
            conn.execute("COMMIT;")
        except Exception:
            try:
                conn.execute("ROLLBACK;")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()

    return {
        "status": "reserved",
        "backend": f"sqlite_wal ({db_path.name})",
        "hold_id": hold_id,
        "state_code": clean_state,
        "case_reference": case_reference,
        "coordinator_id": coord_id,
        "eval_hub_id": eval_id,
        "vendor_id": vend_id,
        "hold_hours": hold_h,
        "created_at": created_iso,
        "expires_at": expires_iso,
        "provider_utilization_after_hold": utilization_after,
    }


def _reserve_firestore(
    *,
    clean_state: str,
    hold_id: str,
    case_reference: str,
    coord_id: str,
    eval_id: str,
    vend_id: str,
    requested_pids: list[str],
    prov_by_id: dict[str, Any],
    hold_h: int,
    created_iso: str,
    expires_iso: str,
) -> dict[str, Any]:
    from google.cloud import firestore

    db = _get_firestore_client()
    transaction = db.transaction()

    @firestore.transactional
    def _txn_reserve(txn: Any) -> dict[str, Any]:
        lock_refs = {
            pid: db.collection(_FIRESTORE_COLLECTION_LOCKS).document(f"{clean_state}_{pid}")
            for pid in requested_pids
        }
        lock_snaps = {pid: ref.get(transaction=txn) for pid, ref in lock_refs.items()}

        active_by_pid: dict[str, list[dict[str, Any]]] = {}
        utilization_after: dict[str, dict[str, Any]] = {}

        for pid in requested_pids:
            meta = prov_by_id[pid]
            cap = max(1, int(meta["monthly_slot_capacity"]))
            wl = int(meta["active_waitlist_count"])
            snap = lock_snaps[pid]
            raw_holds = (snap.to_dict() or {}).get("active_holds", []) if snap.exists else []
            live_holds = [
                h for h in raw_holds if isinstance(h, dict) and str(h.get("expires_at", "")) > created_iso
            ]
            active_by_pid[pid] = live_holds
            holds_now = len(live_holds)
            remaining_before = cap - wl - holds_now
            if remaining_before < 1:
                return {
                    "status": "capacity_exhausted",
                    "error_code": "SLOT_CAPACITY_EXHAUSTED",
                    "backend": "cloud_firestore_transactional",
                    "state_code": clean_state,
                    "exhausted_provider_id": pid,
                    "monthly_slot_capacity": cap,
                    "active_waitlist_count": wl,
                    "active_hold_count": holds_now,
                    "remaining_slots": remaining_before,
                    "message": (
                        f"Cannot reserve slot at {pid}: monthly_slot_capacity={cap}, "
                        f"active_waitlist={wl}, active_48h_holds={holds_now} (0 slots left)."
                    ),
                }
            new_holds = holds_now + 1
            utilization_after[pid] = {
                "monthly_slot_capacity": cap,
                "active_waitlist_count": wl,
                "active_holds": new_holds,
                "remaining_slots": cap - wl - new_holds,
                "utilization_ratio": round((wl + new_holds) / cap, 2),
            }

        for pid in requested_pids:
            updated_holds = [
                *active_by_pid[pid],
                {"hold_id": hold_id, "expires_at": expires_iso},
            ]
            txn.set(
                lock_refs[pid],
                {
                    "state_code": clean_state,
                    "provider_id": pid,
                    "active_holds": updated_holds,
                    "updated_at": created_iso,
                },
            )

        hold_ref = db.collection(_FIRESTORE_COLLECTION_HOLDS).document(hold_id)
        txn.set(
            hold_ref,
            {
                "hold_id": hold_id,
                "state_code": clean_state,
                "case_reference": case_reference,
                "coordinator_id": coord_id,
                "eval_hub_id": eval_id,
                "vendor_id": vend_id,
                "provider_ids": requested_pids,
                "status": "ACTIVE",
                "created_at": created_iso,
                "expires_at": expires_iso,
                "released_at": None,
            },
        )
        return {
            "status": "reserved",
            "backend": "cloud_firestore_transactional",
            "hold_id": hold_id,
            "state_code": clean_state,
            "case_reference": case_reference,
            "coordinator_id": coord_id,
            "eval_hub_id": eval_id,
            "vendor_id": vend_id,
            "hold_hours": hold_h,
            "created_at": created_iso,
            "expires_at": expires_iso,
            "provider_utilization_after_hold": utilization_after,
        }

    return _txn_reserve(transaction)


def list_slot_holds(state_code: str | None = None) -> dict[str, Any]:
    """Lists active, unexpired 48-hour slot holds (filtered by `state_code` when provided)."""
    clean_state: str | None = None
    if state_code is not None and str(state_code).strip():
        cand = str(state_code).strip().upper()
        if cand not in VALID_STATES:
            return {
                "status": "validation_error",
                "error_code": "INVALID_STATE_CODE",
                "state_code": cand,
                "active_holds_count": 0,
                "active_hold_counts_by_provider": {},
                "holds": [],
            }
        clean_state = cand

    now_iso = _utc_now().isoformat()
    backend = _resolve_backend_mode()

    if backend == "firestore":
        try:
            db = _get_firestore_client()
            q = db.collection(_FIRESTORE_COLLECTION_HOLDS).where("status", "==", "ACTIVE")
            if clean_state:
                q = q.where("state_code", "==", clean_state)
            holds: list[dict[str, Any]] = []
            counts: dict[str, int] = {}
            for doc in q.stream():
                d = doc.to_dict() or {}
                if str(d.get("expires_at", "")) <= now_iso:
                    continue
                pids = [str(p) for p in (d.get("provider_ids") or [])]
                for p in pids:
                    counts[p] = counts.get(p, 0) + 1
                holds.append({
                    "hold_id": str(d.get("hold_id", doc.id)),
                    "state_code": str(d.get("state_code", "")),
                    "case_reference": str(d.get("case_reference", "")),
                    "coordinator_id": str(d.get("coordinator_id", "")),
                    "eval_hub_id": str(d.get("eval_hub_id", "")),
                    "vendor_id": str(d.get("vendor_id", "")),
                    "created_at": str(d.get("created_at", "")),
                    "expires_at": str(d.get("expires_at", "")),
                })
            holds.sort(key=lambda h: h["created_at"], reverse=True)
            return {
                "status": "ok",
                "backend": "cloud_firestore_transactional",
                "state_code": clean_state or "ALL",
                "active_holds_count": len(holds),
                "active_hold_counts_by_provider": counts,
                "holds": holds[:20],
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("Firestore list_slot_holds failed (%s); falling back to SQLite.", exc)

    db_path = _default_sqlite_path()
    if not db_path.is_file():
        return {
            "status": "ok",
            "backend": f"sqlite_wal ({db_path.name})",
            "state_code": clean_state or "ALL",
            "active_holds_count": 0,
            "active_hold_counts_by_provider": {},
            "holds": [],
        }

    with _SQLITE_LOCK:
        conn = _connect_sqlite(db_path)
        try:
            if clean_state:
                rows = conn.execute(
                    """
                    SELECT hold_id, state_code, case_reference, coordinator_id,
                           eval_hub_id, vendor_id, provider_ids_json, created_at, expires_at
                      FROM slot_holds
                     WHERE state_code = ? AND status = 'ACTIVE' AND expires_at > ?
                     ORDER BY created_at DESC;
                    """,
                    (clean_state, now_iso),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT hold_id, state_code, case_reference, coordinator_id,
                           eval_hub_id, vendor_id, provider_ids_json, created_at, expires_at
                      FROM slot_holds
                     WHERE status = 'ACTIVE' AND expires_at > ?
                     ORDER BY created_at DESC;
                    """,
                    (now_iso,),
                ).fetchall()
        finally:
            conn.close()

    holds = []
    counts = {}
    for r in rows:
        try:
            pids = json.loads(r["provider_ids_json"])
        except Exception:  # noqa: BLE001
            pids = []
        for p in pids:
            p_str = str(p)
            counts[p_str] = counts.get(p_str, 0) + 1
        holds.append({
            "hold_id": str(r["hold_id"]),
            "state_code": str(r["state_code"]),
            "case_reference": str(r["case_reference"]),
            "coordinator_id": str(r["coordinator_id"]),
            "eval_hub_id": str(r["eval_hub_id"]),
            "vendor_id": str(r["vendor_id"]),
            "created_at": str(r["created_at"]),
            "expires_at": str(r["expires_at"]),
        })

    return {
        "status": "ok",
        "backend": f"sqlite_wal ({db_path.name})",
        "state_code": clean_state or "ALL",
        "active_holds_count": len(holds),
        "active_hold_counts_by_provider": counts,
        "holds": holds[:20],
    }


def release_slot_hold(hold_id: str) -> dict[str, Any]:
    """Releases an active 48-hour slot hold immediately, freeing capacity."""
    clean_id = (hold_id or "").strip().upper()
    if not clean_id:
        return {
            "status": "validation_error",
            "error_code": "INVALID_HOLD_ID",
            "hold_id": hold_id,
            "message": "hold_id must be a non-empty hold identifier.",
        }

    now_iso = _utc_now().isoformat()
    if _resolve_backend_mode() == "firestore":
        try:
            from google.cloud import firestore

            db = _get_firestore_client()
            transaction = db.transaction()
            hold_ref = db.collection(_FIRESTORE_COLLECTION_HOLDS).document(clean_id)

            @firestore.transactional
            def _txn_release(txn: Any) -> dict[str, Any]:
                snap = hold_ref.get(transaction=txn)
                if not snap.exists:
                    return {
                        "status": "not_found",
                        "error_code": "HOLD_NOT_FOUND",
                        "hold_id": clean_id,
                    }
                data = snap.to_dict() or {}
                st = str(data.get("state_code", ""))
                pids = [str(p) for p in (data.get("provider_ids") or [])]
                lock_refs = {
                    pid: db.collection(_FIRESTORE_COLLECTION_LOCKS).document(f"{st}_{pid}")
                    for pid in pids
                }
                lock_snaps = {pid: ref.get(transaction=txn) for pid, ref in lock_refs.items()}
                for pid, snap_l in lock_snaps.items():
                    if snap_l.exists:
                        existing = (snap_l.to_dict() or {}).get("active_holds", [])
                        kept = [
                            h
                            for h in existing
                            if isinstance(h, dict)
                            and h.get("hold_id") != clean_id
                            and str(h.get("expires_at", "")) > now_iso
                        ]
                        txn.set(
                            lock_refs[pid],
                            {
                                "state_code": st,
                                "provider_id": pid,
                                "active_holds": kept,
                                "updated_at": now_iso,
                            },
                        )
                txn.update(hold_ref, {"status": "RELEASED", "released_at": now_iso})
                return {
                    "status": "released",
                    "backend": "cloud_firestore_transactional",
                    "hold_id": clean_id,
                    "state_code": st,
                    "released_at": now_iso,
                }

            return _txn_release(transaction)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Firestore release_slot_hold failed (%s); falling back to SQLite.", exc)

    db_path = _default_sqlite_path()
    if not db_path.is_file():
        return {
            "status": "not_found",
            "error_code": "HOLD_NOT_FOUND",
            "hold_id": clean_id,
        }

    with _SQLITE_LOCK:
        conn = _connect_sqlite(db_path)
        try:
            conn.execute("BEGIN IMMEDIATE;")
            row = conn.execute(
                "SELECT hold_id, state_code, status FROM slot_holds WHERE hold_id = ?;",
                (clean_id,),
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK;")
                return {
                    "status": "not_found",
                    "error_code": "HOLD_NOT_FOUND",
                    "hold_id": clean_id,
                }
            conn.execute(
                """
                UPDATE slot_holds
                   SET status = 'RELEASED', released_at = ?
                 WHERE hold_id = ?;
                """,
                (now_iso, clean_id),
            )
            conn.execute("COMMIT;")
            return {
                "status": "released",
                "backend": f"sqlite_wal ({db_path.name})",
                "hold_id": clean_id,
                "state_code": str(row["state_code"]),
                "previous_status": str(row["status"]),
                "released_at": now_iso,
            }
        except Exception:
            try:
                conn.execute("ROLLBACK;")
            except sqlite3.Error:
                pass
            raise
        finally:
            conn.close()
