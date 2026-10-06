import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CIRCLES } from "./circles.ts";
import { hash } from "./store.ts";

export const CIRCLE_DISCUSSION_POLICY = "circle-discussion-test-v1";
export const CIRCLE_PAGE_SIZE = 20;
export const REPORT_CATEGORIES = [
  "privacy",
  "conduct",
  "off_topic",
  "other",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export interface CircleItem {
  id: string;
  body: string | null;
  pseudonym: string;
  state: "visible" | "hidden" | "withdrawn";
  revision: number;
  createdAt: string;
  rootId?: string | null;
}
export type CircleResult<T> =
  | { kind: "ready"; value: T }
  | { kind: "denied" | "conflict" | "limit" | "invalid" };
export interface CirclePage {
  items: CircleItem[];
  nextCursor: string | null;
}
export interface OwnedCircleReport {
  id: string;
  category: ReportCategory;
  status: "reported" | "hidden" | "unavailable";
  createdAt: string;
}
export interface ModeratorReport {
  id: string;
  category: ReportCategory;
  target: CircleItem | null;
}
export interface CircleReconciliation {
  found: boolean;
  id: string | null;
  status: string | null;
  revision: number | null;
}
export interface CircleDiscussionStore {
  reconcile(
    token: string,
    circle: string,
    kind: string,
    key: string,
  ): Promise<CircleResult<CircleReconciliation>>;
  reports(
    token: string,
    circle: string,
    cursor?: string,
  ): Promise<
    CircleResult<{ items: OwnedCircleReport[]; nextCursor: string | null }>
  >;
  reportReceipt(
    token: string,
    circle: string,
    id: string,
  ): Promise<CircleResult<OwnedCircleReport>>;
  grantModerator(
    adminToken: string,
    staffId: string,
    circle: string,
    key: string,
    expiresAt: Date,
  ): Promise<CircleResult<{ id: string }>>;
  revokeModerator(
    adminToken: string,
    circle: string,
    grantId: string,
  ): Promise<CircleResult<{ id: string }>>;
  moderationQueue(
    token: string,
    circle: string,
    cursor?: string,
  ): Promise<
    CircleResult<{ items: ModeratorReport[]; nextCursor: string | null }>
  >;
  moderate(
    token: string,
    circle: string,
    id: string,
    key: string,
    action: string,
    revision: number,
    reason: string,
  ): Promise<CircleResult<{ id: string; revision: number }>>;
  choice(
    token: string,
    circle: string,
  ): Promise<CircleResult<{ generation: string; active: boolean }>>;
  choose(
    token: string,
    circle: string,
    key: string,
    generation: string,
    policy: string,
    confirmed: boolean,
  ): Promise<CircleResult<{ id: string }>>;
  list(
    token: string,
    circle: string,
    cursor?: string,
  ): Promise<CircleResult<CirclePage>>;
  thread(
    token: string,
    circle: string,
    id: string,
    cursor?: string,
  ): Promise<CircleResult<{ root: CircleItem; replies: CirclePage }>>;
  post(
    token: string,
    circle: string,
    key: string,
    body: string,
    confirmed: boolean,
    rootId?: string,
  ): Promise<CircleResult<{ id: string }>>;
  report(
    token: string,
    circle: string,
    id: string,
    key: string,
    category: string,
  ): Promise<CircleResult<{ id: string }>>;
  withdraw(
    token: string,
    circle: string,
    id: string,
    confirmed: boolean,
  ): Promise<CircleResult<{ id: string }>>;
  withdrawChoice(
    token: string,
    circle: string,
    confirmed: boolean,
  ): Promise<CircleResult<{ id: string }>>;
  owned(
    token: string,
    circle: string,
    cursor?: string,
  ): Promise<CircleResult<CirclePage>>;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern = /^[a-f0-9]{64}$/;
const denied = { kind: "denied" } as const,
  invalid = { kind: "invalid" } as const,
  conflict = { kind: "conflict" } as const;
const ready = <T>(value: T): CircleResult<T> => ({ kind: "ready", value });
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const knownCircle = (circle: string) => CIRCLES.some((c) => c.id === circle);
interface Metadata {
  id: string;
  member_id: string;
  choice_id: string;
  root_id: string | null;
  state: string;
  revision: number;
}
interface Context {
  actor: string;
  generation: string | null;
  choices: Map<string, { id: string; pseudonym: string }>;
  members: Set<string>;
  currentIds: string[];
  moderator?: { grantId: string; role: "moderator" | "platform_admin" };
}

export function disabledCircleDiscussionStore(): CircleDiscussionStore {
  return {
    reconcile: async () => denied,
    reports: async () => denied,
    reportReceipt: async () => denied,
    grantModerator: async () => denied,
    revokeModerator: async () => denied,
    moderationQueue: async () => denied,
    moderate: async () => denied,
    choice: async () => denied,
    choose: async () => denied,
    list: async () => denied,
    thread: async () => denied,
    post: async () => denied,
    report: async () => denied,
    withdraw: async () => denied,
    withdrawChoice: async () => denied,
    owned: async () => denied,
  };
}

/** Local invented-data boundary. Owner history/withdrawal remains available during write pause. */
export function circleDiscussionStore(
  pool: Pool,
  secret: string,
  writes = true,
): CircleDiscussionStore {
  async function acquire() {
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = pool.connect().then((client) => {
        if (expired) {
          client.release(new Error("Circle acquisition expired"));
          throw Error("Circle operation unavailable");
        }
        return client;
      });
      return await Promise.race([
        connection,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(Error("Circle operation unavailable"));
          }, 3000);
        }),
      ]);
    } catch {
      throw Error("Circle operation unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  async function transaction<T>(
    circle: string,
    write: boolean,
    use: (
      client: PoolClient,
      finish: (context: Context) => void,
    ) => Promise<CircleResult<T>>,
  ): Promise<CircleResult<T>> {
    const started = performance.now(),
      client = await acquire();
    let committed = false,
      commitAttempted = false,
      releaseError: Error | undefined,
      context: Context | undefined;
    const execute = async (): Promise<CircleResult<T>> => {
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='5s'");
        await client.query("SELECT set_config('transaction_timeout',$1,true)", [
          `${Math.max(1, Math.floor(10000 - (performance.now() - started)))}ms`,
        ]);
        if (write)
          await client.query(
            "SELECT pg_advisory_xact_lock(7529,hashtext($1::text))",
            [circle],
          );
        const result = await use(client, (value) => {
          context = value;
        });
        if (result.kind !== "ready") {
          await client.query("ROLLBACK");
          return result;
        }
        if (!context) throw Error("Circle current authorization unavailable");
        const checkedAt = performance.now();
        const current = await client.query<{
          n: number;
          grant_active: boolean;
          remaining_ms: string;
        }>(
          `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
        SELECT (SELECT count(*)::integer n FROM principals p,instant t
          WHERE p.id=ANY($1::uuid[]) AND p.revoked_at IS NULL AND p.expires_at>t.now) n,
        ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM preview_circle_moderator_grants g,instant t
          WHERE g.id=$2 AND g.revoked_at IS NULL AND g.starts_at<=t.now AND g.expires_at>t.now)) grant_active,
        EXTRACT(EPOCH FROM (LEAST((SELECT min(expires_at) FROM principals WHERE id=ANY($1::uuid[])),
          COALESCE((SELECT expires_at FROM preview_circle_moderator_grants WHERE id=$2),'infinity'::timestamptz))
          -(SELECT now FROM instant)))*1000 remaining_ms`,
          [context.currentIds, context.moderator?.grantId ?? null],
        );
        const remaining = Number(current.rows[0]?.remaining_ms);
        // Check every principal and the grant against one DB clock instant. Charge
        // the entire final query/handback duration against its remaining lifetime,
        // so a delayed response cannot carry stale authorization into COMMIT.
        if (
          current.rows[0]?.n !== context.currentIds.length ||
          !current.rows[0]?.grant_active ||
          !Number.isFinite(remaining) ||
          remaining <= performance.now() - checkedAt ||
          performance.now() - started >= 10000
        ) {
          await client.query("ROLLBACK");
          return denied;
        }
        commitAttempted = true;
        await client.query("COMMIT");
        committed = true;
        return result;
      } catch {
        releaseError = new Error("Circle transaction unavailable");
        if (!committed) {
          try {
            await client.query("ROLLBACK");
          } catch {
            /* discard unknown connection */
          }
        }
        // Do not retry or acknowledge any uncertain COMMIT/connection outcome.
        throw Error(
          commitAttempted
            ? "Circle outcome unconfirmed"
            : "Circle operation unavailable",
        );
      }
    };
    let outcome: CircleResult<T> | undefined;
    let failure: unknown;
    try {
      outcome = await execute();
    } catch (error) {
      failure = error;
    } finally {
      try {
        client.release(releaseError);
      } catch {
        // Record the uncertainty here; throw only after cleanup has finished.
        failure = Error("Circle outcome unconfirmed");
      }
    }
    if (failure) throw failure;
    return outcome!;
  }
  async function authorize(
    client: PoolClient,
    token: string,
    circle: string,
    metadata: Metadata[],
    requireChoice: boolean,
    privateOnly = false,
  ): Promise<Context | null> {
    const identity = (
      await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE token_hash=$1 AND kind='member'",
        [hash(token)],
      )
    ).rows[0];
    if (!identity) return null;
    const ids = [
      ...new Set([identity.id, ...metadata.map((item) => item.member_id)]),
    ].sort();
    const principals = await client.query<{ id: string }>(
      "SELECT id FROM principals WHERE id=ANY($1::uuid[]) AND kind='member' AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY id FOR SHARE",
      [ids],
    );
    if (!principals.rows.some((p) => p.id === identity.id)) return null;
    const currentIds = principals.rows.map((p) => p.id);
    const workspaces = await client.query<{ owner_principal_id: string }>(
      "SELECT owner_principal_id FROM workspaces WHERE owner_principal_id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY owner_principal_id FOR SHARE",
      [currentIds],
    );
    const members = new Set(workspaces.rows.map((w) => w.owner_principal_id));
    if (!members.has(identity.id)) return null;
    if (privateOnly)
      return {
        actor: identity.id,
        generation: null,
        choices: new Map(),
        members,
        currentIds,
      };
    const memberships = await client.query<{
      member_id: string;
      generation: string;
    }>(
      "SELECT member_id,generation::text FROM preview_circle_memberships WHERE member_id=ANY($1::uuid[]) AND circle_id=$2 AND left_at IS NULL ORDER BY member_id FOR SHARE",
      [[...members], circle],
    );
    const generation = memberships.rows.find(
      (m) => m.member_id === identity.id,
    )?.generation;
    if (!generation) return null;
    const choices = await client.query<{
      id: string;
      member_id: string;
      pseudonym: string;
    }>(
      `SELECT c.id,c.member_id,c.pseudonym FROM preview_circle_choices c
   JOIN preview_circle_memberships m ON m.member_id=c.member_id AND m.circle_id=c.circle_id AND m.generation=c.generation
   WHERE c.member_id=ANY($1::uuid[]) AND c.circle_id=$2 AND c.policy_version=$3 AND c.revoked_at IS NULL AND m.left_at IS NULL
   ORDER BY c.member_id,c.id FOR SHARE OF c`,
      [[...members], circle, CIRCLE_DISCUSSION_POLICY],
    );
    const byMember = new Map(
      choices.rows.map((c) => [
        c.member_id,
        { id: c.id, pseudonym: c.pseudonym },
      ]),
    );
    if (requireChoice && !byMember.has(identity.id)) return null;
    return {
      actor: identity.id,
      generation,
      choices: byMember,
      members,
      currentIds,
    };
  }
  const eligible = (context: Context, item: Metadata) =>
    context.members.has(item.member_id) &&
    context.choices.get(item.member_id)?.id === item.choice_id;
  async function target(client: PoolClient, circle: string, id: string) {
    const item = (
      await client.query<Metadata>(
        "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE id=$1 AND circle_id=$2",
        [id, circle],
      )
    ).rows[0];
    if (!item) return [];
    if (!item.root_id) return [item];
    const root = (
      await client.query<Metadata>(
        "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE id=$1 AND circle_id=$2 AND root_id IS NULL",
        [item.root_id, circle],
      )
    ).rows[0];
    return root ? [item, root] : [];
  }
  async function adminContext(
    client: PoolClient,
    token: string,
    staffId: string,
    requireCurrentStaff: boolean,
  ): Promise<Context | null> {
    const actor = (
      await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE token_hash=$1 AND kind='staff'",
        [hash(token)],
      )
    ).rows[0];
    if (!actor) return null;
    const ids = [...new Set([actor.id, staffId])].sort();
    const principals = (
      await client.query<{ id: string; active: boolean }>(
        "SELECT id,(revoked_at IS NULL AND expires_at>clock_timestamp()) active FROM principals WHERE id=ANY($1::uuid[]) AND kind='staff' ORDER BY id FOR SHARE",
        [ids],
      )
    ).rows;
    if (
      !principals.find((p) => p.id === actor.id)?.active ||
      !principals.some((p) => p.id === staffId) ||
      (requireCurrentStaff && !principals.find((p) => p.id === staffId)?.active)
    )
      return null;
    const profiles = (
      await client.query<{ principal_id: string; role: string }>(
        "SELECT principal_id,role FROM staff_profiles WHERE principal_id=ANY($1::uuid[]) ORDER BY principal_id FOR SHARE",
        [ids],
      )
    ).rows;
    if (
      profiles.find((p) => p.principal_id === actor.id)?.role !==
        "platform_admin" ||
      (requireCurrentStaff &&
        !["moderator", "platform_admin"].includes(
          profiles.find((p) => p.principal_id === staffId)?.role ?? "",
        ))
    )
      return null;
    return {
      actor: actor.id,
      generation: null,
      choices: new Map(),
      members: new Set(),
      currentIds: requireCurrentStaff ? ids : [actor.id],
    };
  }
  async function moderatorObservation(
    client: PoolClient,
    token: string,
    circle: string,
  ): Promise<Context | null> {
    const row = (
      await client.query<{
        id: string;
        grant_id: string;
        role: "moderator" | "platform_admin";
      }>(
        `SELECT p.id,g.id grant_id,s.role FROM principals p
      JOIN staff_profiles s ON s.principal_id=p.id JOIN preview_circle_moderator_grants g ON g.staff_id=p.id AND g.staff_role=s.role
      WHERE p.token_hash=$1 AND p.kind='staff' AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
      AND s.role IN ('moderator','platform_admin') AND g.circle_id=$2 AND g.purpose=$3 AND g.revoked_at IS NULL
      AND g.starts_at<=clock_timestamp() AND g.expires_at>clock_timestamp() ORDER BY g.id LIMIT 1`,
        [hash(token), circle, CIRCLE_DISCUSSION_POLICY],
      )
    ).rows[0];
    if (!row) return null;
    return {
      actor: row.id,
      generation: null,
      choices: new Map([[row.id, { id: row.grant_id, pseudonym: "" }]]),
      members: new Set(),
      currentIds: [],
      moderator: { grantId: row.grant_id, role: row.role },
    };
  }
  async function moderatorContext(
    client: PoolClient,
    token: string,
    circle: string,
    metadata: Metadata[],
    reporters: string[] = [],
  ): Promise<Context | null> {
    const observation = await moderatorObservation(client, token, circle);
    if (!observation) return null;
    const ids = [
      ...new Set([
        observation.actor,
        ...metadata.map((m) => m.member_id),
        ...reporters,
      ]),
    ].sort();
    const principals = (
      await client.query<{ id: string; kind: string }>(
        "SELECT id,kind FROM principals WHERE id=ANY($1::uuid[]) AND revoked_at IS NULL AND expires_at>clock_timestamp() AND (id<>$2::uuid OR token_hash=$3) ORDER BY id FOR SHARE",
        [ids, observation.actor, hash(token)],
      )
    ).rows;
    if (
      !principals.some((p) => p.id === observation.actor && p.kind === "staff")
    )
      return null;
    const memberIds = principals
      .filter((p) => p.kind === "member")
      .map((p) => p.id);
    const workspaces = (
      await client.query<{ owner_principal_id: string }>(
        "SELECT owner_principal_id FROM workspaces WHERE owner_principal_id=ANY($1::uuid[]) AND deleting_at IS NULL ORDER BY owner_principal_id FOR SHARE",
        [memberIds],
      )
    ).rows;
    const members = new Set(workspaces.map((w) => w.owner_principal_id));
    const profile = (
      await client.query<{ role: "moderator" | "platform_admin" }>(
        "SELECT role FROM staff_profiles WHERE principal_id=$1 AND role IN ('moderator','platform_admin') FOR SHARE",
        [observation.actor],
      )
    ).rows[0];
    if (!profile) return null;
    const grant = (
      await client.query<{ id: string }>(
        "SELECT id FROM preview_circle_moderator_grants WHERE id=$1 AND staff_id=$2 AND staff_role=$3 AND circle_id=$4 AND purpose=$5 AND revoked_at IS NULL AND starts_at<=clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE",
        [
          observation.moderator!.grantId,
          observation.actor,
          profile.role,
          circle,
          CIRCLE_DISCUSSION_POLICY,
        ],
      )
    ).rows[0];
    if (!grant) return null;
    await client.query(
      "SELECT member_id FROM preview_circle_memberships WHERE member_id=ANY($1::uuid[]) AND circle_id=$2 AND left_at IS NULL ORDER BY member_id FOR SHARE",
      [[...members], circle],
    );
    const choices = (
      await client.query<{ id: string; member_id: string; pseudonym: string }>(
        `SELECT c.id,c.member_id,c.pseudonym FROM preview_circle_choices c JOIN preview_circle_memberships m
      ON m.member_id=c.member_id AND m.circle_id=c.circle_id AND m.generation=c.generation
      WHERE c.member_id=ANY($1::uuid[]) AND c.circle_id=$2 AND c.policy_version=$3 AND c.revoked_at IS NULL AND m.left_at IS NULL
      ORDER BY c.member_id,c.id FOR SHARE OF c`,
        [[...members], circle, CIRCLE_DISCUSSION_POLICY],
      )
    ).rows;
    return {
      actor: observation.actor,
      generation: null,
      choices: new Map([
        ...choices.map(
          (c) => [c.member_id, { id: c.id, pseudonym: c.pseudonym }] as const,
        ),
        [observation.actor, { id: grant.id, pseudonym: "" }],
      ]),
      members,
      currentIds: principals.map((p) => p.id),
      moderator: { grantId: grant.id, role: profile.role },
    };
  }
  async function targetMetadata(
    client: PoolClient,
    circle: string,
    ids: string[],
  ) {
    return (
      await client.query<Metadata>(
        `SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE circle_id=$1 AND
      (id=ANY($2::uuid[]) OR id IN (SELECT root_id FROM preview_circle_posts WHERE circle_id=$1 AND id=ANY($2::uuid[]))) ORDER BY id`,
        [circle, ids],
      )
    ).rows;
  }
  async function lockReadTargets(
    client: PoolClient,
    context: Context,
    circle: string,
    metadata: Metadata[],
  ) {
    // A read may touch a root and multiple replies. Acquire the complete eligible
    // set in the same ID order as a moderator's target/root update before any
    // individual body read; locking the root first can cycle with a reply update.
    const ids = metadata
      .filter((item) => eligible(context, item))
      .map((item) => item.id);
    if (ids.length)
      await client.query(
        "SELECT id FROM preview_circle_posts WHERE circle_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE",
        [circle, ids],
      );
  }
  async function moderatorItem(
    client: PoolClient,
    context: Context,
    circle: string,
    id: string,
    metadata: Metadata[],
    update = false,
  ): Promise<CircleItem | null> {
    const selected = metadata.find((m) => m.id === id);
    if (!selected || !eligible(context, selected)) return null;
    const root = selected.root_id
      ? metadata.find((m) => m.id === selected.root_id && !m.root_id)
      : undefined;
    if (selected.root_id && (!root || !eligible(context, root))) return null;
    const rows = (
      await client.query<{
        id: string;
        body: string | null;
        state: CircleItem["state"];
        revision: number;
        createdAt: string;
      }>(
        `SELECT id,body,state,revision,created_at::text AS "createdAt" FROM preview_circle_posts WHERE circle_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${update ? "UPDATE" : "SHARE"}`,
        [circle, root ? [id, root.id] : [id]],
      )
    ).rows;
    const current = rows.find((r) => r.id === id);
    if (
      !current ||
      current.state === "withdrawn" ||
      (root && rows.find((r) => r.id === root.id)?.state !== "visible")
    )
      return null;
    return {
      ...current,
      pseudonym: context.choices.get(selected.member_id)!.pseudonym,
    };
  }
  async function observe(
    client: PoolClient,
    token: string,
    circle: string,
    privateOnly = false,
  ): Promise<Context | null> {
    const actor = (
      await client.query<{ id: string }>(
        "SELECT id FROM principals WHERE token_hash=$1 AND kind='member'",
        [hash(token)],
      )
    ).rows[0];
    if (!actor) return null;
    const choice = privateOnly
      ? undefined
      : (
          await client.query<{ id: string }>(
            `SELECT c.id FROM preview_circle_choices c JOIN preview_circle_memberships m
   ON m.member_id=c.member_id AND m.circle_id=c.circle_id AND m.generation=c.generation
   WHERE c.member_id=$1 AND c.circle_id=$2 AND c.revoked_at IS NULL AND c.policy_version=$3 AND m.left_at IS NULL`,
            [actor.id, circle, CIRCLE_DISCUSSION_POLICY],
          )
        ).rows[0];
    return {
      actor: actor.id,
      generation: null,
      choices: new Map(
        choice ? [[actor.id, { id: choice.id, pseudonym: "" }]] : [],
      ),
      members: new Set(),
      currentIds: [],
    };
  }
  const input = (token: string, circle: string) =>
    tokenPattern.test(token) && knownCircle(circle);
  function encode(
    context: Context,
    circle: string,
    kind: string,
    last: string,
  ) {
    const data = Buffer.from(
      JSON.stringify({
        actor: context.actor,
        circle,
        kind,
        last,
        policy: CIRCLE_DISCUSSION_POLICY,
        choice: context.choices.get(context.actor)?.id ?? null,
      }),
    ).toString("base64url");
    return data + "." + createHmac("sha256", secret).update(data).digest("hex");
  }
  function decode(
    context: Context,
    circle: string,
    kind: string,
    cursor?: string,
  ): string | null | false {
    if (!cursor) return null;
    if (cursor.length > 1024) return false;
    const parts = cursor.split(".");
    if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1]!)) return false;
    const signature = createHmac("sha256", secret).update(parts[0]!).digest();
    if (!timingSafeEqual(signature, Buffer.from(parts[1]!, "hex")))
      return false;
    try {
      const data = JSON.parse(
        Buffer.from(parts[0]!, "base64url").toString("utf8"),
      );
      return data &&
        data.actor === context.actor &&
        data.circle === circle &&
        data.kind === kind &&
        data.policy === CIRCLE_DISCUSSION_POLICY &&
        data.choice === (context.choices.get(context.actor)?.id ?? null) &&
        typeof data.last === "string" &&
        uuid.test(data.last)
        ? data.last
        : false;
    } catch {
      return false;
    }
  }
  async function items(
    client: PoolClient,
    context: Context,
    metadata: Metadata[],
    privateOnly = false,
  ): Promise<CircleItem[]> {
    const selected = metadata.filter((item) =>
      privateOnly
        ? item.member_id === context.actor
        : item.state === "visible" && eligible(context, item),
    );
    if (!selected.length) return [];
    const rows = await client.query<{
      id: string;
      body: string | null;
      state: CircleItem["state"];
      revision: number;
      createdAt: string;
      rootId: string | null;
      member_id: string;
    }>(
      `SELECT id,body,state,revision,created_at::text AS "createdAt",root_id AS "rootId",member_id
   FROM preview_circle_posts WHERE id=ANY($1::uuid[]) AND ($2::boolean OR state='visible') ORDER BY id FOR SHARE`,
      [selected.map((p) => p.id), privateOnly],
    );
    return rows.rows.map((row) => ({
      id: row.id,
      body: row.body,
      state: row.state,
      revision: row.revision,
      createdAt: row.createdAt,
      ...(privateOnly ? {} : { rootId: row.rootId }),
      pseudonym: privateOnly
        ? "Your invented contribution"
        : context.choices.get(row.member_id)!.pseudonym,
    }));
  }
  const page = (
    context: Context,
    circle: string,
    kind: string,
    metadata: Metadata[],
    visible: CircleItem[],
  ): CirclePage => ({
    items: visible,
    nextCursor:
      metadata.length > CIRCLE_PAGE_SIZE
        ? encode(context, circle, kind, metadata[CIRCLE_PAGE_SIZE - 1]!.id)
        : null,
  });
  async function readReports(
    token: string,
    circle: string,
    receiptId?: string,
    cursor?: string,
  ): Promise<
    CircleResult<{ items: OwnedCircleReport[]; nextCursor: string | null }>
  > {
    if (!input(token, circle)) return denied;
    if (receiptId !== undefined && !uuid.test(receiptId)) return invalid;
    return transaction(circle, false, async (client, finish) => {
      const observed = await observe(client, token, circle, true);
      if (!observed) return denied;
      const after = decode(observed, circle, "owned-reports", cursor);
      if (after === false) return invalid;
      const reports = (
        await client.query<{
          id: string;
          target_id: string;
          category: ReportCategory;
          createdAt: string;
        }>(
          `SELECT id,target_id,category,created_at::text AS "createdAt" FROM preview_circle_reports
        WHERE member_id=$1 AND circle_id=$2 AND ($3::uuid IS NULL OR id=$3) AND ($4::uuid IS NULL OR id>$4)
        ORDER BY id LIMIT 21`,
          [observed.actor, circle, receiptId ?? null, after],
        )
      ).rows;
      const metadata = writes
        ? await targetMetadata(
            client,
            circle,
            reports.map((r) => r.target_id),
          )
        : [];
      const context = await authorize(
        client,
        token,
        circle,
        metadata,
        false,
        true,
      );
      if (!context) return denied;
      finish(context);
      if (!writes)
        return ready({
          items: reports.slice(0, 20).map((report) => ({
            id: report.id,
            category: report.category,
            createdAt: report.createdAt,
            status: "unavailable" as const,
          })),
          nextCursor:
            reports.length > 20
              ? encode(context, circle, "owned-reports", reports[19]!.id)
              : null,
        });
      await client.query(
        "SELECT member_id FROM preview_circle_memberships WHERE member_id=ANY($1::uuid[]) AND circle_id=$2 AND left_at IS NULL ORDER BY member_id FOR SHARE",
        [[...context.members], circle],
      );
      const choices = (
        await client.query<{
          id: string;
          member_id: string;
          pseudonym: string;
        }>(
          `SELECT c.id,c.member_id,c.pseudonym FROM preview_circle_choices c
        JOIN preview_circle_memberships m ON m.member_id=c.member_id AND m.circle_id=c.circle_id AND m.generation=c.generation
        WHERE c.member_id=ANY($1::uuid[]) AND c.circle_id=$2 AND c.policy_version=$3 AND c.revoked_at IS NULL AND m.left_at IS NULL
        ORDER BY c.member_id,c.id FOR SHARE OF c`,
          [[...context.members], circle, CIRCLE_DISCUSSION_POLICY],
        )
      ).rows;
      const sourceContext = {
        ...context,
        choices: new Map(
          choices.map((c) => [
            c.member_id,
            { id: c.id, pseudonym: c.pseudonym },
          ]),
        ),
      };
      await lockReadTargets(client, sourceContext, circle, metadata);
      // Re-read state after all target locks. A receipt never includes the target
      // body, historical root ID, source owner, pseudonym or moderator identity.
      const current = await targetMetadata(
        client,
        circle,
        reports.map((r) => r.target_id),
      );
      const items = reports.slice(0, 20).map((report) => {
        const target = current.find((m) => m.id === report.target_id);
        const root = target?.root_id
          ? current.find((m) => m.id === target.root_id && !m.root_id)
          : undefined;
        const available =
          sourceContext.choices.has(context.actor) &&
          target &&
          eligible(sourceContext, target) &&
          target.state !== "withdrawn" &&
          (!target.root_id ||
            (root &&
              root.state === "visible" &&
              eligible(sourceContext, root)));
        return {
          id: report.id,
          category: report.category,
          createdAt: report.createdAt,
          status: available
            ? target.state === "hidden"
              ? ("hidden" as const)
              : ("reported" as const)
            : ("unavailable" as const),
        };
      });
      return ready({
        items,
        nextCursor:
          reports.length > 20
            ? encode(context, circle, "owned-reports", reports[19]!.id)
            : null,
      });
    });
  }
  return {
    async reconcile(token, circle, kind, key) {
      if (!input(token, circle)) return denied;
      if (
        !uuid.test(key) ||
        !["choice", "post", "report", "moderation"].includes(kind)
      )
        return invalid;
      return transaction(circle, false, async (client, finish) => {
        // These receipts convey retained ownership, not visibility/publication
        // permission. No source body, root ID, reporter or target identity is read.
        const context =
          kind === "moderation"
            ? await moderatorContext(client, token, circle, [])
            : await authorize(client, token, circle, [], false, true);
        if (!context) return denied;
        finish(context);
        const query =
          kind === "choice"
            ? "SELECT id,CASE WHEN revoked_at IS NULL THEN 'retained' ELSE 'revoked' END status,NULL::integer revision FROM preview_circle_choices WHERE member_id=$1 AND circle_id=$2 AND idempotency_key=$3 FOR SHARE"
            : kind === "post"
              ? "SELECT id,state status,revision FROM preview_circle_posts WHERE member_id=$1 AND circle_id=$2 AND idempotency_key=$3 FOR SHARE"
              : kind === "report"
                ? "SELECT id,'retained' AS status,NULL::integer revision FROM preview_circle_reports WHERE member_id=$1 AND circle_id=$2 AND idempotency_key=$3 FOR SHARE"
                : "SELECT NULL::uuid id,action AS status,new_revision AS revision FROM preview_circle_moderation_audit WHERE actor_id=$1 AND circle_id=$2 AND idempotency_key=$3 FOR SHARE";
        const row = (
          await client.query<{
            id: string | null;
            status: string;
            revision: number | null;
          }>(query, [context.actor, circle, key])
        ).rows[0];
        return ready(
          row
            ? {
                found: true,
                id: row.id,
                status: row.status,
                revision: row.revision,
              }
            : { found: false, id: null, status: null, revision: null },
        );
      });
    },
    reports: (token, circle, cursor) =>
      readReports(token, circle, undefined, cursor),
    async reportReceipt(token, circle, id) {
      const receipt = await readReports(token, circle, id);
      if (receipt.kind !== "ready") return receipt;
      return receipt.value.items[0] ? ready(receipt.value.items[0]) : denied;
    },
    async grantModerator(adminToken, staffId, circle, key, expiresAt) {
      if (!input(adminToken, circle) || !writes) return denied;
      if (
        !uuid.test(staffId) ||
        !uuid.test(key) ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now()
      )
        return invalid;
      return transaction(circle, true, async (client, finish) => {
        const context = await adminContext(client, adminToken, staffId, true);
        if (!context) return denied;
        finish(context);
        const prior = (
          await client.query<{
            id: string;
            staff_id: string;
            circle_id: string;
            granted_by: string;
            expires_at: Date;
          }>(
            "SELECT id,staff_id,circle_id,granted_by,expires_at FROM preview_circle_moderator_grants WHERE idempotency_key=$1 FOR SHARE",
            [key],
          )
        ).rows[0];
        if (prior)
          return prior.staff_id === staffId &&
            prior.circle_id === circle &&
            prior.granted_by === context.actor &&
            prior.expires_at.getTime() === expiresAt.getTime()
            ? ready({ id: prior.id })
            : conflict;
        const staff = (
          await client.query<{ role: "moderator" | "platform_admin" }>(
            "SELECT s.role FROM staff_profiles s JOIN principals p ON p.id=s.principal_id WHERE s.principal_id=$1 AND p.expires_at>=$2 AND $2::timestamptz>clock_timestamp()",
            [staffId, expiresAt],
          )
        ).rows[0];
        if (!staff) return invalid;
        const id = randomUUID();
        await client.query(
          "INSERT INTO preview_circle_moderator_grants(id,staff_id,staff_role,circle_id,purpose,granted_by,idempotency_key,starts_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),$8)",
          [
            id,
            staffId,
            staff.role,
            circle,
            CIRCLE_DISCUSSION_POLICY,
            context.actor,
            key,
            expiresAt,
          ],
        );
        await client.query(
          "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) VALUES($1,$2,$3,$4,'created')",
          [context.actor, staffId, id, circle],
        );
        context.moderator = { grantId: id, role: staff.role };
        return ready({ id });
      });
    },
    async revokeModerator(adminToken, circle, grantId) {
      if (!input(adminToken, circle)) return denied;
      if (!uuid.test(grantId)) return invalid;
      return transaction(circle, true, async (client, finish) => {
        const observed = (
          await client.query<{ staff_id: string }>(
            "SELECT staff_id FROM preview_circle_moderator_grants WHERE id=$1 AND circle_id=$2",
            [grantId, circle],
          )
        ).rows[0];
        if (!observed) return denied;
        const context = await adminContext(
          client,
          adminToken,
          observed.staff_id,
          false,
        );
        if (!context) return denied;
        finish(context);
        const current = (
          await client.query<{ revoked_at: Date | null }>(
            "SELECT revoked_at FROM preview_circle_moderator_grants WHERE id=$1 AND circle_id=$2 FOR UPDATE",
            [grantId, circle],
          )
        ).rows[0];
        if (!current) return denied;
        if (!current.revoked_at) {
          await client.query(
            "UPDATE preview_circle_moderator_grants SET revoked_at=clock_timestamp() WHERE id=$1",
            [grantId],
          );
          await client.query(
            "INSERT INTO preview_circle_grant_audit(actor_id,staff_id,grant_id,circle_id,action) VALUES($1,$2,$3,$4,'revoked')",
            [context.actor, observed.staff_id, grantId, circle],
          );
        }
        return ready({ id: grantId });
      });
    },
    async moderationQueue(token, circle, cursor) {
      if (!input(token, circle) || !writes) return denied;
      return transaction(circle, false, async (client, finish) => {
        const observed = await moderatorObservation(client, token, circle);
        if (!observed) return denied;
        const after = decode(observed, circle, "reports", cursor);
        if (after === false) return invalid;
        const reports = (
          await client.query<{
            id: string;
            member_id: string;
            target_id: string;
            category: ReportCategory;
          }>(
            "SELECT id,member_id,target_id,category FROM preview_circle_reports WHERE circle_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 21",
            [circle, after],
          )
        ).rows;
        const metadata = await targetMetadata(
          client,
          circle,
          reports.map((r) => r.target_id),
        );
        const context = await moderatorContext(
          client,
          token,
          circle,
          metadata,
          reports.map((r) => r.member_id),
        );
        if (!context) return denied;
        finish(context);
        if (decode(context, circle, "reports", cursor) === false)
          return invalid;
        await lockReadTargets(client, context, circle, metadata);
        const items: ModeratorReport[] = [];
        for (const report of reports.slice(0, 20)) {
          if (!context.members.has(report.member_id)) continue;
          items.push({
            id: report.id,
            category: report.category,
            target: await moderatorItem(
              client,
              context,
              circle,
              report.target_id,
              metadata,
            ),
          });
        }
        return ready({
          items,
          nextCursor:
            reports.length > 20
              ? encode(context, circle, "reports", reports[19]!.id)
              : null,
        });
      });
    },
    async moderate(token, circle, id, key, action, revision, reason) {
      if (!input(token, circle) || !writes) return denied;
      if (
        !uuid.test(id) ||
        !uuid.test(key) ||
        !["hide", "restore"].includes(action) ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !["privacy", "conduct", "off_topic", "test_correction"].includes(reason)
      )
        return invalid;
      return transaction(circle, true, async (client, finish) => {
        const metadata = await target(client, circle, id);
        const context = await moderatorContext(client, token, circle, metadata);
        if (!context) return denied;
        finish(context);
        const item = await moderatorItem(
          client,
          context,
          circle,
          id,
          metadata,
          true,
        );
        if (!item) return denied;
        const digest = fingerprint({ circle, id, action, revision, reason });
        const prior = (
          await client.query<{
            post_id: string;
            fingerprint: string;
            new_revision: number;
          }>(
            "SELECT post_id,fingerprint,new_revision FROM preview_circle_moderation_audit WHERE actor_id=$1 AND idempotency_key=$2 FOR SHARE",
            [context.actor, key],
          )
        ).rows[0];
        if (prior)
          return prior.post_id === id && prior.fingerprint === digest
            ? ready({ id, revision: prior.new_revision })
            : conflict;
        if (
          item.revision !== revision ||
          item.state !== (action === "hide" ? "visible" : "hidden")
        )
          return conflict;
        const owner = metadata.find((m) => m.id === id)!.member_id,
          newRevision = revision + 1;
        await client.query(
          "UPDATE preview_circle_posts SET state=$2,revision=revision+1,changed_at=clock_timestamp() WHERE id=$1",
          [id, action === "hide" ? "hidden" : "visible"],
        );
        await client.query(
          "INSERT INTO preview_circle_moderation_audit(actor_id,actor_role,member_id,workspace_id,circle_id,post_id,action,reason,old_revision,new_revision,idempotency_key,fingerprint) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            context.actor,
            context.moderator!.role,
            owner,
            circle,
            id,
            action === "hide" ? "hidden" : "restored",
            reason,
            revision,
            newRevision,
            key,
            digest,
          ],
        );
        return ready({ id, revision: newRevision });
      });
    },
    async choice(token, circle) {
      if (!input(token, circle) || !writes) return denied;
      return transaction(circle, false, async (client, finish) => {
        const context = await authorize(client, token, circle, [], false);
        if (!context) return denied;
        finish(context);
        return ready({
          generation: context.generation!,
          active: context.choices.has(context.actor),
        });
      });
    },
    async choose(token, circle, key, generation, policy, confirmed) {
      if (!input(token, circle) || !writes) return denied;
      if (
        !uuid.test(key) ||
        !/^\d{1,18}$/.test(generation) ||
        policy !== CIRCLE_DISCUSSION_POLICY ||
        !confirmed
      )
        return invalid;
      return transaction(circle, true, async (client, finish) => {
        const context = await authorize(client, token, circle, [], false);
        if (!context) return denied;
        finish(context);
        if (context.generation !== generation) return conflict;
        const prior = (
          await client.query<{
            id: string;
            circle_id: string;
            generation: string;
            policy_version: string;
            revoked_at: Date | null;
          }>(
            "SELECT id,circle_id,generation::text,policy_version,revoked_at FROM preview_circle_choices WHERE member_id=$1 AND idempotency_key=$2 FOR SHARE",
            [context.actor, key],
          )
        ).rows[0];
        if (prior)
          return prior.circle_id === circle &&
            prior.generation === generation &&
            prior.policy_version === policy &&
            !prior.revoked_at
            ? ready({ id: prior.id })
            : conflict;
        if (context.choices.has(context.actor)) return conflict;
        const id = randomUUID();
        await client.query(
          `INSERT INTO preview_circle_choices(id,member_id,workspace_id,circle_id,generation,policy_version,pseudonym,idempotency_key)
     VALUES($1,$2,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            context.actor,
            circle,
            generation,
            policy,
            "Peer " + randomBytes(8).toString("hex"),
            key,
          ],
        );
        return ready({ id });
      });
    },
    async list(token, circle, cursor) {
      if (!input(token, circle) || !writes) return denied;
      return transaction(circle, false, async (client, finish) => {
        const initial = await observe(client, token, circle);
        if (!initial) return denied;
        const after = decode(initial, circle, "roots", cursor);
        if (after === false) return invalid;
        const metadata = (
          await client.query<Metadata>(
            "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE circle_id=$1 AND root_id IS NULL AND state='visible' AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT 21",
            [circle, after],
          )
        ).rows;
        // Discover every candidate owner before acquiring sorted source locks.
        const context = await authorize(client, token, circle, metadata, true);
        if (!context) return denied;
        finish(context);
        if (decode(context, circle, "roots", cursor) === false) return invalid;
        return ready(
          page(
            context,
            circle,
            "roots",
            metadata,
            await items(client, context, metadata.slice(0, 20)),
          ),
        );
      });
    },
    async thread(token, circle, id, cursor) {
      if (!input(token, circle) || !writes) return denied;
      if (!uuid.test(id)) return invalid;
      return transaction(circle, false, async (client, finish) => {
        const roots = await target(client, circle, id);
        if (roots.length !== 1 || roots[0]!.root_id) return denied;
        // Cursor authentication uses an unlocked actor/choice observation; the
        // complete source context is locked and checked again before publication.
        const preview = await observe(client, token, circle);
        if (!preview) return denied;
        const after = decode(preview, circle, "replies:" + id, cursor);
        if (after === false) return invalid;
        const metadata = (
          await client.query<Metadata>(
            "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE circle_id=$1 AND root_id=$2 AND state='visible' AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 21",
            [circle, id, after],
          )
        ).rows;
        const context = await authorize(
          client,
          token,
          circle,
          [...roots, ...metadata],
          true,
        );
        if (!context) return denied;
        finish(context);
        if (
          decode(context, circle, "replies:" + id, cursor) === false ||
          roots[0]!.state !== "visible" ||
          !eligible(context, roots[0]!)
        )
          return denied;
        await lockReadTargets(client, context, circle, [...roots, ...metadata]);
        const root = (await items(client, context, roots))[0];
        if (!root) return denied;
        return ready({
          root,
          replies: page(
            context,
            circle,
            "replies:" + id,
            metadata,
            await items(client, context, metadata.slice(0, 20)),
          ),
        });
      });
    },
    async post(token, circle, key, body, confirmed, rootId) {
      if (!input(token, circle) || !writes) return denied;
      body = body.trim();
      if (
        !uuid.test(key) ||
        !body ||
        body.length > 2000 ||
        !confirmed ||
        (rootId !== undefined && !uuid.test(rootId))
      )
        return invalid;
      return transaction(circle, true, async (client, finish) => {
        const roots = rootId ? await target(client, circle, rootId) : [];
        const context = await authorize(client, token, circle, roots, true);
        if (!context) return denied;
        finish(context);
        const digest = fingerprint({ circle, body, root: rootId ?? null });
        const prior = (
          await client.query<{
            id: string;
            fingerprint: string | null;
            state: string;
            circle_id: string;
            root_id: string | null;
          }>(
            "SELECT id,fingerprint,state,circle_id,root_id FROM preview_circle_posts WHERE member_id=$1 AND idempotency_key=$2 FOR SHARE",
            [context.actor, key],
          )
        ).rows[0];
        if (prior)
          return prior.circle_id === circle &&
            prior.root_id === (rootId ?? null) &&
            (prior.fingerprint === digest || prior.state === "withdrawn")
            ? ready({ id: prior.id })
            : conflict;
        if (
          rootId &&
          (roots.length !== 1 ||
            roots[0]!.root_id ||
            roots[0]!.state !== "visible" ||
            !eligible(context, roots[0]!))
        )
          return denied;
        const count = (
          await client.query<{ n: number }>(
            "SELECT count(*)::integer n FROM preview_circle_posts WHERE member_id=$1 AND circle_id=$2",
            [context.actor, circle],
          )
        ).rows[0]!;
        if (count.n >= 200) return { kind: "limit" };
        if (
          rootId &&
          (
            await client.query<{ n: number }>(
              "SELECT count(*)::integer n FROM preview_circle_posts WHERE root_id=$1 AND circle_id=$2",
              [rootId, circle],
            )
          ).rows[0]!.n >= 100
        )
          return { kind: "limit" };
        const id = randomUUID();
        await client.query(
          `INSERT INTO preview_circle_posts(id,member_id,workspace_id,circle_id,choice_id,root_id,body,idempotency_key,fingerprint)
     VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            context.actor,
            circle,
            context.choices.get(context.actor)!.id,
            rootId ?? null,
            body,
            key,
            digest,
          ],
        );
        return ready({ id });
      });
    },
    async report(token, circle, id, key, category) {
      if (!input(token, circle) || !writes) return denied;
      if (
        !uuid.test(id) ||
        !uuid.test(key) ||
        !REPORT_CATEGORIES.includes(category as ReportCategory)
      )
        return invalid;
      return transaction(circle, true, async (client, finish) => {
        const metadata = await target(client, circle, id),
          context = await authorize(client, token, circle, metadata, true);
        if (!context) return denied;
        finish(context);
        const prior = (
          await client.query<{
            id: string;
            circle_id: string;
            target_id: string;
            category: string;
          }>(
            "SELECT id,circle_id,target_id,category FROM preview_circle_reports WHERE member_id=$1 AND idempotency_key=$2 FOR SHARE",
            [context.actor, key],
          )
        ).rows[0];
        if (prior)
          return prior.circle_id === circle &&
            prior.target_id === id &&
            prior.category === category
            ? ready({ id: prior.id })
            : conflict;
        if (
          !metadata.length ||
          metadata.some(
            (item) => item.state !== "visible" || !eligible(context, item),
          )
        )
          return denied;
        const duplicate = (
          await client.query<{ id: string; category: string }>(
            "SELECT id,category FROM preview_circle_reports WHERE member_id=$1 AND target_id=$2",
            [context.actor, id],
          )
        ).rows[0];
        if (duplicate)
          return duplicate.category === category
            ? ready({ id: duplicate.id })
            : conflict;
        const reportId = randomUUID();
        await client.query(
          "INSERT INTO preview_circle_reports(id,member_id,workspace_id,circle_id,target_id,category,idempotency_key) VALUES($1,$2,$2,$3,$4,$5,$6)",
          [reportId, context.actor, circle, id, category, key],
        );
        return ready({ id: reportId });
      });
    },
    async withdraw(token, circle, id, confirmed) {
      if (!input(token, circle)) return denied;
      if (!uuid.test(id) || !confirmed) return invalid;
      return transaction(circle, true, async (client, finish) => {
        const context = await authorize(client, token, circle, [], false, true);
        if (!context) return denied;
        finish(context);
        const item = (
          await client.query<{ id: string; state: string }>(
            "SELECT id,state FROM preview_circle_posts WHERE id=$1 AND member_id=$2 AND circle_id=$3 FOR UPDATE",
            [id, context.actor, circle],
          )
        ).rows[0];
        if (!item) return denied;
        if (item.state !== "withdrawn")
          await client.query(
            "UPDATE preview_circle_posts SET state='withdrawn',body=NULL,fingerprint=NULL,revision=revision+1,withdrawn_at=clock_timestamp(),changed_at=clock_timestamp() WHERE id=$1",
            [id],
          );
        return ready({ id });
      });
    },
    async withdrawChoice(token, circle, confirmed) {
      if (!input(token, circle)) return denied;
      if (!confirmed) return invalid;
      return transaction(circle, true, async (client, finish) => {
        const context = await authorize(client, token, circle, [], false, true);
        if (!context) return denied;
        finish(context);
        await client.query(
          "UPDATE preview_circle_choices SET revoked_at=clock_timestamp() WHERE member_id=$1 AND circle_id=$2 AND revoked_at IS NULL",
          [context.actor, circle],
        );
        return ready({ id: context.actor });
      });
    },
    async owned(token, circle, cursor) {
      if (!input(token, circle)) return denied;
      return transaction(circle, false, async (client, finish) => {
        const context = await authorize(client, token, circle, [], false, true);
        if (!context) return denied;
        finish(context);
        const after = decode(context, circle, "owned", cursor);
        if (after === false) return invalid;
        const metadata = (
          await client.query<Metadata>(
            "SELECT id,member_id,choice_id,root_id,state,revision FROM preview_circle_posts WHERE member_id=$1 AND circle_id=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 21",
            [context.actor, circle, after],
          )
        ).rows;
        return ready(
          page(
            context,
            circle,
            "owned",
            metadata,
            await items(client, context, metadata.slice(0, 20), true),
          ),
        );
      });
    },
  };
}
