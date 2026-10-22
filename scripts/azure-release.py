"""Prepare a bounded app-template patch; never execute Azure or disclose secrets.

The first cutover consumes an operator's fresh, independently recorded restore
receipt. Subsequent releases keep the same durable database, private objects,
permissions and existing ingress/certificate. No ephemeral rollout fallback.
"""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.request import urlopen

SUBSCRIPTION = "81e891a1-b374-4898-8fed-0871de418dae"
GROUP = "rg-deepnative-dev-canadacentral"
APP = "ca-deepnative-dev"
HOST = "engine.deepnative.io"
LEGACY = "ca-deepnative-dev.ambitiouscoast-ac447ad9.canadacentral.azurecontainerapps.io"
REGISTRY = "acralzyhpx31oc.azurecr.io"
IDENTITY = "be45b9bd-d4b8-4a5c-bc6a-4feb40f9ea3c"
IDENTITY_ID = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-deepnative-dev"
DATABASE_HOST = "pg-deepnative-dev-144x.postgres.database.azure.com"
DATABASE = "deepnative"
BLOB = "https://stdeepnativedev144x.blob.core.windows.net"
CONFIG = {
    "DNE_DATABASE_URL": f"postgresql://dne_engine@{DATABASE_HOST}/{DATABASE}?sslmode=verify-full",
    "DNE_DATABASE_AUTH": "managed-identity",
    "DNE_PUBLIC_ORIGIN": f"https://{HOST}",
    "DNE_AZURE_BLOB_ACCOUNT_URL": BLOB,
    "DNE_AZURE_BLOB_CONTAINER": "private-evidence",
    "DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID": IDENTITY,
    "DNE_APP_MODE": "demo",
    "DNE_DEMO_IMPERSONATION": "false",
    "DNE_LOCAL_STAFF_ENTRY": "enabled",
    "DNE_PREPARED_REVIEW_SAMPLES": "enabled",
    "DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION": "enabled",
    "DNE_REVIEW_TIME_WRITES": "enabled",
    "DNE_REVIEW_TIME_GRANT_ADMINISTRATION": "enabled",
    "DNE_CIRCLE_DISCUSSION": "enabled",
    "DNE_LOCAL_CIRCLE_ADMIN": "enabled",
    "DNE_EVENT_REGISTRATION": "enabled",
    "DNE_LOCAL_EVENT_ADMIN": "enabled",
    "DNE_LOCAL_EVENT_SCHEDULING": "enabled",
    "DNE_WORKFLOW_REVIEW_REQUESTS": "enabled",
    "DNE_LOCAL_SUPPORT_ASSIGNMENT": "enabled",
}


def require(condition):
    if not condition:
        raise ValueError("Guarded Azure deployment prerequisites are not satisfied.")


