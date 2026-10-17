# Azure synthetic demo preview

On 17 October 2026 the owner authorized deploying the app to Azure as a **synthetic demo preview** through the shared landing zone ([tomqwu/cloud_landing_zone_for_ai_coding](https://github.com/tomqwu/cloud_landing_zone_for_ai_coding)). This covers only the preview described here. It does not authorize live mode, real member data, payments, provider connections, extra Azure services or another environment. Those still need separate owner authorization.

Public URL: https://ca-deepnative-dev.ambitiouscoast-ac447ad9.canadacentral.azurecontainerapps.io

## What runs

| Layer | Where | Notes |
| --- | --- | --- |
| Resource group, identity, Key Vault, GitHub OIDC | `infra/main.tf` via the landing zone `app-onboard` module | `rg-deepnative-dev-canadacentral`, UAMI `uami-deepnative-dev` |
| Container Apps environment and app | `infra/app.tf` | `cae-deepnative-dev`, `ca-deepnative-dev`, one replica (min = max = 1) |
| App image | `Dockerfile` | `tsc` build, `DNE_APP_MODE=demo`, impersonation off |
| Public front | `infra/proxy/` | nginx sends the loopback Host and maps only the public HTTPS Origin to the loopback Origin |
| Database | `postgres` container in the same replica | Loopback only, `dne_demo`, **ephemeral**: it resets on every restart or deploy |

The app's own safety checks (loopback database, loopback Host/Origin, no `live` mode) stay in force. Do not weaken them to make hosting easier. Change the hosting layer instead, or ask the owner for a separately authorized configuration.

Cost is about $20–30/month for one warm 1 vCPU / 2 GiB replica. Before any `terraform apply`, state the expected monthly cost change, as the landing zone requires.

## Continuous deployment

[`deploy-azure.yml`](../../../.github/workflows/deploy-azure.yml) runs after **Repository checks** succeeds on `main`, or by manual dispatch on `main`. It:

1. Uses the same verified-current-main selection as the product site. It skips the run when a newer `main` exists.
2. Signs in with GitHub OIDC as the app UAMI. The repository variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` hold public identifiers, not secrets.
3. Builds the app and proxy images tagged with the verified SHA and pushes them to the platform ACR (`AcrPush`).
4. Patches both images into the Container App in one update, producing one revision.
5. Waits until that revision is ready, both images carry the SHA, and the public page returns 200.

Only `main` has a federated credential, so deploys from other branches cannot sign in. The demo data resets on each deploy.

## Infrastructure changes

The workflow changes images only. Terraform owns everything else and ignores the two image fields. For infrastructure changes:

1. Edit `infra/`, then run `terraform fmt -check -recursive` and `terraform validate` locally. CI checks only formatting, because the landing zone module repository is private.
2. With an owner-authorized `az login`, run `terraform plan` from `infra/`. Confirm there are no unexpected replacements or destroys, and state the cost change.
3. Apply, then open a PR with the plan summary and evidence. New files under `infra/` must also be added to the reviewed `INFRA_FILES` allowlist in `scripts/repo.py`.

Rollback: re-run the workflow from an earlier verified `main` SHA, or `terraform destroy` in `infra/` to remove the preview entirely.

## Checking a deployment

- Open the URL and confirm the landing page renders.
- Write-path check without saving data: with a session cookie and its CSRF token, an empty `POST /start` from the public Origin returns 422 (validation), and the same request from a foreign Origin returns 403.
- Logs: `az containerapp logs show -n ca-deepnative-dev -g rg-deepnative-dev-canadacentral --container app`.
- Use only invented data. Never enter real member, payment or credential data.
