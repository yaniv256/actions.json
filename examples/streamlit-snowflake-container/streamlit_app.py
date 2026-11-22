"""Read-only actions.json embedded-host acceptance for Snowflake containers."""

from __future__ import annotations

import os
import pathlib

import streamlit as st

from acceptance_support import (
    AcceptanceResources,
    acceptance_call,
    build_host,
    database_resources,
    mount,
)


ROOT = pathlib.Path(__file__).resolve().parents[2]


def snowflake_read() -> list[object]:
    if os.environ.get("ACTIONS_JSON_ACCEPTANCE_LOCAL") == "1":
        return [{"STATUS": 1}]
    session = st.connection("snowflake").session()
    return list(session.sql("SELECT 1 AS STATUS").collect())


@st.cache_resource
def resources() -> AcceptanceResources:
    database_url = os.environ.get("ACTIONS_JSON_DATABASE_URL")
    if database_url:
        configured = database_resources(ROOT, database_url)
    else:
        configured = AcceptanceResources(query=snowflake_read)
    transcript_url = os.environ.get("ACTIONS_JSON_TRANSCRIPT_DATABASE_URL")
    if transcript_url:
        configured.enable_transcripts_url(ROOT, transcript_url)
    return configured


st.title("actions.json · Streamlit on Snowflake")
st.caption("Read-only transport and reconstruction acceptance fixture")

shared = resources()
local_mode = os.environ.get("ACTIONS_JSON_ACCEPTANCE_LOCAL") == "1"
invocation_baseline = st.session_state.setdefault(
    "actions-json-acceptance-invocation-baseline",
    shared.provider_invocations,
)
trusted_user = (
    {"sub": "local-browser-characterization"}
    if local_mode
    else st.user
)
host = build_host(root=ROOT, user=trusted_user, resources=shared)
transcript_session_id = None
transcript_session_resumed = False
if shared.transcript_host is not None:
    transcript_session_id = st.session_state.get("actions-json-transcript-session-id")
    if transcript_session_id is None:
        transcript_session_id = shared.create_transcript_session(host.identity)
        st.session_state["actions-json-transcript-session-id"] = transcript_session_id
    else:
        shared.resume_transcript_session(host.identity, transcript_session_id)
        transcript_session_resumed = True
    host = shared.recording_host(host.identity, host, transcript_session_id)
mounted = mount(st, host, root=ROOT)
response = mounted.get("response")
transcript_evidence = (
    shared.transcript_evidence(host.identity, transcript_session_id)
    if transcript_session_id is not None
    else {"event_count": 0, "event_kinds": []}
)

st.subheader("Acceptance evidence")
st.json(
    {
        "projection": "streamlit-container-v2",
        "principal_source": (
            "local_test_double" if local_mode else "streamlit_authenticated_user"
        ),
        "authenticated_principal_bound": not local_mode,
        "call_id": acceptance_call()["call_id"],
        "continuation_minted": bool(mounted.get("continuation_id")),
        "provider_invocations": shared.provider_invocations - invocation_baseline,
        "response_type": response.get("type") if isinstance(response, dict) else None,
        "from_receipt": response.get("from_receipt") if isinstance(response, dict) else None,
        "transcript_enabled": transcript_session_id is not None,
        "transcript_session_resumed": transcript_session_resumed,
        "transcript_event_count": transcript_evidence["event_count"],
        "transcript_event_kinds": transcript_evidence["event_kinds"],
    }
)

st.info(
    "Click once for a live Snowflake-backed read. Click again with the same call ID: "
    "the response should report from_receipt=true while provider_invocations remains 1."
)
