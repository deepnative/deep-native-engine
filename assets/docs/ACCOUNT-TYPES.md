# Account types

Every signed-in account is a **student**. The stored `account_roles` table (migration094, keyed by verified-email hash) can add **coach** and **admin**. It is seeded once for shi@deepnative.io and tom@deepnative.io. A role removed later is not restored when the service restarts. No screen assigns roles yet ([#673](https://github.com/deepnative/deep-native-engine/issues/673)).

| View    | Header link            | Lands on                                     |
| ------- | ---------------------- | -------------------------------------------- |
| Student | Monthly coaching hours | `/learn`                                     |
| Coach   | Coaching               | `/coach`: saved hours and status, no billing |
| Admin   | Administration         | `/admin`: deliberate entry, unchanged        |

An account with more than one role sees **Switch to … view** buttons in the header. The choice is saved in an HttpOnly `dne_view` cookie, checked against the account's roles on every request. Without a saved choice, the highest role applies. Sign-in goes to `/home`, which redirects to the current view's page unless an earlier invoice or program selection is being resumed.

A view only changes what is shown. Switching to the admin view grants nothing until **Enter administration**. Switching away does not end an administrator session. `/coach` checks the coach role on the server. Admin entry and the `authorized_staff_profiles` fence check the admin role, so removing a role also stops a session that is already open. Roles are only read when administrator entry is enabled and the mode is not live. Otherwise everyone sees the student view.

## BDD mapping

| Scenario                                                   | Executable evidence                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ROLES-01 a student lands on Learning with student links    | `account-views` and `account-navigation` units, `account-roles` PostgreSQL test, L289                                  |
| ROLES-02 an owner lands on Administration with the switch  | `account-views` units (view choice, `/home`), app NAV-08, L289                                                         |
| ROLES-03 the coach view shows hours only and is remembered | `coach-view` units, `account-roles` PostgreSQL summary, L289                                                           |
| ROLES-04 a student is refused Coaching and other views     | `coach-view` and `account-views` units, `account-roles` PostgreSQL test, L289                                          |
| ROLES-05 switching neither grants nor ends administration  | `account-views` units (no credential cookies), L289 `/operator` 403 then 200                                           |
| ROLES-06 admin entry and the fence follow the stored role  | `administrator-entry-owner` unit, `account-roles` PostgreSQL test (removing the role denies entry and an open session) |
| ROLES-07 forged switches are refused                       | `account-views` units (CSRF, origin, unknown view, extra fields, query, non-form body)                                 |
