"""Snowflake Hybrid Table receipt store for trusted Streamlit hosts.

The adapter uses one connection per operation. Snowflake warns that concurrent
threads sharing a connection also share its transaction, so a connection is
never retained on the store object. Admission is a single INSERT protected by
an enforced composite primary key. Completion is a conditional UPDATE over the
reserved state, request digest, and owner token.

Only the dedicated receipt table is touched. ``preflight`` exercises the real
insert/lock/compare-and-set path inside a transaction that is always rolled
back; it never probes by mutating user domain data.
"""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Callable, Mapping
from typing import Any


_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
_TERMINAL = {"settled_success", "settled_error"}


def _canonical(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _authority_key(scope: Mapping[str, Any]) -> str:
    return _canonical(
        [
            scope.get("tenant_id"),
            scope.get("installation_id"),
            scope.get("principal_id"),
            scope.get("authority_mode", "unspecified"),
            scope.get("continuation_id") or scope.get("session_id"),
        ]
    )


def _table_name(value: str) -> str:
    parts = value.split(".")
    if not 1 <= len(parts) <= 3 or any(not _IDENTIFIER.fullmatch(part) for part in parts):
        raise ValueError("table must be an unquoted one-, two-, or three-part Snowflake identifier")
    return ".".join(parts)


def _loads(value: Any) -> Any:
    if value is None or not isinstance(value, str):
        return value
    return json.loads(value)


class SnowflakeReceiptStore:
    """Durable receipt state machine backed by one Snowflake Hybrid Table."""

    def __init__(
        self,
        connection_factory: Callable[[], Any],
        *,
        table: str,
        lease_seconds: int = 60,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        if not 1 <= lease_seconds <= 300:
            raise ValueError("lease_seconds must be between 1 and 300")
        self._connection_factory = connection_factory
        self._table = _table_name(table)
        self._lease_seconds = lease_seconds
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))

    @staticmethod
    def setup_sql(table: str) -> str:
        name = _table_name(table)
        return f"""
CREATE HYBRID TABLE IF NOT EXISTS {name} (
  AUTHORITY_KEY VARCHAR NOT NULL,
  CALL_ID VARCHAR NOT NULL,
  STATE VARCHAR NOT NULL,
  REQUEST_DIGEST VARCHAR NOT NULL,
  EXECUTION_BINDING_JSON VARCHAR NOT NULL,
  OWNER_TOKEN VARCHAR NOT NULL,
  OWNER_LEASE_EXPIRES_AT TIMESTAMP_NTZ NOT NULL,
  RESULT_JSON VARCHAR,
  ERROR_JSON VARCHAR,
  UPDATED_AT TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (AUTHORITY_KEY, CALL_ID)
)
""".strip()

    def setup_packet(self) -> dict[str, str]:
        """Return the bounded, copyable bootstrap required by HostState."""

        return {
            "sql": self.setup_sql(self._table),
            "required_privilege": (
                "OWNERSHIP on the target schema or CREATE HYBRID TABLE"
            ),
            "target": self._table,
        }

    def setup_required(self) -> dict[str, Any]:
        """Return trusted setup evidence after provisioning is independently verified.

        Reconstruct the host after the operator runs this packet so a fresh
        preflight can replace the setup-required snapshot with a ready one.
        """

        return {"state": "setup_required", "setup_packet": self.setup_packet()}

    @staticmethod
    def read_only_ready() -> dict[str, str]:
        """Return trusted evidence that this principal cannot provision the store."""

        return {"state": "read_only_ready"}

    def _select(self, cursor: Any, key: str, call_id: str) -> dict[str, Any] | None:
        cursor.execute(
            f"""
SELECT STATE, REQUEST_DIGEST, EXECUTION_BINDING_JSON, OWNER_TOKEN,
       RESULT_JSON, ERROR_JSON,
       IFF(OWNER_LEASE_EXPIRES_AT > CURRENT_TIMESTAMP(), TRUE, FALSE) AS OWNER_LIVE
  FROM {self._table}
 WHERE AUTHORITY_KEY = %s AND CALL_ID = %s
""",
            (key, call_id),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "state": row[0],
            "request_digest": row[1],
            "execution_binding": _loads(row[2]),
            "owner_token": row[3],
            "result": _loads(row[4]),
            "error": _loads(row[5]),
            "owner_live": bool(row[6]),
        }

    @staticmethod
    def _inspection(row: dict[str, Any] | None) -> dict[str, Any]:
        if row is None:
            return {"state": "absent"}
        if row["state"] in _TERMINAL:
            return {"state": "settled", "row": row}
        if row["state"] != "reserved":
            return {"state": "unrecognised", "row": row}
        if row["owner_live"]:
            return {"state": "in_flight", "row": row}
        return {"state": "unknown_disposition", "row": row}

    def inspect(self, scope: Mapping[str, Any], call_id: str) -> dict[str, Any]:
        connection = self._connection_factory()
        cursor = connection.cursor()
        try:
            return self._inspection(self._select(cursor, _authority_key(scope), call_id))
        finally:
            cursor.close()
            connection.close()

    def has_scope(self, scope: Mapping[str, Any]) -> bool:
        """Return whether a server-bound continuation already owns receipts."""

        connection = self._connection_factory()
        cursor = connection.cursor()
        try:
            cursor.execute(
                f"SELECT 1 FROM {self._table} WHERE AUTHORITY_KEY = %s LIMIT 1",
                (_authority_key(scope),),
            )
            return cursor.fetchone() is not None
        finally:
            cursor.close()
            connection.close()

    def reserve(
        self,
        scope: Mapping[str, Any],
        call_id: str,
        digest: str,
        execution_binding: Mapping[str, Any],
    ) -> dict[str, Any]:
        key = _authority_key(scope)
        owner_token = self._token_factory()
        binding_json = _canonical(execution_binding)
        connection = self._connection_factory()
        cursor = connection.cursor()
        try:
            cursor.execute("BEGIN")
            try:
                cursor.execute(
                    f"""
INSERT INTO {self._table}
  (AUTHORITY_KEY, CALL_ID, STATE, REQUEST_DIGEST,
   EXECUTION_BINDING_JSON, OWNER_TOKEN, OWNER_LEASE_EXPIRES_AT,
   RESULT_JSON, ERROR_JSON)
VALUES (%s, %s, 'reserved', %s, %s, %s,
        DATEADD('second', %s, CURRENT_TIMESTAMP()), NULL, NULL)
""",
                    (key, call_id, digest, binding_json, owner_token, self._lease_seconds),
                )
            except Exception as insert_error:
                connection.rollback()
                row = self._select(cursor, key, call_id)
                if row is None:
                    raise insert_error
                if row["request_digest"] != digest:
                    return {"state": "conflict"}
                return self._inspection(row)
            connection.commit()
            return {"state": "acquired", "owner_token": owner_token}
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
            connection.close()

    def settle(
        self,
        scope: Mapping[str, Any],
        call_id: str,
        *,
        digest: str,
        owner_token: str,
        result: Any = None,
        error: Any = None,
    ) -> dict[str, Any]:
        key = _authority_key(scope)
        state = "settled_error" if error is not None else "settled_success"
        result_json = None if result is None else _canonical(result)
        error_json = None if error is None else _canonical(error)
        connection = self._connection_factory()
        cursor = connection.cursor()
        try:
            cursor.execute("BEGIN")
            cursor.execute(
                f"""
UPDATE {self._table}
   SET STATE = %s, RESULT_JSON = %s, ERROR_JSON = %s,
       UPDATED_AT = CURRENT_TIMESTAMP()
 WHERE AUTHORITY_KEY = %s AND CALL_ID = %s
   AND STATE = 'reserved'
   AND REQUEST_DIGEST = %s
   AND OWNER_TOKEN = %s
""",
                (state, result_json, error_json, key, call_id, digest, owner_token),
            )
            if cursor.rowcount == 1:
                connection.commit()
                return {"ok": True, "state": state}

            connection.rollback()
            row = self._select(cursor, key, call_id)
            if row is None:
                return {"ok": False, "reason": "no_reservation"}
            if row["state"] in _TERMINAL:
                return {"ok": False, "reason": "already_terminal"}
            if row["request_digest"] != digest:
                return {"ok": False, "reason": "wrong_digest"}
            if row["owner_token"] != owner_token:
                return {"ok": False, "reason": "wrong_owner"}
            return {"ok": False, "reason": "conditional_update_failed"}
        except Exception:
            connection.rollback()
            raise
        finally:
            cursor.close()
            connection.close()

    def preflight(self) -> dict[str, Any]:
        """Exercise receipt-table primitives without a persistent side effect."""

        key = "__actions_json_preflight__"
        call_id = secrets.token_urlsafe(18)
        owner_token = self._token_factory()
        connection = None
        cursor = None
        outcome: dict[str, Any]
        try:
            connection = self._connection_factory()
            cursor = connection.cursor()
            cursor.execute("BEGIN")
            cursor.execute(
                f"""
INSERT INTO {self._table}
  (AUTHORITY_KEY, CALL_ID, STATE, REQUEST_DIGEST,
   EXECUTION_BINDING_JSON, OWNER_TOKEN, OWNER_LEASE_EXPIRES_AT,
   RESULT_JSON, ERROR_JSON)
VALUES (%s, %s, 'reserved', %s, %s, %s,
        DATEADD('second', %s, CURRENT_TIMESTAMP()), NULL, NULL)
""",
                (
                    key,
                    call_id,
                    "__actions_json_preflight__",
                    _canonical({"kind": "receipt-store-preflight"}),
                    owner_token,
                    self._lease_seconds,
                ),
            )
            cursor.execute(
                f"SELECT STATE FROM {self._table} WHERE AUTHORITY_KEY = %s AND CALL_ID = %s FOR UPDATE NOWAIT",
                (key, call_id),
            )
            row = cursor.fetchone()
            if row is None or row[0] != "reserved":
                raise RuntimeError("receipt preflight reservation was not readable")
            cursor.execute(
                f"""
UPDATE {self._table} SET STATE = 'settled_success', UPDATED_AT = CURRENT_TIMESTAMP()
 WHERE AUTHORITY_KEY = %s AND CALL_ID = %s
   AND STATE = 'reserved' AND REQUEST_DIGEST = %s AND OWNER_TOKEN = %s
""",
                (key, call_id, "__actions_json_preflight__", owner_token),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("receipt preflight compare-and-set failed")
            cursor.execute(
                f"DELETE FROM {self._table} WHERE AUTHORITY_KEY = %s AND CALL_ID = %s",
                (key, call_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("receipt preflight cleanup failed")
            outcome = {"state": "durable_mutation_store_ready"}
        except Exception:
            # Failure does not prove that DDL is the remedy. Connection loss,
            # an incompatible existing table, and missing privileges all fail
            # the same operation probe. Keep this internal disposition out of
            # HostState until trusted provisioning evidence selects either
            # setup_required() or read_only_ready.
            outcome = {
                "state": "unavailable",
                "reason": "receipt_store_preflight_failed",
            }
        finally:
            rollback_failed = False
            if connection is not None:
                try:
                    connection.rollback()
                except Exception:
                    rollback_failed = True
            if cursor is not None:
                try:
                    cursor.close()
                except Exception:
                    pass
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            if rollback_failed:
                outcome = {
                    "state": "unavailable",
                    "reason": "receipt_store_cleanup_failed",
                }
        return outcome
