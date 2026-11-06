# Account types

Every signed-in account is a **student**. The stored `account_roles` table (migration094, keyed by verified-email hash) can add **coach** and **admin**. It is seeded once for shi@deepnative.io and tom@deepnative.io. A role removed later is not restored when the service restarts. Administrators manage roles on the **Roles** page (`/operator/roles`, [#684](https://github.com/deepnative/deep-native-engine/issues/684)).

| View    | Header link            | Lands on                                     |
| ------- | ---------------------- | -------------------------------------------- |
| Student | Monthly coaching hours | `/learn`                                     |
| Coach   | Coaching               | `/coach`: saved hours and status, no billing |
| Admin   | Administration         | `/admin`: deliberate entry, unchanged        |

An account with more than one role sees **Switch to … view** buttons in the header. The choice is saved in an HttpOnly `dne_view` cookie, checked against the account's roles on every request. Without a saved choice, the highest role applies. Sign-in goes to `/home`, which redirects to the current view's page unless an earlier invoice or program selection is being resumed.

A view only changes what is shown. Switching to the admin view grants nothing until **Enter administration**. Switching away does not end an administrator session. `/coach` checks the coach role on the server. Admin entry and the `authorized_staff_profiles` fence check the admin role, so removing a role also stops a session that is already open. Roles are only read when administrator entry is enabled and the mode is not live. Otherwise everyone sees the student view.

## Roles page and coach assignment (#684)

After **Enter administration**, an administrator opens **Roles** from Administration or the console:

- **Give a role:** type a verified email and tick Coach and/or Admin. Only the email's hash is stored. The role applies as soon as someone signs in with that email, so it can be given before the person signs up.
- **Remove a role:** each held role has a Remove button. Nobody can remove their own admin role, so the site always keeps an administrator.
- **Set coaches:** on the console's selected learner, the **Coaches** checkboxes pick any coach-role holders; saving with none ticked leaves the learner without a coach. `/coach` shows a coach only the learners assigned to them; an unassigned learner appears to no coach. Removing someone's coach role removes their assignments (`coach_assignments` foreign key, migration095).
- **Default coaches ([#689](https://github.com/deepnative/deep-native-engine/issues/689)):** migration097 lets a learner have several coaches and seeds `default_coaches` with shi@ and tom@deepnative.io. Every learner that existed when it first ran was assigned to both, and a database trigger assigns each new learner to every default coach who still holds the coach role. Automatic assignments have no `assigned_by`. An assignment an administrator removes is not restored on restart.

Every grant, removal, assignment and clear is recorded in `account_role_events` with the administrator and time. That includes each assignment lost when a coach's role is removed. Administrators read these entries, with billing changes from `billing_change_events`, on Change history (`/operator/changes`). Entries are append-only, hold no email or reason, and stay when an account is deleted; a deleted member shows as "a deleted account". Writes require the current administrator session, the same origin and the CSRF token.

## BDD mapping

| Scenario                                                     | Executable evidence                                                                                                                           |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ROLES-01 a student lands on Learning with student links      | `account-views` and `account-navigation` units, `account-roles` PostgreSQL test, L290                                                         |
| ROLES-02 an owner lands on Administration with the switch    | `account-views` units (view choice, `/home`), app NAV-08, L290                                                                                |
| ROLES-03 the coach view shows hours only and is remembered   | `coach-view` units, `account-roles` PostgreSQL summary, L290                                                                                  |
| ROLES-04 a student is refused Coaching and other views       | `coach-view` and `account-views` units, `account-roles` PostgreSQL test, L290                                                                 |
| ROLES-05 switching neither grants nor ends administration    | `account-views` units (no credential cookies), L290 `/operator` 403 then 200                                                                  |
| ROLES-06 admin entry and the fence follow the stored role    | `administrator-entry-owner` unit, `account-roles` PostgreSQL test (removing the role denies entry and an open session)                        |
| ROLES-07 forged switches are refused                         | `account-views` units (CSRF, origin, unknown view, extra fields, query, non-form body)                                                        |
| ROLEADMIN-01..05 list, grant, remove, keep own admin, audit  | `account-role-admin` units, `role-admin` PostgreSQL test, L292                                                                                |
| COACHLINK-01..04 assign one coach; each coach sees theirs    | `account-role-admin`, `administrator-entry-routes` and `coach-view` units, `role-admin` and `account-roles` PostgreSQL tests, L290, L292      |
| DEFCOACH-01..05 default coaches; several coaches per learner | `account-role-admin` and `administrator-entry-routes` units, `role-admin`, `account-roles` and `simple-invoices` PostgreSQL tests, L290, L292 |
