# Local reader behavior only. No account, publication or application L-series claim.
Feature: Follow the complete authored foundation sequence

  Scenario: READER-018 — Rehearse a supplied follow-up without losing the learner's words
    Given the learner opens Lesson 2's fresh case in any route
    When they write an attempt and reveal its supplied follow-up conversation
    Then they can inspect a specific hint, repair and reason beside the same source
    And missing-evidence and unsupported-request examples remain truthful
    And opening an example neither changes their writing nor marks it assessed
    When they keep an attempt, repair and reason and explicitly save
    Then reload and download preserve that writing at desktop and narrow widths

  Scenario: READER-017 — Explain the specific error in each revised practice choice
    Given the learner opens a refined practice item with its original source visible
    When they try each of its three choices and check the answer
    Then the same source-supported key is recognised as correct
    And each wrong choice receives its corresponding source-based explanation and repair
    And the selected choice stays visible and can be changed
    And the fresh case still uses its own unchanged source
    And the item remains usable at desktop and narrow widths

  Scenario: READER-013 — Read feedback with its original source and version
    Given Lesson 6 supplies an invented fresh source, draft versions and practice comment
    When the learner opens its feedback decision workspace in any route
    Then the exact source and original comment version are visible beside the current draft
    And an older comment is not presented as a review of a newer draft
    And the feedback is labelled supplied practice rather than a real person's response

  Scenario: READER-014 — Retain a reasoned feedback decision without rewriting history
    Given the learner can inspect the source and current artifact
    When they choose revise, decline with evidence or already addressed
    Then a choice and written reason are required to add the decision
    And the learner can compare their reason with supplied source-based guidance
    And revising requires different nonempty text and appends a new artifact version
    And declining or already addressed retains the current text and version
    And already addressed requires a newer artifact than the comment's version
    And all original versions, the comment, reason and optional clarification remain identifiable
    And adding a decision does not claim persistence, a sent question or independent assessment

  Scenario: READER-015 — Save and recover the feedback record with the notebook
    Given the learner has a recorded decision or an unfinished response
    When they explicitly save and reload or download the notebook
    Then its versions, decisions, writing and clarification are retained
    But a failed save leaves the response recoverable without claiming persistence
    And an invalid decision history is protected from overwrite
    And earlier content notebooks remain separate and unchanged

  Scenario: READER-016 — Keep feedback writing literal and separate by route
    Given the learner has self-checked Lesson 6 work
    When they edit a feedback response or add a decision
    Then the earlier lesson self-check is cleared
    And HTML-looking text is rendered and downloaded literally
    And switching routes preserves distinct response drafts and decision records
    And browsing the workspace alone does not warn about unsaved writing

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
    When a Technical learner opens the final worked comparison
    Then all six steps are demonstrated against CAP-T with candidate inputs, expectations, requirements and execution evidence
    And the PNG boundary and above-limit cases remain not run with no observed result
    And JPEG behavior stays unspecified rather than acquiring an invented acceptance or rejection rule
    And a conditional later interruption has its own attempt record without changing the original no-tests-run brief
    And the learner's writing and self-check remain unchanged at desktop and narrow widths

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
