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
| `DNE_DATABASE_URL` | PostgreSQL connection URL with a dedicated application database, user and password, and exactly `sslmode=verify-full`. Store the value as a secret. |
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
forward the configured public `Host` and the caller's unchanged `Origin` to the
application. Do not use the older proxy's loopback Host/Origin translation for
this contract. The application accepts only the exact configured Host and write
Origin and still requires its normal CSRF token. Forwarded headers cannot grant
access. HTTPS member cookies, including deletion cookies, use Secure, HttpOnly
and SameSite=Strict; TLS termination must remain enabled at Azure ingress.

PostgreSQL stores member identities, work and permissions. Evidence bytes use
the selected Azure container through managed identity. Writes require a new UUID
key and cannot overwrite an existing object. Reads are bounded by the existing
evidence size limit; failures return no partial bytes. Removal is idempotent.
Object operations have bounded deadlines, no SDK retries, and no local-file or
public-link fallback. Existing ownership, quarantine, exact grants, revocation,
deletion recovery and digest checks continue to govern access. Prepared source
bindings retain their existing immutable-source implementation.

## Cutover and recovery

Before changing the existing app revision, preserve its database and private
objects, verify a restore and compare record/object manifests without publishing
private records. Provision durable destinations and validate network access,
verified database TLS and managed-identity object access before directing traffic
to a new revision. Keep the current domain/certificate and a data-preserving
rollback path. Never replace current data with a fresh rehearsal database.

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

The native protocol fixture uses Azurite 3.37.0 with service-version validation
enabled and the pinned Blob SDK 12.33.0. Its temporary account/container/process
and generated test database are isolated and removed afterward. It does not
prove Azure managed identity, cloud durability, migration or hosted acceptance.
