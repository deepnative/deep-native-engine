Feature: Refine an invented content draft in a local workshop
  These AUTHOR scenarios cover browser-local practice only.
  Existing CREF and application IDs retain their broader scope.

  Scenario: AUTHOR-001 — Inspect the source and critique before revising
    Given a supplied practice draft contains a deliberate editorial mistake
    When an author opens its workshop case
    Then the source, affected question, critique and original version are visible
    And the current course is not described as containing that seeded error

  Scenario: AUTHOR-002 — Correct a key and its related fresh case
    Given the budget and room claims have no supplied amount or location
    When the author changes both keys to Not given and explains each correction
    And tries the revised learner preview and records a reason and self-check
    Then the preview uses the changed keys and explanations
    And a separate saved revision survives reload with the original intact
    But a contradicted or supported key cannot pass this fixed source check

  Scenario: AUTHOR-003 — Make a wording correction inspectable
    Given a practice request does not make simultaneous staffing inspectable
    When the author revises the request, choice, explanation and fresh example
    Then before and after text and the revision reason are visible
    And the learner preview uses that exact revised wording
    And author self-review is not presented as automatic semantic validation

  Scenario: AUTHOR-004 — Recheck edited text and preserve literal writing
    Given an author has previewed and checked a draft
    When they edit its wording or revision reason
    Then its prior readiness and self-check are cleared
    And the prior preview is identified as out of date
    And HTML-looking text is displayed literally in preview, comparison and export
    And leaving unsaved writing warns without warning for preview-only activity

  Scenario: AUTHOR-005 — Recover from a failed local save
    Given a checked revision is ready to save
    When browser storage rejects the write
    Then the working text and original record remain intact
    And no saved revision is claimed
    And a downloadable draft and a later save remain available

  Scenario: AUTHOR-006 — Preserve an unreadable or different-version record
    Given the saved workshop record is malformed or belongs to another fixture version
    When the workshop loads
    Then the original stored bytes remain downloadable and are not overwritten
    And the author may still edit and download a separate draft

  Scenario: AUTHOR-007 — Compare a newer local revision without losing either draft
    Given two tabs opened the same saved revision
    And one tab saved a newer revision
    When the second tab tries to save
    Then the newer record is not overwritten and the second draft is retained
    And checking the same draft again does not mark the conflict ready to save
    And the author can inspect the latest record and deliberately use it as a new base
    And that action clears the earlier checks before appending a new revision

  Scenario: AUTHOR-008 — Keep cases and learner notebooks separate
    Given an author has different writing in two workshop cases
    When they switch cases and save one
    Then each case retains its own draft and saved revisions
    And existing reader and prototype storage is unchanged
    And no course file, catalog version, account or publication is changed
