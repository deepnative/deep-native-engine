# Local reader behavior only. No account, publication or application L-series claim.
Feature: Follow the complete authored foundation sequence

  Scenario: READER-001 — Follow six lessons and a final practice in one route
    Given the learner chooses Everyday, Work or Technical
    When they follow the course path on a desktop or narrow screen
    Then all six lessons show their authored outcome and selected-route source
    And each offers example, practice, fresh case and own-work stages
    And the next action leads to the next lesson and finally the connected practice
    And another route's example is not mixed into the selected route

  Scenario: READER-002 — Learn from a source-specific practice response
    Given the learner has the selected lesson's supplied source
    When they use a hint and check an incorrect choice or claim classification
    Then the response explains the source-based answer and allows another attempt
    When they correct their response
    Then the reader acknowledges that practice response without a proficiency score
    And it offers the fresh case without instructing them to retry a correct answer

  Scenario: READER-003 — Keep fresh practice and earlier work available
    Given the learner has written a fresh-case attempt and their own lesson work
    When they continue to a later lesson or the final practice
    Then the earlier notes remain available with their lesson names
    And the final practice uses its own fresh source and six-part record
    And example comparisons are explicitly separate from ungraded learner writing
    When a Work learner opens the final worked comparison
    Then all six steps are demonstrated against CAP-W with a repaired task-owner-date table
    And the example preserves unknown deadlines and decision ownership
    And ordinary date words in its table remain intact on a narrow screen
    And opening the comparison leaves the learner's own writing and self-check unchanged

  Scenario: READER-004 — Deliberately save and resume one route's work
    Given an unsupported route in the URL falls back to Everyday
    And the learner has separate Everyday and Work notes
    When they save one route in this browser and reload
    Then only its explicit saved position and work are restored for that route
    And switching routes preserves separate in-page drafts
    And navigation alone does not claim saved work or learning completion
    And leaving after reading alone does not prompt about unsaved writing
    And leaving with changed writing warns before that writing is lost
    And the earlier standalone prototype's storage is unchanged

  Scenario: READER-005 — Keep writing usable when saving fails
    Given browser storage rejects a save
    When the learner tries to save their writing
    Then the reader reports that saving failed without discarding the text
    And a downloaded copy contains their current route, sources and writing
    And no member-account save is claimed

  Scenario: READER-006 — Preserve an unreadable or older-content saved record
    Given a route has malformed saved data or a different content version
    When the learner opens that route
    Then the reader explains why the saved record could not be restored
    And the original stored bytes are not overwritten
    And the learner can download that stored copy and keep new writing separately

  Scenario: READER-007 — Recheck changed work and render writing as text
    Given the learner has deliberately self-checked written work
    When they change their fresh attempt, own work or final record
    Then the applicable prior self-check is cleared
    And their text remains editable and is displayed literally in earlier notes
    And an HTML-looking draft cannot run as page content

  Scenario: READER-008 — Describe the evidence honestly
    Given the learner opens examples, reveals feedback or browses ahead
    When they inspect the course path and their notebook
    Then opening a page does not mark a lesson learned or completed
    And written work and deliberate self-checks have distinct labels
    And local browser saving is distinguished from member-account persistence
    And free writing receives criteria rather than an automatic grade

  Scenario: READER-009 — Keep the source beside the current exercise
    Given a lesson has different worked-example and fresh-case facts
    When the learner opens the fresh case in any route
    Then the reference panel shows that fresh case's supplied source
    And it is labelled Fresh source rather than implying the earlier source applies
    When the learner moves to their own work
    Then any fallback supplied reference is labelled Example source
    And the learner's own source is recorded in their writing rather than assumed

  Scenario: READER-010 — Continue the learner's own project across lessons
    Given the learner recorded their source and task in Lesson 1 own work
    When they open Your work in Lessons 2 through 6
    Then their starting work is visible beside the current exercise
    And it is labelled learner-written notes to check against the original source
    And it does not replace the separate fresh-case or final-practice source
    And another route does not inherit these notes

  Scenario: READER-011 — Inspect the draft named in a practice question
    Given a practice question asks the learner to repair a schedule or compare drafts
    When they open that question
    Then the original schedule or draft versions are stated with the question
    And they can compare the supplied source without navigating backwards

  Scenario: READER-012 — Refine content without discarding earlier learning records
    Given the learner saved a readable notebook for an earlier content version
    When they open refined lessons
    Then the earlier notebook remains separately downloadable with its original version
    And current-version writing starts without inherited answers or self-checks
    When they explicitly save current-version writing and reload
    Then the current notebook is restored and the earlier bytes remain unchanged
    And a failed save leaves current writing editable and the earlier copy intact
