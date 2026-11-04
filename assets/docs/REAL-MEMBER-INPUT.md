# Real information on hosted learning forms

Owner decision, 4 November 2026 (#653, child of #28): members may enter real information on the hosted engine's private learning forms.

## What changes on the hosted runtime

These forms no longer ask for, or check, an invented-information confirmation: assignment attempts and reflections, goals and milestones, career notes and drafts, study reflection, one-note practice and practice sessions. The starter exercise and lesson usefulness wording no longer mention sample information. Each form says the text stays private to the member's account until they choose to share it, that they can export or delete it, and to leave out passwords and other people's private information. A form opened before the change that still sends the old field also saves. Hosted dashboard wording no longer calls the account a preview.

`inventedInputOnly()` in `src/hosting-presentation.ts` selects this. It follows the request's validated runtime (the hosted origin over HTTPS); no hostname or header can select it. The local preview keeps its checkbox and wording, and its journeys are unchanged.

## What does not change

- **Handling.** Storage, length limits, ownership, CSRF, export, withdrawal and account deletion are the same. There is no new table or provider, and no new staff access to private text.
- **Sharing.** A reviewer sees assignment text only through the existing explicit handoff and exact grant.
- **Simulation.** Practice and study stay labelled as simulated, and no live AI is connected.
- **Forms left as they were.** Circle discussion and event rehearsal (shared or rehearsal data), evidence uploads and local AI simulation, member proposals (#97, `DNE_MEMBER_CONTRIBUTIONS`) and support (its own intake flag).

## Evidence

REALINPUT-01..04 are in `tests/unit/real-member-input.test.ts`, `tests/unit/app.test.ts` and `tests/unit/practice-session-ui.test.ts`, using a real app instance with the hosted origin. No browser journey runs the hosted runtime, because the browser suite serves plain HTTP on a local address and the hosted switch requires HTTPS.

## Limits

Legal terms, jurisdiction and a formal privacy notice remain on #12. This decision allows real input on these forms; it does not establish launch readiness. Backups are not erased by account deletion within their retention window.
