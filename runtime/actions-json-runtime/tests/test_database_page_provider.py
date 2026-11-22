import importlib.util
import os
import pathlib
import sqlite3
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]
MODULE_PATH = ROOT / "contracts" / "capability-resolution" / "database_page_provider.py"


def load_provider_module():
    spec = importlib.util.spec_from_file_location("actions_json_database_page_provider", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class DatabasePageProviderContract:
    module = load_provider_module()

    def database_url(self) -> str:
        raise NotImplementedError

    def seed(self) -> None:
        raise NotImplementedError

    def setUp(self):
        self.seed()
        self.provider = self.module.provider_from_url(self.database_url())

    def test_reads_complete_page_text_from_a_live_connection(self):
        result = self.provider.read_page({"url": "https://example.test/alpha"})
        self.assertEqual("https://example.test/alpha", result["url"])
        self.assertEqual("Alpha full page text. Searchable needle.", result["text"])
        self.assertEqual(self.expected_backend, result["backend"])

    def test_searches_live_page_text_and_respects_limit(self):
        result = self.provider.search_pages({"query": "needle", "limit": 1})
        self.assertEqual("needle", result["query"])
        self.assertEqual(1, len(result["pages"]))
        self.assertIn("Searchable needle", result["pages"][0]["text"])

    def test_search_treats_like_metacharacters_as_literal_text(self):
        self.assertEqual([], self.provider.search_pages({"query": "%"})["pages"])
        self.assertEqual([], self.provider.search_pages({"query": "_"})["pages"])

    def test_missing_page_is_explicit(self):
        with self.assertRaises(self.module.PageNotFound):
            self.provider.read_page({"url": "https://example.test/missing"})


class SqliteDatabasePageProviderTest(DatabasePageProviderContract, unittest.TestCase):
    expected_backend = "sqlite"

    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temporary_directory.name) / "pages.sqlite3"
        super().setUp()

    def tearDown(self):
        self.temporary_directory.cleanup()

    def database_url(self) -> str:
        return f"sqlite://{self.path}"

    def seed(self) -> None:
        connection = sqlite3.connect(self.path)
        try:
            connection.execute(self.module.PAGE_SCHEMA_SQL)
            connection.executemany(
                f"INSERT INTO {self.module.PAGE_TABLE} (url, text) VALUES (?, ?)",
                [
                    ("https://example.test/alpha", "Alpha full page text. Searchable needle."),
                    ("https://example.test/beta", "Beta full page text. Searchable needle."),
                ],
            )
            connection.commit()
        finally:
            connection.close()


@unittest.skipUnless(os.environ.get("ACTIONS_JSON_TEST_POSTGRES_DSN"), "PostgreSQL DSN not configured")
class PostgresDatabasePageProviderTest(DatabasePageProviderContract, unittest.TestCase):
    expected_backend = "postgresql"

    def database_url(self) -> str:
        return os.environ["ACTIONS_JSON_TEST_POSTGRES_DSN"]

    def seed(self) -> None:
        import psycopg

        connection = psycopg.connect(self.database_url())
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"DROP TABLE IF EXISTS {self.module.PAGE_TABLE}")
                cursor.execute(self.module.PAGE_SCHEMA_SQL)
                cursor.executemany(
                    f"INSERT INTO {self.module.PAGE_TABLE} (url, text) VALUES (%s, %s)",
                    [
                        ("https://example.test/alpha", "Alpha full page text. Searchable needle."),
                        ("https://example.test/beta", "Beta full page text. Searchable needle."),
                    ],
                )
            connection.commit()
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
