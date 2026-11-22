import importlib.util
import json
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "contracts" / "capability-resolution" / "snowflake_receipt_store.py"


def load_store_module():
    spec = importlib.util.spec_from_file_location("snowflake_receipt_store", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class Step:
    def __init__(self, contains, *, row=None, rowcount=0, error=None):
        self.contains = contains
        self.row = row
        self.rowcount = rowcount
        self.error = error


class ScriptedCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rowcount = -1
        self._row = None

    def execute(self, sql, params=None):
        self.connection.executed.append((" ".join(sql.split()), params))
        if not self.connection.steps:
            raise AssertionError(f"unexpected SQL: {sql}")
        step = self.connection.steps.pop(0)
        if step.contains not in " ".join(sql.split()):
            raise AssertionError(f"expected {step.contains!r}, got {sql!r}")
        if step.error is not None:
            raise step.error
        self.rowcount = step.rowcount
        self._row = step.row
        return self

    def fetchone(self):
        return self._row

    def close(self):
        self.connection.cursor_closed += 1
        if self.connection.cursor_close_error is not None:
            raise self.connection.cursor_close_error


class ScriptedConnection:
    def __init__(
        self,
        steps,
        *,
        cursor_error=None,
        rollback_error=None,
        cursor_close_error=None,
        close_error=None,
    ):
        self.steps = list(steps)
        self.cursor_error = cursor_error
        self.rollback_error = rollback_error
        self.cursor_close_error = cursor_close_error
        self.close_error = close_error
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = 0
        self.cursor_closed = 0

    def cursor(self):
        if self.cursor_error is not None:
            raise self.cursor_error
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1
        if self.rollback_error is not None:
            raise self.rollback_error

    def close(self):
        self.closed += 1
        if self.close_error is not None:
            raise self.close_error


class SnowflakeReceiptStoreTest(unittest.TestCase):
    def setUp(self):
        self.module = load_store_module()
        self.scope = {
            "tenant_id": "tenant-1",
            "installation_id": "install-1",
            "principal_id": "viewer@example.com",
            "authority_mode": "owner_rights",
            "continuation_id": "continuation-1",
        }

    def make_store(self, connection, **kwargs):
        return self.module.SnowflakeReceiptStore(
            lambda: connection,
            table="APP_DB.ACTIONS_JSON.RECEIPTS",
            token_factory=lambda: "owner-token",
            **kwargs,
        )

    def test_setup_uses_hybrid_table_and_enforced_composite_primary_key(self):
        sql = self.module.SnowflakeReceiptStore.setup_sql("APP_DB.ACTIONS_JSON.RECEIPTS")
        normalized = " ".join(sql.split())
        self.assertIn("CREATE HYBRID TABLE IF NOT EXISTS APP_DB.ACTIONS_JSON.RECEIPTS", normalized)
        self.assertIn("PRIMARY KEY (AUTHORITY_KEY, CALL_ID)", normalized)
        self.assertIn("OWNER_LEASE_EXPIRES_AT TIMESTAMP_NTZ NOT NULL", normalized)

    def test_reserve_is_one_atomic_insert_and_commits_acquisition(self):
        connection = ScriptedConnection([Step("BEGIN"), Step("INSERT INTO", rowcount=1)])
        store = self.make_store(connection)
        claim = store.reserve(
            self.scope,
            "call-1",
            "digest-1",
            {"provider": "snowflake", "effect": "mutation"},
        )
        self.assertEqual({"state": "acquired", "owner_token": "owner-token"}, claim)
        self.assertEqual(1, connection.commits)
        self.assertEqual(0, connection.rollbacks)
        insert_sql, params = connection.executed[1]
        self.assertIn("DATEADD('second', %s, CURRENT_TIMESTAMP())", insert_sql)
        self.assertEqual("digest-1", params[2])

    def test_reserve_race_rolls_back_then_reads_the_winner(self):
        terminal = (
            "settled_success",
            "digest-1",
            '{"provider":"snowflake"}',
            None,
            '{"ok":true}',
            None,
            False,
        )
        connection = ScriptedConnection(
            [
                Step("BEGIN"),
                Step("INSERT INTO", error=RuntimeError("duplicate key")),
                Step("SELECT STATE", row=terminal),
            ]
        )
        store = self.make_store(connection)
        claim = store.reserve(self.scope, "call-1", "digest-1", {"provider": "snowflake"})
        self.assertEqual("settled", claim["state"])
        self.assertEqual({"ok": True}, claim["row"]["result"])
        self.assertEqual(1, connection.rollbacks)

    def test_settle_is_conditional_on_state_digest_and_owner(self):
        connection = ScriptedConnection([Step("BEGIN"), Step("UPDATE", rowcount=1)])
        store = self.make_store(connection)
        result = store.settle(
            self.scope,
            "call-1",
            digest="digest-1",
            owner_token="owner-token",
            result={"ok": True},
        )
        self.assertEqual({"ok": True, "state": "settled_success"}, result)
        update_sql, params = connection.executed[1]
        self.assertIn("STATE = 'reserved'", update_sql)
        self.assertIn("REQUEST_DIGEST = %s", update_sql)
        self.assertIn("OWNER_TOKEN = %s", update_sql)
        self.assertEqual("digest-1", params[-2])
        self.assertEqual("owner-token", params[-1])
        self.assertEqual(1, connection.commits)

    def test_has_scope_uses_authority_key_without_exposing_rows(self):
        connection = ScriptedConnection([Step("SELECT 1 FROM", row=(1,))])
        store = self.make_store(connection)
        self.assertTrue(store.has_scope(self.scope))
        sql, params = connection.executed[0]
        self.assertIn("AUTHORITY_KEY = %s", sql)
        self.assertNotIn("OWNER_TOKEN", sql)
        self.assertEqual(1, len(params))

    def test_failed_conditional_settlement_returns_current_disposition(self):
        reserved = (
            "reserved",
            "digest-1",
            '{"provider":"snowflake"}',
            "other-owner",
            None,
            None,
            True,
        )
        connection = ScriptedConnection(
            [Step("BEGIN"), Step("UPDATE", rowcount=0), Step("SELECT STATE", row=reserved)]
        )
        store = self.make_store(connection)
        result = store.settle(
            self.scope,
            "call-1",
            digest="digest-1",
            owner_token="owner-token",
            result={"ok": True},
        )
        self.assertEqual({"ok": False, "reason": "wrong_owner"}, result)
        self.assertEqual(1, connection.rollbacks)

    def test_preflight_exercises_only_the_receipt_backend_and_rolls_back(self):
        connection = ScriptedConnection(
            [
                Step("BEGIN"),
                Step("INSERT INTO", rowcount=1),
                Step("SELECT STATE", row=("reserved",)),
                Step("UPDATE", rowcount=1),
                Step("DELETE FROM", rowcount=1),
            ]
        )
        store = self.make_store(connection)
        result = store.preflight()
        self.assertEqual({"state": "durable_mutation_store_ready"}, result)
        self.assertEqual(1, connection.rollbacks)
        self.assertEqual(0, connection.commits)
        self.assertEqual(1, connection.closed)
        all_sql = " ".join(sql for sql, _ in connection.executed)
        self.assertIn("__actions_json_preflight__", str(connection.executed))
        self.assertNotIn("MERGE", all_sql)

    def test_setup_required_returns_the_copyable_bounded_setup_packet(self):
        connection = ScriptedConnection([])
        store = self.make_store(connection)

        result = store.setup_required()

        self.assertEqual("setup_required", result["state"])
        self.assertEqual(
            "APP_DB.ACTIONS_JSON.RECEIPTS",
            result["setup_packet"]["target"],
        )
        self.assertIn("CREATE HYBRID TABLE IF NOT EXISTS", result["setup_packet"]["sql"])
        self.assertIn("CREATE HYBRID TABLE", result["setup_packet"]["required_privilege"])
        self.assertEqual({"state": "read_only_ready"}, store.read_only_ready())

    def test_failed_preflight_is_bounded_but_does_not_guess_the_remedy(self):
        connection = ScriptedConnection([Step("BEGIN", error=RuntimeError("account secret"))])
        store = self.make_store(connection)

        result = store.preflight()

        self.assertEqual("unavailable", result["state"])
        self.assertEqual("receipt_store_preflight_failed", result["reason"])
        self.assertEqual({"state", "reason"}, set(result))
        self.assertNotIn("setup_packet", result)
        self.assertNotIn("account secret", str(result))
        self.assertEqual(1, connection.closed)

    def test_connection_factory_and_cleanup_failures_stay_bounded(self):
        store = self.module.SnowflakeReceiptStore(
            lambda: (_ for _ in ()).throw(RuntimeError("secret locator")),
            table="APP_DB.ACTIONS_JSON.RECEIPTS",
        )
        self.assertEqual(
            {"state": "unavailable", "reason": "receipt_store_preflight_failed"},
            store.preflight(),
        )

        cursor_failure = ScriptedConnection(
            [], cursor_error=RuntimeError("cursor secret")
        )
        self.assertEqual(
            {"state": "unavailable", "reason": "receipt_store_preflight_failed"},
            self.make_store(cursor_failure).preflight(),
        )
        self.assertEqual(1, cursor_failure.closed)

        rollback_failure = ScriptedConnection(
            [Step("BEGIN", error=RuntimeError("query-locator-9f3"))],
            rollback_error=RuntimeError("rollback-locator-9f3"),
        )
        result = self.make_store(rollback_failure).preflight()
        self.assertEqual(
            {"state": "unavailable", "reason": "receipt_store_cleanup_failed"},
            result,
        )
        self.assertNotIn("locator-9f3", json.dumps(result))

        for errors in (
            {"cursor_close_error": RuntimeError("cursor-locator-9f3")},
            {"close_error": RuntimeError("connection-locator-9f3")},
        ):
            with self.subTest(errors=tuple(errors)):
                connection = ScriptedConnection(
                    [Step("BEGIN", error=RuntimeError("query-locator-9f3"))],
                    **errors,
                )
                result = self.make_store(connection).preflight()
                self.assertEqual(
                    {"state": "unavailable", "reason": "receipt_store_preflight_failed"},
                    result,
                )
                self.assertEqual(1, connection.cursor_closed)
                self.assertEqual(1, connection.closed)
                self.assertNotIn("locator-9f3", json.dumps(result))

        successful_close_failure = ScriptedConnection(
            [
                Step("BEGIN"),
                Step("INSERT INTO", rowcount=1),
                Step("SELECT STATE", row=("reserved",)),
                Step("UPDATE", rowcount=1),
                Step("DELETE FROM", rowcount=1),
            ],
            close_error=RuntimeError("close-locator-9f3"),
        )
        self.assertEqual(
            {"state": "durable_mutation_store_ready"},
            self.make_store(successful_close_failure).preflight(),
        )


if __name__ == "__main__":
    unittest.main()
