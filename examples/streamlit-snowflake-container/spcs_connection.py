"""Fresh Snowflake connections using SPCS-provided service credentials."""

from __future__ import annotations

import os
import pathlib
from collections.abc import Callable, Mapping
from typing import Any


DEFAULT_TOKEN_PATH = pathlib.Path("/snowflake/session/token")


def spcs_service_connection_factory(
    connect: Callable[..., Any],
    *,
    environ: Mapping[str, str] | None = None,
    token_path: pathlib.Path = DEFAULT_TOKEN_PATH,
) -> Callable[[], Any]:
    """Return a factory that opens one fresh service-user SQL session per call."""

    environment = os.environ if environ is None else environ
    host = environment.get("SNOWFLAKE_HOST")
    account = environment.get("SNOWFLAKE_ACCOUNT")
    if not host or not account:
        raise RuntimeError(
            "SPCS connection requires SNOWFLAKE_HOST and SNOWFLAKE_ACCOUNT"
        )

    optional_context = {
        key: value
        for key, value in (
            ("database", environment.get("SNOWFLAKE_DATABASE")),
            ("schema", environment.get("SNOWFLAKE_SCHEMA")),
            ("warehouse", environment.get("SNOWFLAKE_WAREHOUSE")),
        )
        if value
    }

    def open_connection() -> Any:
        try:
            token = token_path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise RuntimeError("SPCS service token is unavailable") from error
        if not token:
            raise RuntimeError("SPCS service token is empty")
        return connect(
            host=host,
            account=account,
            token=token,
            authenticator="oauth",
            **optional_context,
        )

    return open_connection
