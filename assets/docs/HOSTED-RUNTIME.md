# Hosted application runtime

This is the application contract for the existing `engine.deepnative.io` release.
It does not itself deploy infrastructure, migrate the current Azure data, enable
external providers, or establish that the hosted release has passed acceptance.
The authoritative release scope and deployment evidence belong to [issue #45](https://github.com/deepnative/deep-native-engine/issues/45).

## Required configuration

Hosting is explicit through `DNE_PUBLIC_ORIGIN`. Configure all of these together
through the deployment's protected configuration and secret references:

| Setting | Contract |
| --- | --- |
| `DNE_PUBLIC_ORIGIN` | Exact public HTTPS origin, such as `https://engine.deepnative.io`; no trailing slash, path, credentials, query or custom port. |
| `DNE_DATABASE_URL` | Dedicated application PostgreSQL URL with exactly `sslmode=verify-full`. Azure uses the passwordless `dne_engine` role and verified hostname/certificate. Existing explicit credentialed configurations remain supported; keep their values secret. |
| `DNE_DATABASE_AUTH` | Azure deployment sets `managed-identity`, requires a passwordless Azure PostgreSQL URL and uses fresh per-connection tokens from the selected UAMI. No static-password or credential-chain fallback. Omit only for an existing credentialed configuration. |
| `DNE_AZURE_BLOB_ACCOUNT_URL` | Canonical `https://ACCOUNT.blob.core.windows.net` URL, without a SAS token. |
| `DNE_AZURE_BLOB_CONTAINER` | Existing private container. The application does not create it or enable anonymous access. |
| `DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID` | Exact user-assigned managed identity attached to the app, with object access restricted to the selected container. |

The database must be nonloopback outside tests and its name must not designate a
development, demo or test database. Test mode retains the generated loopback
`dne_test_` database requirement and still requires verified TLS. Incomplete
hosting configuration and public impersonation fail startup. Without
`DNE_PUBLIC_ORIGIN`, the existing local database/storage restrictions apply.

`DNE_APP_MODE` and individual provider settings retain their existing simulated
or disabled contracts. Hosting on Azure does not make AI, payment, authentication,
mail, calendars or other integrations live. The existing `live`-mode refusal is
preserved; this change does not authorize a provider or change permissions.

## Request and storage boundaries

The listener binds loopback within the container group. A deployment proxy must
forward canonical traffic with the configured public `Host` and unchanged
`Origin`. Only the exact original owned Azure alias may be normalized after
validating its original matching Host/Origin pair, preserving its host-only
member cookie; all other addresses and crossed pairs are refused. Do not use the older proxy's loopback Host/Origin translation for
this contract. The application accepts only the exact configured Host and write
Origin and still requires its normal CSRF token. Forwarded headers cannot grant
access. On an authenticated HTTPS page read, the same inherited bearer cookie is
reissued with its existing database deadline and Secure/HttpOnly/SameSite=Strict.
This upgrades transport protection without creating a principal or renewing the
session, saved work or finite staff grants. HTTP loopback behavior is unchanged;
expired/revoked members receive no active-cookie upgrade. HTTPS member cookies,
including deletion cookies, use Secure, HttpOnly
and SameSite=Strict; TLS termination must remain enabled at Azure ingress.

PostgreSQL stores member identities, work and permissions. Evidence bytes use
the selected Azure container through managed identity. Writes require a new UUID
key and cannot overwrite an existing object. Reads are bounded by the existing
evidence size limit; failures return no partial bytes. Removal is idempotent.
Object operations have bounded deadlines, no SDK retries, and no local-file or
public-link fallback. Existing ownership, quarantine, exact grants, revocation,
deletion recovery and digest checks continue to govern access. Prepared source
bindings retain their existing immutable-source implementation.

The existing `DNE_PREPARED_REVIEW_SAMPLES=enabled` opt-in also admits the provided
copy journey at the exact validated `DNE_PUBLIC_ORIGIN`. Runtime passes that
trusted origin separately to the application, route and store gates. A public
URL or flag alone does not enable it; absent, different or noncanonical hosting
context is refused. The existing HTTP loopback demo/test contract is unchanged,
and live-provider mode remains refused. Members still choose an exact supplied
template and separately acknowledge its provided origin and private review.
Copying creates only an owned immutable source binding, never an arbitrary clean
upload, queued review, staff role, assignment or entitlement. General uploads
retain their existing quarantine checks. Existing source labels are unchanged;
the separately owned hosted-copy finding must be resolved before public release.

Managed-identity HTTP requests also have a five-second timeout and no credential
retries; the Blob operation's abort signal alone does not bound authentication
in the pinned SDK. A stalled-endpoint native regression checks this transport.

Azure storage requires durable write recovery. Migration 072 adds a key-only
intent table. Before private bytes are written, the same checked-out database
client commits an intent while holding a per-key session advisory lock. The
business transaction commits the evidence/derivative metadata and removes the
intent together. A lost storage acknowledgement, rollback or disconnected
writer leaves its key discoverable. The existing periodic recovery cycle uses
nonblocking advisory locks and its own bounded cursor: active writers are
skipped and referenced objects and their uncertain intents are preserved.
Unreferenced bytes are replaced atomically by a permanent empty object at the
same key. This blocks an outstanding create-only upload from creating private
bytes after recovery. Only a confirmed empty fence allows intent removal;
failure or missing provider fence support retains the intent without falling
back to DELETE. Empty fences contain no member payload, name or identity and
must be preserved during storage migration rather than swept as orphan files.
An unsuccessful cleanup retains its intent for a later cycle. An unconfirmed
session unlock discards the connection. There is no second pool checkout during
a write, automatic upload retry, bucket scan or source-authorization bypass.
The protocol uses Azure's [conditional-create guarantee](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations)
and [whole-object replacement](https://learn.microsoft.com/en-us/rest/api/storageservices/put-blob).

## Cutover and recovery

Before changing the existing app revision, preserve its database and private
objects, verify a restore and compare record/object manifests without publishing
private records. Provision durable destinations and validate network access,
verified database TLS and managed-identity object access before directing traffic
to a new revision. Keep the current domain/certificate and a data-preserving
rollback path. Never replace current data with a fresh rehearsal database.
The old preview-only image is not automatically compatible with these durable
backends. Protect post-cutover work before rollback; do not direct traffic back
to an older ephemeral database.

Restart a configured hosted runtime with the same durable database/container
and attached identity. Refresh an open form after a restart: CSRF form tokens are
process-specific. Existing member credentials and saved work remain in the
database; restarting must not recreate member identities, grants or activity.
Database migrations still run before the listener opens. Do not run several
revision migrations concurrently or silently fall back to a sidecar database.

## Acceptance evidence

| Scenario | Executable source evidence | Required live release evidence |
| --- | --- | --- |
| HOSTED-01 | `hosted-runtime-config.test.ts`, `runtime.test.ts`: explicit configuration, TLS requirements, refusals and retained public origin. | Real Azure database certificate validation and protected configuration. |
| HOSTED-02 | `app.test.ts`: exact HTTPS Host/Origin/CSRF, secure member cookies and deletion, spoof denial. | Normal member/staff browser forms over the public domain. |
| HOSTED-03 | `azure-object-storage.test.ts`: official SDK identity selection, bounded reads, immutable writes, errors and no fallback. | Actual attached Azure identity and private container, including denial checks. |
| HOSTED-04 | Native PostgreSQL plus owned Azurite protocol fixture: private evidence remains accessible only to its owner after storage-process and database-client restart. | Preserved existing data through migration and Azure revision restart. |
| HOSTED-05 | Existing complete prescribed verification gates remain required. | Current verified build, member/staff journeys, environment descriptions, persistence, rollback/restart instructions and captures at the existing domain. |
| HOSTED-06 | Native lost upload/derivative acknowledgement, owner deletion, active writer, key collision, disconnected writer and failed-cleanup continuation; unit journal/transaction/cursor/error boundaries. | Recovery remains operational with the real Azure identity and durable database through revision changes. |
| HOSTED-07 | `hosted-provided-samples.test.ts`: ordinary native HTTP onboarding, explicit copy/replay/reload and exact owned bytes for all three audiences; no raw upload or automatic review/grant. | The same deliberate member journey through public HTTPS and private durable storage. |
| HOSTED-08 | Hosted eligibility denial table, native missing acknowledgements/tampering/Host/Origin/CSRF and other-member denial; existing loopback cases stay required. | Configured public origin, exact cookies and authorized member/staff boundaries on Azure. |

The native protocol fixture uses Azurite 3.37.0 with service-version validation
enabled and the pinned Blob SDK 12.33.0. Its temporary account/container/process
and generated test database are isolated and removed afterward. It does not
prove Azure managed identity, cloud durability, migration or hosted acceptance.
