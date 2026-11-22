"""Portable read-only page providers for actions.json embedded hosts."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import unquote


PAGE_TABLE = "actions_json_pages"
PAGE_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {PAGE_TABLE} (
    url TEXT PRIMARY KEY,
    text TEXT NOT NULL
)
""".strip()


class PageNotFound(LookupError):
    """The requested page URL is not in the configured corpus."""


class Connection(Protocol):
    def cursor(self) -> Any: ...

    def close(self) -> None: ...


class DatabasePageProvider:
    """Serve page reads and searches through a DB-API connection factory."""

    def __init__(
        self,
        connect: Callable[[], Connection],
        *,
        placeholder: str,
        backend: str,
    ) -> None:
        if placeholder not in {"?", "%s"}:
            raise ValueError("unsupported SQL placeholder")
        self._connect = connect
        self._placeholder = placeholder
        self.backend = backend

    def read_page(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        url = _required_text(arguments, "url")
        row = self._fetchone(
            f"SELECT url, text FROM {PAGE_TABLE} WHERE url = {self._placeholder}",
            (url,),
        )
        if row is None:
            raise PageNotFound(url)
        return {"url": str(row[0]), "text": str(row[1]), "backend": self.backend}

    def search_pages(self, arguments: Mapping[str, Any]) -> dict[str, Any]:
        query = _required_text(arguments, "query")
        limit = arguments.get("limit", 5)
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 10:
            raise ValueError("limit must be an integer from 1 through 10")
        escaped = query.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        rows = self._fetchall(
            (
                f"SELECT url, text FROM {PAGE_TABLE} "
                f"WHERE LOWER(text) LIKE {self._placeholder} ESCAPE '\\' "
                f"ORDER BY url LIMIT {self._placeholder}"
            ),
            (pattern, limit),
        )
        return {
            "query": query,
            "pages": [
                {"url": str(row[0]), "text": str(row[1])}
                for row in rows
            ],
            "backend": self.backend,
        }

    def handlers(self) -> dict[str, Callable[[Mapping[str, Any]], dict[str, Any]]]:
        return {
            "database.page.read": self.read_page,
            "database.page.search": self.search_pages,
        }

    def _fetchone(self, statement: str, parameters: tuple[Any, ...]) -> Any:
        connection = self._connect()
        try:
            cursor = connection.cursor()
            try:
                cursor.execute(statement, parameters)
                return cursor.fetchone()
            finally:
                cursor.close()
        finally:
            connection.close()

    def _fetchall(self, statement: str, parameters: tuple[Any, ...]) -> list[Any]:
        connection = self._connect()
        try:
            cursor = connection.cursor()
            try:
                cursor.execute(statement, parameters)
                return list(cursor.fetchall())
            finally:
                cursor.close()
        finally:
            connection.close()


def provider_from_url(database_url: str) -> DatabasePageProvider:
    """Build a SQLite or PostgreSQL provider from an explicit database URL."""

    if database_url.startswith("sqlite://"):
        database = unquote(database_url.removeprefix("sqlite://"))
        if not database:
            raise ValueError("SQLite URL must name a database file")
        path = Path(database).expanduser().resolve()
        return DatabasePageProvider(
            lambda: sqlite3.connect(path),
            placeholder="?",
            backend="sqlite",
        )

    if database_url.startswith(("postgres://", "postgresql://")):
        try:
            import psycopg
        except ImportError as error:
            raise RuntimeError("PostgreSQL support requires psycopg") from error
        return DatabasePageProvider(
            lambda: psycopg.connect(database_url),
            placeholder="%s",
            backend="postgresql",
        )

    raise ValueError("database URL must use sqlite://, postgres://, or postgresql://")


def _required_text(arguments: Mapping[str, Any], name: str) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    return value
