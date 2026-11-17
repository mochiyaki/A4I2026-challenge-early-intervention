"""Zero-dependency SQLite-backed ADK SessionService & session backend factory.

Provides persistent multi-turn session storage using Python stdlib `sqlite3`
without requiring `sqlalchemy`, while supporting seamless switching to
`InMemorySessionService` or `VertexAiSessionService` via environment variables.
"""

from __future__ import annotations

import copy
import json
import logging
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from google.adk.errors.already_exists_error import AlreadyExistsError
from google.adk.errors.session_not_found_error import SessionNotFoundError
from google.adk.events.event import Event
from google.adk.sessions import (
    BaseSessionService,
    InMemorySessionService,
    Session,
    State,
    VertexAiSessionService,
    _session_util,
)
from google.adk.sessions.base_session_service import GetSessionConfig, ListSessionsResponse
from typing_extensions import override

logger = logging.getLogger("first_milestones.session_store")

DEFAULT_SESSION_DB_PATH = "/tmp/first_milestones_sessions.db"


class SqlitePersistentSessionService(BaseSessionService):
    """Thread-safe, zero-extra-dependency SQLite implementation of `BaseSessionService`."""

    def __init__(self, db_path: str | Path = DEFAULT_SESSION_DB_PATH) -> None:
        self.db_path = str(db_path)
        self._lock = threading.RLock()
        if self.db_path != ":memory:":
            Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(
            self.db_path,
            check_same_thread=False,
            timeout=15.0,
        )
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            cur = self._conn.cursor()
            if self.db_path != ":memory:":
                cur.execute("PRAGMA journal_mode=WAL;")
            cur.execute("PRAGMA synchronous=NORMAL;")
            cur.execute("PRAGMA busy_timeout=5000;")
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS app_states (
                    app_name TEXT PRIMARY KEY,
                    state_json TEXT NOT NULL,
                    updated_at REAL NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS user_states (
                    app_name TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (app_name, user_id)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    app_name TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    state_json TEXT NOT NULL,
                    create_time REAL NOT NULL,
                    update_time REAL NOT NULL,
                    PRIMARY KEY (app_name, user_id, session_id)
                )
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL,
                    app_name TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    event_json TEXT NOT NULL
                )
                """
            )
            cur.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_events_session_seq
                ON events (app_name, user_id, session_id, seq)
                """
            )
            self._conn.commit()

    def _read_app_state_locked(self, app_name: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT state_json FROM app_states WHERE app_name = ?",
            (app_name,),
        ).fetchone()
        return json.loads(row[0]) if row else {}

    def _read_user_state_locked(self, app_name: str, user_id: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT state_json FROM user_states WHERE app_name = ? AND user_id = ?",
            (app_name, user_id),
        ).fetchone()
        return json.loads(row[0]) if row else {}

    def _upsert_app_state_locked(
        self, app_name: str, delta: dict[str, Any], now: float
    ) -> dict[str, Any]:
        current = self._read_app_state_locked(app_name)
        if delta:
            current.update(delta)
            self._conn.execute(
                """
                INSERT INTO app_states (app_name, state_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(app_name) DO UPDATE SET
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at
                """,
                (app_name, json.dumps(current, ensure_ascii=False), now),
            )
        return current

    def _upsert_user_state_locked(
        self, app_name: str, user_id: str, delta: dict[str, Any], now: float
    ) -> dict[str, Any]:
        current = self._read_user_state_locked(app_name, user_id)
        if delta:
            current.update(delta)
            self._conn.execute(
                """
                INSERT INTO user_states (app_name, user_id, state_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(app_name, user_id) DO UPDATE SET
                    state_json = excluded.state_json,
                    updated_at = excluded.updated_at
                """,
                (app_name, user_id, json.dumps(current, ensure_ascii=False), now),
            )
        return current

    @staticmethod
    def _merge_scoped_state(
        session_state: dict[str, Any],
        app_state: dict[str, Any],
        user_state: dict[str, Any],
    ) -> dict[str, Any]:
        merged = copy.deepcopy(session_state)
        for k, v in app_state.items():
            merged[State.APP_PREFIX + k] = copy.deepcopy(v)
        for k, v in user_state.items():
            merged[State.USER_PREFIX + k] = copy.deepcopy(v)
        return merged

    @override
    async def create_session(
        self,
        *,
        app_name: str,
        user_id: str,
        state: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> Session:
        clean_id = session_id.strip() if isinstance(session_id, str) and session_id.strip() else None
        now = time.time()
        deltas = _session_util.extract_json_safe_state_delta(state or {})
        app_delta = deltas["app"]
        user_delta = deltas["user"]
        session_state = deltas["session"]

        with self._lock:
            if clean_id is not None:
                exists = self._conn.execute(
                    "SELECT 1 FROM sessions WHERE app_name = ? AND user_id = ? AND session_id = ?",
                    (app_name, user_id, clean_id),
                ).fetchone()
                if exists is not None:
                    raise AlreadyExistsError(f"Session with id {clean_id} already exists.")
            else:
                clean_id = uuid.uuid4().hex

            app_state = self._upsert_app_state_locked(app_name, app_delta, now)
            user_state = self._upsert_user_state_locked(app_name, user_id, user_delta, now)

            self._conn.execute(
                """
                INSERT INTO sessions (app_name, user_id, session_id, state_json, create_time, update_time)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    app_name,
                    user_id,
                    clean_id,
                    json.dumps(session_state, ensure_ascii=False),
                    now,
                    now,
                ),
            )
            self._conn.commit()

        merged_state = self._merge_scoped_state(session_state, app_state, user_state)
        return Session(
            id=clean_id,
            app_name=app_name,
            user_id=user_id,
            state=merged_state,
            events=[],
            last_update_time=now,
        )

    @override
    async def get_session(
        self,
        *,
        app_name: str,
        user_id: str,
        session_id: str,
        config: GetSessionConfig | None = None,
    ) -> Session | None:
        clean_id = session_id.strip() if isinstance(session_id, str) else session_id
        with self._lock:
            row = self._conn.execute(
                """
                SELECT state_json, update_time
                FROM sessions
                WHERE app_name = ? AND user_id = ? AND session_id = ?
                """,
                (app_name, user_id, clean_id),
            ).fetchone()
            if row is None:
                return None

            session_state = json.loads(row[0])
            update_time = float(row[1])
            app_state = self._read_app_state_locked(app_name)
            user_state = self._read_user_state_locked(app_name, user_id)

            event_rows = self._conn.execute(
                """
                SELECT event_json
                FROM events
                WHERE app_name = ? AND user_id = ? AND session_id = ?
                ORDER BY seq ASC
                """,
                (app_name, user_id, clean_id),
            ).fetchall()

        events = [Event.model_validate_json(er[0]) for er in event_rows]
        if config is not None:
            if config.num_recent_events is not None:
                events = [] if config.num_recent_events == 0 else events[-config.num_recent_events :]
            if config.after_timestamp is not None:
                idx = len(events) - 1
                while idx >= 0:
                    if events[idx].timestamp < config.after_timestamp:
                        break
                    idx -= 1
                if idx >= 0:
                    events = events[idx + 1 :]

        merged_state = self._merge_scoped_state(session_state, app_state, user_state)
        return Session(
            id=clean_id,
            app_name=app_name,
            user_id=user_id,
            state=merged_state,
            events=events,
            last_update_time=update_time,
        )

    @override
    async def list_sessions(
        self, *, app_name: str, user_id: str | None = None
    ) -> ListSessionsResponse:
        with self._lock:
            app_state = self._read_app_state_locked(app_name)
            if user_id is None:
                rows = self._conn.execute(
                    """
                    SELECT user_id, session_id, state_json, update_time
                    FROM sessions
                    WHERE app_name = ?
                    ORDER BY update_time ASC, user_id ASC, session_id ASC
                    """,
                    (app_name,),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT user_id, session_id, state_json, update_time
                    FROM sessions
                    WHERE app_name = ? AND user_id = ?
                    ORDER BY update_time ASC, user_id ASC, session_id ASC
                    """,
                    (app_name, user_id),
                ).fetchall()

            user_states_cache: dict[str, dict[str, Any]] = {}
            sessions_out: list[Session] = []
            for uid, sid, state_json, update_time in rows:
                if uid not in user_states_cache:
                    user_states_cache[uid] = self._read_user_state_locked(app_name, uid)
                merged_state = self._merge_scoped_state(
                    json.loads(state_json),
                    app_state,
                    user_states_cache[uid],
                )
                sessions_out.append(
                    Session(
                        id=sid,
                        app_name=app_name,
                        user_id=uid,
                        state=merged_state,
                        events=[],
                        last_update_time=float(update_time),
                    )
                )
        return ListSessionsResponse(sessions=sessions_out)

    @override
    async def delete_session(
        self, *, app_name: str, user_id: str, session_id: str
    ) -> None:
        clean_id = session_id.strip() if isinstance(session_id, str) else session_id
        with self._lock:
            self._conn.execute(
                "DELETE FROM events WHERE app_name = ? AND user_id = ? AND session_id = ?",
                (app_name, user_id, clean_id),
            )
            self._conn.execute(
                "DELETE FROM sessions WHERE app_name = ? AND user_id = ? AND session_id = ?",
                (app_name, user_id, clean_id),
            )
            self._conn.commit()

    @override
    async def get_user_state(self, *, app_name: str, user_id: str) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._read_user_state_locked(app_name, user_id))

    @override
    async def append_event(self, session: Session, event: Event) -> Event:
        if event.partial:
            return event

        app_name = session.app_name
        user_id = session.user_id
        session_id = session.id

        with self._lock:
            row = self._conn.execute(
                "SELECT state_json FROM sessions WHERE app_name = ? AND user_id = ? AND session_id = ?",
                (app_name, user_id, session_id),
            ).fetchone()
            if row is None:
                raise SessionNotFoundError(f"Session {session_id} not found.")

            dup_rows = self._conn.execute(
                """
                SELECT event_json
                FROM events
                WHERE app_name = ? AND user_id = ? AND session_id = ? AND id = ?
                """,
                (app_name, user_id, session_id, event.id),
            ).fetchall()
            if any(Event.model_validate_json(r[0]) == event for r in dup_rows):
                return event

        # Update in-memory session state and trim ephemeral temp:* keys before persistence
        await super().append_event(session=session, event=event)
        session.last_update_time = event.timestamp
        event_payload = event.model_dump_json(exclude_none=True)

        with self._lock:
            row = self._conn.execute(
                "SELECT state_json FROM sessions WHERE app_name = ? AND user_id = ? AND session_id = ?",
                (app_name, user_id, session_id),
            ).fetchone()
            if row is None:
                raise SessionNotFoundError(f"Session {session_id} not found.")

            stored_session_state = json.loads(row[0])
            if event.actions and event.actions.state_delta:
                deltas = _session_util.extract_json_safe_state_delta(event.actions.state_delta)
                if deltas["app"]:
                    self._upsert_app_state_locked(app_name, deltas["app"], event.timestamp)
                if deltas["user"]:
                    self._upsert_user_state_locked(app_name, user_id, deltas["user"], event.timestamp)
                if deltas["session"]:
                    stored_session_state.update(deltas["session"])

            self._conn.execute(
                """
                UPDATE sessions
                SET state_json = ?, update_time = ?
                WHERE app_name = ? AND user_id = ? AND session_id = ?
                """,
                (
                    json.dumps(stored_session_state, ensure_ascii=False),
                    event.timestamp,
                    app_name,
                    user_id,
                    session_id,
                ),
            )
            self._conn.execute(
                """
                INSERT INTO events (id, app_name, user_id, session_id, timestamp, event_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event.id,
                    app_name,
                    user_id,
                    session_id,
                    event.timestamp,
                    event_payload,
                ),
            )
            self._conn.commit()

        return event

    @override
    async def flush(self) -> None:
        with self._lock:
            self._conn.commit()

    def close(self) -> None:
        """Closes the underlying SQLite connection cleanly."""
        with self._lock:
            self._conn.close()


def describe_session_backend(service: BaseSessionService) -> str:
    """Returns a concise telemetry identifier for the active session backend."""
    if isinstance(service, InMemorySessionService):
        return "in_memory"
    if isinstance(service, VertexAiSessionService):
        return "vertex_ai"
    if isinstance(service, SqlitePersistentSessionService):
        return "sqlite_persistent"
    return type(service).__name__


def create_session_service() -> BaseSessionService:
    """Factory selecting `InMemory`, `VertexAi`, or default `SqlitePersistent` session store."""
    backend = os.environ.get("A4I_SESSION_BACKEND", "").strip().lower()
    if backend == "memory":
        logger.info("Using InMemorySessionService (A4I_SESSION_BACKEND=memory).")
        return InMemorySessionService()

    engine_id = os.environ.get("A4I_VERTEX_AGENT_ENGINE_ID", "").strip()
    if backend == "vertex" and engine_id:
        logger.info("Using VertexAiSessionService (agent_engine_id=%s).", engine_id)
        return VertexAiSessionService(
            project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
            location=os.environ.get("GOOGLE_CLOUD_LOCATION") or None,
            agent_engine_id=engine_id,
        )

    db_path = os.environ.get("A4I_SESSION_DB_PATH", DEFAULT_SESSION_DB_PATH).strip() or DEFAULT_SESSION_DB_PATH
    logger.info("Using SqlitePersistentSessionService (db_path=%s).", db_path)
    return SqlitePersistentSessionService(db_path=db_path)


__all__ = [
    "DEFAULT_SESSION_DB_PATH",
    "SqlitePersistentSessionService",
    "create_session_service",
    "describe_session_backend",
]
