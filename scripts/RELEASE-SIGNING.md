# Native release signing

Native actions.json releases use an RSA-3072 key dedicated to the `stable`
channel. Installers pin its public half under key ID
`actions-json-stable-2026-01`; the SHA-256 fingerprint of the public-key DER is:

`197d8b660aee7116592ba2137ee3745fe935158e0d2e677cc0ed42b2b227f225`

The private half is not stored in this repository. On the release owner host,
`scripts/release-binaries.sh` reads it from
`$HOME/.config/actions-json/release-signing-2026-01.pem`, or from the explicit
path in `ACTIONS_JSON_RELEASE_SIGNING_KEY` / `--signing-key`. The release fails
before building or uploading when that file is unreadable. The owner-host copy
must be mode `0600`.

Before a release, derive the public key from the private file and compare its
DER fingerprint with the value above and with `scripts/release-trust.json`.
Never print or attach the private key. Key rotation adds a second key with an
overlapping counter window before retiring or revoking the old key; a release
counter outside its key's declared window is rejected.

## macOS builders

The release owner does not need a Mac or an SSH credential. The release script
dispatches `.github/workflows/build-macos-native.yml` at the exact release tag
and commit. GitHub-hosted `macos-latest` runners build the x86_64 and arm64
archives, and the owner host downloads them only after the workflow succeeds
and its recorded `head_sha` matches the local release commit.

The downloaded macOS archives join the Linux, Windows, and extension assets
before the signed release manifest is created. They therefore remain covered
by the same local signing key, complete-asset postcondition, draft staging,
remote byte comparison, and final publication gate as every other asset.
