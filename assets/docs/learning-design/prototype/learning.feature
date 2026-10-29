# Local storyboard scope only. These IDs do not extend the application L-series register.
Feature: Practise the Lesson 2 to Lesson 3 transition locally

  Scenario: PROTO-001 — Carry a request into a distinct source-checking exercise
    Given a learner chooses Everyday, Work or Technical examples
    When they read the worked request and try the fresh case
    Then the fresh source has different facts from the worked example
    And their written request remains available while checking the supplied teaching sample
    And the sample is explicitly identified as not generated from their request

  Scenario: PROTO-002 — Explain, correct and apply a classification
    Given the fresh sample contains a supported, a contradicted and a not-given claim
    When the learner deliberately chooses incorrect classifications and checks them
    Then each explanation refers to that claim's own source facts
    And a hint explains the distinction between contradiction and missing information
    And correcting all classifications offers the repair step
    And the claim order differs between the three example routes

  Scenario: PROTO-003 — Keep the request, repair and reason in a deliberate local save
    Given a learner has corrected the claims
    When they write a repaired answer and a reason and review their revision
    Then their request, the teaching sample and their corrected text appear together
    And no automatic grade or mastery score is claimed
    When they choose Save in this browser and reload
    Then that route's saved step and writing are restored on the same browser origin
    And the page says the practice is not linked to a learning account

  Scenario: PROTO-004 — Keep separate unsaved drafts when switching examples
    Given an Everyday request is written but not saved
    When the learner switches to Work, writes a different request and switches back
    Then the Everyday request is still available in this open page
    And returning to Work shows only its own request
    And switching routes does not silently save either draft

  Scenario: PROTO-005 — Recover work when browser storage rejects a save
    Given a learner has a correction and reason ready for review
    When the browser rejects the save
    Then the status says Not saved
    And editing still shows the typed correction and reason
    And downloading the work includes those exact texts
    And no account or server save is claimed

  Scenario: PROTO-006 — Report an unreadable local draft without replacing it
    Given this prototype's saved Everyday record is malformed
    When the learner opens the walkthrough
    Then the first step remains usable
    And the status says the saved practice could not be restored
    And the malformed stored record remains unchanged until an explicit save

  Scenario: PROTO-007 — Label worked examples and keep self-check separate from grading
    Given a learner chooses Use the worked request
    When they continue to the correction and comparison steps
    Then the origin of their request is still identified as a worked example
    And short free writing is not rejected merely for its length
    And criteria are offered as a self-check without an automatic mastery claim

  Scenario: PROTO-008 — Reassess work after editing its text
    Given a learner checked all three criteria for a revised answer
    When they edit the request, correction or revision reason
    Then the earlier self-check marks are cleared
    And their changed writing remains available
    And the status does not claim the changed work has been saved
