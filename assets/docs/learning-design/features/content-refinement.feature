# Design specification for #549. These scenarios have not been executed as tests.
# IDs do not alter the approved L-series journey register.
Feature: Create and refine content that teaches an observable skill
  Authors improve a local lesson using sources, worked examples and learner actions.

  Scenario: CREF-001 — Start with an outcome and a useful artifact
    Given an author is drafting the lesson "Write a useful request"
    When they define what the learner will do
    Then the outcome is "write a request with facts, output shape, limits and a check"
    And the artifact is the request kept beside its source
    And Everyday, Work and Technical examples teach that same outcome
    And no job title, coding background or paid plan is required

  Scenario: CREF-002 — Reject an answer key that confuses unknown with contradicted
    Given Source E3 says the budget is undecided
    And the draft key for L3-E-P3 classifies "$200 budget" as "Contradicted"
    When the editor checks the key against the source
    Then they request "Not given" with an explanation that no amount is established
    And the author checks the related explanation and fresh-case key for the same error
    And the local preview uses the corrected key

  Scenario: CREF-003 — Explain the learner's actual wrong choice
    Given L2-W-P offers "give every task next Tuesday as its date"
    When the author writes feedback for that choice
    Then it explains that Tuesday belongs to the process test
    And it instructs the learner to keep other missing dates "not specified"
    And it does not only say "wrong" or reveal an unrelated answer

  Scenario: CREF-004 — Test the skill on a genuinely fresh case
    Given Lesson 2 teaches a request from community-activity notes
    When the author adds transfer case L2-E-X
    Then it uses the seed-swap source with six helpers, forty packets and one hour
    And it requires a new request that preserves the missing location and start time
    And a rubric accepts different wording that preserves those constraints
    And reordering the earlier multiple-choice answers is not accepted as transfer

  Scenario: CREF-005 — Make routine editorial decisions without another owner gate
    Given an ordinary foundation draft uses original invented examples
    And its outcome, answer keys, rights statement and next action are checked
    When the assigned editor records the local editorial outcome
    Then the draft can be marked "ready for local preview"
    And no new owner or qualified-expert approval is requested for that wording decision
    And an author self-check is identified as a self-check
    And this state does not publish content or bypass existing staff permissions

  Scenario: CREF-006 — Turn a review comment into a verifiable revision
    Given a review says L2-E-P does not make simultaneous staffing inspectable
    When the author revises the worked request and question feedback
    Then the new draft asks for volunteers needed at the same time
    And the change note names the affected question and the reason
    And a local comparison shows the old and new wording

  Scenario: CREF-007 — Keep authoring when one source has uncertain reuse rights
    Given a draft exercise includes a third-party passage with unclear reuse permission
    When the author prepares the local reading package
    Then that passage is excluded or replaced by an original invented source
    And its uncertain rights are recorded in the author notes
    And the other original lesson material remains available for refinement
    And no private member work is copied into the replacement example

  Scenario: CREF-008 — Preview the whole teaching loop in every route
    Given a lesson has Everyday, Work and Technical variants
    When its author reviews the local preview of each variant
    Then the source, example, attempt, choice-specific feedback and hint are inspectable
    And a distinct fresh case and its rubric are inspectable
    And the learner can identify the artifact to keep and the next lesson
    And production setup is not a prerequisite for this review

  Scenario: CREF-009 — Adopt a revised lesson without rewriting past work
    Given a learner's submission refers to lesson version 1 and rubric version 1
    And a corrected lesson version 2 has been adopted for new work
    When the learner opens their earlier submission
    Then it still identifies the exact lesson and rubric versions used
    And the corrected version is offered as a separate next action
    And the earlier answer is not silently regraded or relabelled as version 2

  Scenario: CREF-010 — Retire confusing material while preserving truthful history
    Given a lesson is withdrawn from new learning recommendations
    And a member has retained private work based on that lesson
    When the member views their learning history
    Then the earlier work identifies the version used and its retired state
    And the retired lesson is not recommended as a new lesson
    And any replacement is identified separately
    And existing account and source deletion rules still apply

  Scenario: CREF-011 — Keep a competing editorial revision intact
    Given an editor opened draft revision 3
    And another editor has saved revision 4
    When the first editor tries to save changes based on revision 3
    Then the current revision is not silently overwritten
    And the editor can compare and reconcile their text with revision 4
    And no successful save is shown until the reconciled revision is stored
