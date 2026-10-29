# Design specification for #549. Existing source-bound feedback is reused where suitable.
Feature: Turn feedback into a reasoned revision

  Scenario: WORK-FLOW-001 — Request feedback on an exact saved version
    Given a learner has saved version 1 of "Fifteen volunteers meet at the library"
    And the feedback request shows which version and reader access are involved
    When the learner deliberately requests feedback on that version
    Then the request refers to version 1 and its original lesson source
    And subsequent edits do not silently change the requested version
    And saving a private draft alone does not request feedback or grant a reader access

  Scenario: WORK-FLOW-002 — Make feedback concrete and identify its origin
    Given feedback concerns the version 1 draft based on Source E3
    When the learner reads the response
    Then it says the source specifies twelve volunteers and leaves the venue undecided
    And it suggests correcting the count and marking the venue to be confirmed
    And it identifies whether the response is sample guidance or a person's feedback
    And it does not describe sample guidance as qualified formal assessment

  Scenario: WORK-FLOW-003 — Let the learner ask for clarification or disagree with evidence
    Given feedback proposes a change the learner does not understand
    When the learner asks which source phrase supports that change
    Then the clarification remains attached to the same feedback and source version
    And the learner can keep a different answer with a source-based reason
    And agreement with the feedback is not required to save their own revision

  Scenario: WORK-FLOW-004 — Preserve before, after and the reason for a change
    Given version 1 says "Fifteen volunteers meet at the library"
    And feedback points to twelve volunteers and an undecided venue in Source E3
    When the learner saves "Twelve volunteers are available; venue to be confirmed"
    And explains "I matched the count and removed the assumed venue"
    Then a new version retains that corrected text and revision reason
    And version 1 and its feedback remain identifiable as the earlier version
    And the learner can compare the two without overwriting the submission

  Scenario: WORK-FLOW-005 — Recognise feedback about an older version
    Given feedback on version 1 asks for a corrected count
    And the learner already corrected that count in version 2
    When they open the feedback from their current work
    Then its version 1 scope is visible
    And they can record "already addressed in version 2" with the relevant change
    And version 2 is not described as having received a new review

  Scenario: WORK-FLOW-006 — Withdraw access while retaining the owner's allowed history
    Given the learner deliberately granted access to one saved sample
    And feedback was published to the learner before withdrawal
    When the learner withdraws that access
    Then new reviewer reads and exchanges for that grant are denied
    And previously published feedback remains visible to the owner under the existing retention rules
    And withdrawal does not turn the private sample into public lesson content

  Scenario: WORK-FLOW-007 — Keep a failed revision save recoverable
    Given version 1 and its feedback are saved
    And the learner has typed a correction and revision reason
    When saving the new version fails
    Then version 1 and its feedback remain unchanged
    And the correction and reason remain available for retry or copying
    And the page does not claim a new saved version or a completed review