def digest(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def receipt_digest(receipt, revision, now):
    require(isinstance(receipt, dict))
    require(receipt.get("version") == 1 and type(receipt["version"]) is int)
    require(receipt.get("sourceRevision") == revision)
    require(receipt.get("databaseHost") == DATABASE_HOST and receipt.get("databaseName") == DATABASE)
    require(receipt.get("managedIdentityClientId") == IDENTITY)
    for key in ("snapshotSha256", "sourceManifestSha256", "restoredManifestSha256", "sourceReplicaFingerprint"):
        require(digest(receipt.get(key)))
    require(receipt["sourceManifestSha256"] == receipt["restoredManifestSha256"])
    for key in ("sourceObjectCount", "targetObjectCount", "missingPhysicalReferences"):
        require(type(receipt.get(key)) is int and receipt[key] >= 0)
    require(receipt["sourceObjectCount"] == receipt["targetObjectCount"] and receipt["missingPhysicalReferences"] == 0)
    require(receipt.get("tokenHashesPreserved") is True and receipt.get("sourceFreezeConfirmed") is True and receipt.get("destinationAccessVerified") is True)
    instants = [datetime.datetime.fromisoformat(receipt[key].replace("Z", "+00:00")) for key in ("frozenAt", "restoredAt")]
    require(all(t.tzinfo is not None and datetime.timedelta(0) <= now - t <= datetime.timedelta(minutes=30) for t in instants))
    require(instants[0] <= instants[1])
    return hashlib.sha256(json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def replica_fingerprint(value):
    replicas = value.get("value")
    require(isinstance(replicas, list) and len(replicas) == 1)
    replica = replicas[0]
    require(replica.get("name", "").startswith(APP+"--0000001-"))
    containers = replica["properties"]["containers"]
    require(len(containers) == 3 and {v["name"] for v in containers} == {"app", "postgres", "proxy"})
    selected = []
    for v in containers:
        require(isinstance(v.get("containerId"), str) and v["containerId"] != "")
        require(type(v.get("restartCount")) is int and v["restartCount"] >= 0)
        selected.append({key: v[key] for key in ("name", "containerId", "restartCount")})
    source = {"replica": replica["name"], "containers": sorted(selected, key=lambda v: v["name"])}
    return hashlib.sha256(json.dumps(source, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def maintenance(opener=urlopen):
    for host in (HOST, LEGACY):
        try:
            response = opener(f"https://{host}/", timeout=10)
        except HTTPError as error:
            response = error
        with response:
            require(response.status == 503 and response.read(128) == b"Deployment maintenance. Existing work is preserved.\n")


def env_values(container):
    values = container.get("env", [])
    require(isinstance(values, list) and all(isinstance(v, dict) and isinstance(v.get("name"), str) for v in values))
    require(len({v["name"] for v in values}) == len(values))
    return {v["name"]: v.get("value") for v in values}


def prepare(app, revision, receipt=None, now=None):
    require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision))
    require(app.get("id", "").lower() == f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/Microsoft.App/containerApps/{APP}".lower())
    identities = app.get("identity", {}).get("userAssignedIdentities", {})
    require(IDENTITY_ID.lower() in {key.lower() for key in identities})
    properties = app["properties"]
    ingress = properties["configuration"]["ingress"]
    require(ingress.get("external") is True and ingress.get("allowInsecure") is False and ingress.get("targetPort") == 8080)
    domains = ingress.get("customDomains", [])
    require(any(v.get("name") == HOST and v.get("bindingType") == "SniEnabled" and v.get("certificateId", "").endswith("/managedCertificates/mc-engine-deepnative-io") for v in domains))
    containers = properties["template"]["containers"]
    require(isinstance(containers, list) and len({c["name"] for c in containers}) == len(containers))
    by_name = {c["name"]: c for c in containers}
    if set(by_name) == {"app", "postgres", "proxy"}:
        require(properties["latestRevisionName"] == f"{APP}--0000001")
        require(properties.get("latestReadyRevisionName") == properties["latestRevisionName"])
        require(by_name["app"]["image"] == f"{REGISTRY}/deepnative/app:0b0ee74-202610171227")
        require(by_name["proxy"]["image"] == f"{REGISTRY}/deepnative/proxy:0b0ee74-202610171227")
        require(env_values(by_name["proxy"]).get("PUBLIC_HOST") == LEGACY)
        preservation = receipt_digest(receipt, properties["latestRevisionName"], now or datetime.datetime.now(datetime.timezone.utc))
        template = {
            "scale": {"minReplicas": 1, "maxReplicas": 1},
            "containers": [
                {"name": "app", "image": f"{REGISTRY}/deepnative/app:{revision}", "resources": {"cpu": 0.5, "memory": "1Gi"}, "env": [{"name": key, "value": value} for key, value in {**CONFIG, "DNE_PRESERVATION_RECEIPT_SHA256": preservation, "DNE_RELEASE_REVISION": revision}.items()]},
                {"name": "proxy", "image": f"{REGISTRY}/deepnative/proxy:{revision}", "resources": {"cpu": 0.25, "memory": "0.5Gi"}, "env": [{"name": "PUBLIC_HOST", "value": HOST}, {"name": "LEGACY_HOST", "value": LEGACY}], "probes": [
                    {"type": "Readiness", "httpGet": {"path": "/", "port": 8080, "httpHeaders": [{"name": "Host", "value": HOST}]}, "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 3},
                    {"type": "Startup", "httpGet": {"path": "/", "port": 8080, "httpHeaders": [{"name": "Host", "value": HOST}]}, "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 60},
                    {"type": "Liveness", "tcpSocket": {"port": 8080}, "periodSeconds": 10, "timeoutSeconds": 3, "failureThreshold": 3},
                ]},
            ],
        }
    else:
        require(set(by_name) == {"app", "proxy"} and receipt is None)
        values = env_values(by_name["app"])
        require(all(values.get(key) == value for key, value in CONFIG.items()))
        require(digest(values.get("DNE_PRESERVATION_RECEIPT_SHA256")))
        proxy = env_values(by_name["proxy"])
        require(proxy.get("PUBLIC_HOST") == HOST and proxy.get("LEGACY_HOST") == LEGACY)
        require(all(c["image"].startswith(f"{REGISTRY}/deepnative/{c['name']}:") for c in containers))
        template = copy.deepcopy(properties["template"])
        for container in template["containers"]:
            container["image"] = f"{REGISTRY}/deepnative/{container['name']}:{revision}"
            if container["name"] == "app":
                container["env"] = [v for v in container["env"] if v["name"] != "DNE_RELEASE_REVISION"] + [{"name": "DNE_RELEASE_REVISION", "value": revision}]
    template["revisionSuffix"] = f"rel-{revision[:12]}"
    return {"properties": {"template": template}}


def unchanged(before, current):
    require(before.get("id") == current.get("id"))
    for key in ("latestRevisionName", "latestReadyRevisionName", "configuration", "template"):
        require(before["properties"].get(key) == current["properties"].get(key))
    require(before.get("identity") == current.get("identity"))


if __name__ == "__main__":
    try:
        action, *args = sys.argv[1:]
        if action == "unchanged" and len(args) == 2:
            unchanged(*(json.loads(Path(p).read_text()) for p in args))
        elif action == "maintenance" and not args:
            maintenance()
        elif action == "replicas" and len(args) == 1:
            receipt = json.loads(os.environ.get("DNE_CUTOVER_RECEIPT", ""))
            require(replica_fingerprint(json.loads(Path(args[0]).read_text())) == receipt["sourceReplicaFingerprint"])
        elif action == "prepare" and len(args) == 3:
            source, revision, destination = args
            raw = os.environ.get("DNE_CUTOVER_RECEIPT", "")
            require(len(raw.encode()) <= 8192)
            patch = prepare(json.loads(Path(source).read_text()), revision, json.loads(raw) if raw else None)
            descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump(patch, output)
        else:
            require(False)
    except Exception:
        # Neither API responses, private configuration nor exception payloads
        # belong in CI output. The operator retains actual failure evidence.
        print("Guarded Azure deployment refused; inspect preservation, target configuration and current revision.", file=sys.stderr)
        sys.exit(1)
