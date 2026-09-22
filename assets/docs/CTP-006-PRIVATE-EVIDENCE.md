# CTP-006: private evidence, consent and quarantine

Issue [#25](https://github.com/deepnative/deep-native-engine/issues/25) adds a local synthetic evidence boundary. PostgreSQL stores ownership, consent, hashes, quarantine state and workflow metadata. An object-storage adapter stores bytes under random keys outside the public asset tree with owner-only filesystem permissions. Raw evidence is never stored in repository files, PostgreSQL fields, routine logs or error responses.

## Consent and destination boundaries

Every accepted upload requires an explicit rights attestation and at least one destination scope. The scopes are independent:

| Scope | Meaning | Access created by this slice |
| --- | --- | --- |
| Private review | The member permits assigned coach/reviewer access after a clean scan | Owner plus a current matching assignment |
| Community publication | The member permits a later publication workflow to consider the item | No public access or automatic publication |
| Learning circle | The member permits one named circle to access the item | Current readable membership in that exact circle |

Selecting one scope never implies another. An editor, moderator, support operator, unassigned reviewer or unrelated member cannot download private evidence. Publication and contribution moderation remain separate roadmap work.

## Upload and quarantine contract

The local API accepts at most 1 MiB and only `text/plain`, `image/png` or `application/pdf`. It validates safe filenames, declared type and a minimal file signature before allocating an object key. HTML, executable types, empty input, oversized input, path-like names, binary text and mismatched signatures are rejected. Downloads always use attachment disposition and are never executed or served from `/assets`.

New objects begin in `pending`. Only the trusted scanner boundary can transition a pending object to `clean`, `rejected` or `infected`; this slice simulates that boundary in tests and does not claim live malware scanning. Only clean evidence can enter review, satisfy a destination permission or receive a download capability. A failed metadata insert removes the just-written object.

Uploads and derivative creation use explicit PostgreSQL transactions. An upload locks its workspace before writing bytes; derivative creation locks the clean source row. A database error before commit rolls back metadata before bytes are removed, and a connection with an unconfirmed rollback is destroyed instead of returning to the pool. If a commit acknowledgement is lost, the generated ID and object key are reconciled on a fresh connection: a visible commit returns success, while an absent row or unavailable reconciliation preserves the private object for recovery because the original backend could still be completing its commit. The implementation favors a recoverable private orphan over live metadata that points to deleted content.

## Download and revocation contract

A download link is an HMAC-bound capability with a five-minute expiry, an unpredictable nonce and the evidence ID in its signature. The capability is necessary but insufficient: every download resolves the current credential and rechecks principal expiry/revocation, quarantine state, ownership, assignment or exact-circle membership. Revoking an assignment or membership therefore blocks an already-issued, unexpired link. Generic denials do not disclose whether an object exists.

## Deletion and operations

Deleting one evidence item first commits a `deleting` state, which serializes against the source-row lock used by derivative creation. It then removes the source and every registered derived object before deleting metadata so review state cascades. Deleting the local preview locks and marks the workspace as deleting before it marks every evidence row; concurrent uploads either complete before the snapshot and are removed or observe the durable workspace state and are denied. A failed object removal leaves metadata in `deleting`, which denies reads and permits a later cleanup retry. Direct database deletion bypasses the filesystem hook and is not an approved operational procedure.

`DNE_PRIVATE_STORAGE_ROOT` selects the local private directory and cannot canonically resolve inside the module-relative directory actually served as `public/`; validation resolves existing symlink ancestors and is independent of the process working directory. Verification creates a disposable directory outside the checkout and removes it after the isolated test database. The development default is ignored `.dne-private/evidence`. Before real evidence or hosting, approve managed private object storage, malware service behavior, encryption/key ownership, retention and legal hold, backups/restores, data residency, scanner failure queues, operator roles and deletion reconciliation. No production storage, scanner, identity, deployment or real member data is authorized here.

## Acceptance evidence

Unit contracts cover validation, signatures, private filesystem permissions, canonical path aliases, transaction and commit-acknowledgement failures, consent separation, capability integrity/expiry and every fail-closed API branch. PostgreSQL integration covers quarantine/review transitions, exact destinations, reviewer and circle revocation, short-lived links, rejected objects, metadata minimization, real post-insert and post-commit acknowledgement failures, and source/derived deletion. Controlled concurrency tests inspect `pg_blocking_pids` to prove that uploads/derivatives contend with deletion, then assert both metadata and private storage are empty. Browser journeys `L18`–`L20` repeat upload, rejection, quarantine, review, independent-member denial, assignment revocation, circle revocation and deletion through the compiled application on desktop and mobile Chromium.
