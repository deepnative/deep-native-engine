# Local reader behavior only. No account, publication or application L-series claim.
Feature: Follow the complete authored foundation sequence

  Scenario: GUI-01 — Resume a named learning path from the learner's actual position
    Given a learner has opened a lesson stage in an example route
    When they open Learn and choose Continue learning
    Then all six lessons have named destinations
    And the same route, lesson, stage and writing return unchanged
    And navigating the path does not award learning or mastery

  Scenario: GUI-02 — Practise a checked mistake and remove it after correction
    Given a learner has checked an incorrect response in any example route
    When they open Practice
    Then the affected lesson is offered for review
    And reopening it retains the learner's choice and source-based explanation
    When they correct and check that response
    Then it is no longer listed as a mistake to review
    And the skill remains available for voluntary practice

  Scenario: GUI-03 — Find private drafts without silently saving or mixing routes
    Given a learner has written lesson work in the Work route
    When they open My work and continue writing
    Then the original draft returns unchanged without an automatic save
    And an explicit save, reload and download retain the draft
    And the Everyday route does not show the Work draft
    Given a learner is writing a later final-draft field in a reduced mobile viewport
    Then Save notebook remains reachable without overlapping the focused writing
    And typing alone leaves stored writing unchanged and shows Unsaved changes
    When they explicitly choose Save notebook and reload
    Then their latest writing and current draft step return with browser-only save status

  Scenario: GUI-04 — Keep keyboard position through routine lesson actions
    Given keyboard focus is on the next-stage action
    When the learner opens the practice stage
    Then focus identifies the newly opened exercise
    Given keyboard focus is on a feedback decision
    When the learner confirms a choice
    Then focus remains on the replacement decision control

  Scenario: GUI-05 — Navigate named course destinations on a narrow screen
    Given the reader is displayed at a 390-pixel viewport
    When the learner moves between Learn, Practice, My work and the final case
    Then course destinations remain visibly named
    And the views and writing fields fit without horizontal page overflow
    When the learner checks the source and returns to the exercise
    Then focus follows the chosen source and returns to the current exercise
    And lesson and final writing remain unchanged without an automatic save

  Scenario: READER-029 — See the existing task requirements beside each writing field
    Given a realistic Everyday, Work or Technical brief at desktop or narrow width
    When the learner visits the first-draft and revision steps
    Then the expected output and all six authored field instructions are visible beside their writing
    And the output length, shape, source checks, unknowns and revision requirements are retained
    And no example answer replaces their text or marks learning complete
    And reading the guidance preserves existing writing and the learner's self-check
    And explicit save, reload and download retain both drafts, the selected step and full source packet
    And the first writing field is visible without a long source panel and there is no horizontal overflow

  Scenario: READER-026 — Follow four practice stages while retaining the learner's work
    Given an Everyday, Work or Technical final practice at desktop or narrow width
    When the learner freely visits the brief, first draft, update and revision stages
    Then the relevant content is visible and the compact source reminder does not displace writing
    And earlier words remain literal and unchanged through navigation and comparison
    And navigation does not mark learning complete or clear the self-check
    But editing first or revised work clears its self-check
    And explicit save, reload and export preserve all writing and the selected stage

  Scenario: READER-027 — Load compatible records and protect malformed stage values
    Given an earlier compatible notebook with no final-stage field
    When the learner opens it
    Then the first stage is selected in memory and stored writing/checks stay unchanged until explicit save
    But a non-integer or out-of-range stage protects the unreadable original from overwrite
    And the original remains downloadable

  Scenario: READER-028 — Recover staged work across save failure and route changes
    Given drafts in separate example routes
    When saving fails or the learner switches routes
    Then all current writing remains editable and downloadable
    And each route retains its own stage and writing
    And leaving with unsaved writing still warns

  Scenario: READER-025 — Keep an Everyday plan accurate through changed replies
    Given the learner opens the book-swap case at desktop or narrow width
    When they retain a first reminder and open the later reply snapshot
    Then their words and existing self-check stay intact
    When they retain a revised reminder and reason
    Then the old self-check clears and comparison does not replace either draft
    And save, download and reload retain both versions and the full source packet
    And expanded content fits the page with wide tables contained

  Scenario: READER-024 — Rehearse a realistic technical investigation and later revision
    Given the learner opens Technical final practice at desktop or narrow width
    When they retain an initial investigation and reveal the later requirement and patch note
    Then the initial writing stays intact
    When they revise the plan and reason
    Then the earlier self-check clears and the supplied comparison does not replace their words
    And save, download and reload retain both versions and the full evidence packet
    And expanded content fits the page with wide tables scrolling within their container

  Scenario: READER-023 — Rehearse a changing project brief with retained writing
    Given the learner opens the realistic Work final practice at desktop or narrow width
    When they write a first plan and reveal the later source update
    Then their initial writing is retained
    When they write a revision and reason and compare the worked record
    Then a previous self-check is cleared by the edit
    And save, download and reload retain both versions and the source packet
    And the expanded source and comparison fit the page with tables scrolling inside it

  Scenario: READER-019 — Draft a contribution beside its worked source and revision
    Given the learner opens the optional contribution practice after the final record
    When they write a problem, first proposal, revision, reason and rights note
    Then the source and supplied comparison remain visible without replacing their words
    And explicit save, download and reload retain the draft for that route at both widths
    And the draft has no submitted, accepted or shared status

  Scenario: READER-020 — Revise or cancel a sharing plan without erasing learning
    Given the final record and optional proposal have separate learner self-checks
    When proposal text, attribution or intended audience changes
    Then only the proposal self-check is cleared
    When the learner cancels the member-sharing plan
    Then the attribution is cleared and the intended audience becomes private
    And the first and revised proposal and final record stay intact

  Scenario: READER-021 — Keep an unfinished contribution after a failed save
    Given the browser cannot save an unfinished contribution
    When the learner saves and then downloads the notebook
    Then the page reports failure and retains editable literal writing
    And the download contains the draft, source and unsubmitted audience plan

  Scenario: READER-022 — Preserve separate routes and protected notebook versions
    Given saved learning may lack the optional worksheet or contain an unreadable one
    When the learner opens the reader
    Then compatible learning gains an empty optional worksheet without losing prior writing
    And an unreadable stored copy is protected and separately downloadable
    And switching routes keeps contribution drafts separate

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

  Scenario: READER-030 — Revisit a weak criterion and return to the same final record
    Given an Everyday, Work or Technical final record at desktop or narrow width
    When the learner reviews any of its six criteria
    Then its original evidence and a specific repair prompt are available
    And its practice action opens the relevant lesson in the same example route
    When the learner practises and returns to the final record
    Then the first draft, revision and self-check remain unchanged by navigation
    And the selected criterion is available again beside the retained writing
    And editing the final record still clears its self-check
    And neither the practice action nor the return claims a saved or assessed result

  Scenario: READER-031 — Retain a practice-return context without losing saved work
    Given an explicit browser save made with or without a practice-return context
    When the learner reloads or switches example routes
    Then each route keeps its own writing and valid return context
    And older compatible records gain an empty context only in memory
    But an unreadable context protects the original stored copy from overwrite
    And a rejected save leaves current writing and the source packet downloadable
    And a return action does not save automatically or alter earlier-version records
