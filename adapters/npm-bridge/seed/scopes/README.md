# scopes/

Each subfolder is a **mounted scope** — a separate storage area with its own visibility. Scopes are
usually git submodules pointing at their own repositories, so they can have different access than this
root repo.

- **public/** — reviewed, reusable public site-action maps (a git submodule to a public repo).
- **private/** — your OWN owner-only storage (see its README). Not included in this public example.

Add further scopes (e.g. `shared/<audience>/`) as separate repositories when you need them.
