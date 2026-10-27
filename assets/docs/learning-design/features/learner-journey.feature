# Design specification for #549. Consult traceability.md for narrower existing evidence.
Feature: Learn by trying, correcting and applying a skill

  Scenario: LEARN-FLOW-001 — Choose relevant examples without an admission barrier
    Given a learner wants to improve an everyday task
    When they choose Everyday examples
    Then they see the outcome "choose a task you can check"
    And they can begin with the supplied community-activity source
    And no job title, code sample or purchase is required

  Scenario: LEARN-FLOW-002 — Show one useful next action
    Given a learner has saved a Lesson 1 source, task and check
    When they return to the foundation path
    Then the recommended action is "Write a useful request"
    And it explains that their saved task is the starting point
    And they can still revisit Lesson 1 or change example route

  Scenario: LEARN-FLOW-003 — Show an example before asking for original work
    Given a learner has not written a request before
    When they open Lesson 2
    Then they can read its source and a complete worked request
    And the explanation identifies context, task, shape and limits, and check
    And the next primary action is to try a repair question

  Scenario: LEARN-FLOW-004 — Correct a specific misconception
    Given the learner is answering L2-W-P with Source W2 visible
    When they choose "give every task next Tuesday as its date"
    Then feedback explains that Tuesday is the process test date
    And missing task deadlines remain "not specified"
    And the learner can revise their choice without losing their private draft
    And this wrong answer is not recorded as a completed skill

  Scenario: LEARN-FLOW-005 — Offer a hint without inventing progress
    Given a learner has not answered L3-E-P3
    When they ask for a hint
    Then the hint asks them to find an incompatible fact or confirm that none is given
    And the source remains visible
    And using the hint does not itself mark the answer correct or the lesson complete

  Scenario: LEARN-FLOW-006 — Apply the same skill to new facts
    Given a learner has corrected the community-plan request in Lesson 2
    When they open the fresh case L2-E-X
    Then they receive the seed-swap source with six helpers and forty packets
    And they write a new request with location and start time unconfirmed
    And comparison feedback checks the new source rather than the earlier twelve-volunteer case

  Scenario: LEARN-FLOW-007 — Distinguish a contradiction from a missing fact
    Given Source E3 says twelve volunteers and an undecided budget
    When the learner classifies "fifteen volunteers" and "$200 budget"
    Then "Contradicted" is the correct classification for fifteen volunteers
    And "Not given" is the correct classification for the budget
    And feedback names the source fact or missing information for each claim
    And the repair retains twelve volunteers and leaves the budget open

  Scenario: LEARN-FLOW-008 — Evaluate free writing with criteria rather than length
    Given a learner wrote a short request with correct facts, clear output and a source check
    When they review the Lesson 2 self-check
    Then each criterion asks them to point to evidence in their own request
    And different wording can satisfy the criteria
    And no automatic mastery score follows from character count or checkbox completion
    And a missing criterion leads to a specific revision suggestion

  Scenario: LEARN-FLOW-009 — Recover from a failed save without false success
    Given a learner has typed a request and checking plan
    When saving fails before persistence is confirmed
    Then the page does not say the draft was saved
    And the typed work remains available for retry or copying
    And reopening from another session shows only the last confirmed saved version

  Scenario: LEARN-FLOW-010 — Resume honestly after leaving a lesson
    Given a learner saved their own-work draft after completing a practice question
    When they leave and return to the same saved account
    Then the saved writing is available
    And the page identifies the last persisted lesson step if one was saved
    And if question position was not saved it says practice restarts at the beginning
    And it does not invent a prior correct answer or claim unsaved text was recovered

  Scenario: LEARN-FLOW-011 — Change goals without moving or erasing past work
    Given a learner has an Everyday draft and an open Everyday practice form
    When they change their goal to Work and submit the old practice form
    Then the stale form asks them to reopen the current example
    And the Everyday draft remains associated with its original goal and version
    And Work examples do not inherit the earlier answer as a completed attempt

  Scenario: LEARN-FLOW-012 — Handle a changed lesson version explicitly
    Given a learner opened a version 1 practice question
    And the current lesson has changed to version 2
    When they submit the retained version 1 form
    Then it is not graded against the version 2 answer key
    And the learner gets an explicit route to the current lesson
    And saved version 1 work is not silently rewritten

  Scenario: LEARN-FLOW-013 — Describe self-reported completion truthfully
    Given a learner has written a corrected draft and reviewed its criteria
    When they choose to finish their own exercise
    Then progress describes it as self-checked or self-reported completion
    And opening pages or revealing example answers alone does not complete the exercise
    And no formal proficiency, credential or independent review is claimed

  Scenario: LEARN-FLOW-014 — Keep private learning work private
    Given one member has a saved source, request and corrected draft
    When another member tries to open that work using its address
    Then no private text or answer history is disclosed
    And choosing a common learning goal grants no access to another member's work
