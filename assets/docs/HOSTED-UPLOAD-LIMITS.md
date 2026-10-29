# Evidence upload limits

The evidence API accepts at most **1 MiB (1,048,576 bytes)** per request. The public nginx proxy now applies that same limit before forwarding evidence requests to the application. It covers the application's case-insensitive `/api/evidence` mount, trailing slash and nested paths. The existing application limit, ownership, consent, quarantine, Host/Origin and CSRF checks still apply. Other proxy paths retain their existing 16 MiB ceiling and their own application limits.

When the proxy refuses an oversized body it returns 413 with a fixed JSON explanation, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Choose a file of 1 MiB or less; the response does not invite an automatic retry of the same oversized file. Rejected bytes do not reach the upstream listener. Previously saved evidence is unchanged. An exact-limit request may reach the application, which still decides its authorization, file validity and consent; forwarding is not upload acceptance.

The proxy preserves both owned entry points' exact original Host/Origin pairing before canonical normalization, clears forwarded Host/Proto trust, preserves the ordinary browser cookie and keeps request logs disabled. The refusal contains no request body, query, cookie, member identity or filename. No member files are logged or retained by this control.

## Scope and remaining work

This is the early body-boundary subset of [#315](https://github.com/deepnative/deep-native-engine/issues/315), not completion of the issue. Distributed request-rate and concurrency admission, shared state across processes/restarts, limiter-outage behavior and minimal operator telemetry remain open. A single nginx shared-memory rate zone or Node process counter would not establish those guarantees. This change adds no counter, IP/client identifier, new service, provider, WAF or DDoS protection claim. Source and local fixture evidence do not prove a live deployment or full hosted abuse protection.

The existing Azure production parking and deployment controls are unchanged. Follow the [deployment guide](workflows/AZURE-DEMO-DEPLOYMENT.md) and current owner instructions before any authorized release. Do not enable a parked workflow or deploy this change as part of local validation.

## Behavioral evidence

The owned native nginx fixture has an upstream observer that accepts 16 MiB and logs only method plus normalized path, so its own default 1 MiB limit cannot masquerade as a refusal at the public proxy. Before the proxy change, BCAP-01 observed 200 and one upstream request for 1 MiB + 1, against expected 413 and zero upstream requests. An earlier status-only probe had passed because the observer inherited nginx's default limit; that result is preserved as a fixture-masking baseline, not the meaningful red.

BCAP-01..05 cover canonical and legacy entry points; exact-limit acceptance; declared and chunked oversized bodies; case, trailing-slash, encoded and nested evidence paths; no upstream access for refused bodies; fixed private refusal; ordinary recovery with the same cookie; foreign/crossed/missing write origins; and unchanged larger allowance on unrelated paths. Existing Host/Origin, maintenance/restoration and private-log cases remain required. The observer is an invented fixture, not a substitute for actual application authorization or private-object tests in the full gate.

A delivery is complete only after exact clean verification, the ordinary full pre-push hook, original PR and resulting-main CI, guarded merge, actual dedicated verified-main proxy demonstration, truthful partial issue reconciliation and safe owned cleanup. Source changes and passing components alone do not establish delivery, deployment, qualified review or full-MVP acceptance.
