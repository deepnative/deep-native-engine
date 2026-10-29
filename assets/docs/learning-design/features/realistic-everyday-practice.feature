# Original fictional planning case; no real invitation, booking or attendance claim.
Feature: Plan a useful neighbourhood event from changing notes

  Scenario: REAL-EVERY-001 — Correct an outdated invitation from the current booking
    Given an old invitation and an explicit replacement venue note
    When the learner drafts a reminder for confirmed guests
    Then it uses the current room and guest arrival time
    And setup access is not substituted for guest arrival

  Scenario: REAL-EVERY-002 — Count confirmed, reserved and waiting people separately
    Given confirmed guests, two helpers, a waitlist and a twenty-person room limit
    When the learner checks the attendance plan
    Then helpers count toward the room limit
    And a waitlist or pending invitation is not counted as confirmed attendance

  Scenario: REAL-EVERY-003 — Make a feasible plan from upper bounds
    Given each confirmed guest may bring up to three books and display space is limited
    When the learner writes a materials checklist
    Then it calculates maximum incoming books rather than promising that total
    And a feasible display and holding plan is explained
    And different plans can satisfy the same capacity constraints

  Scenario: REAL-EVERY-004 — Revise after cancellations and partial replies
    Given two cancellations, one accepted replacement and one reply still pending
    When the learner revises the reminder and internal checklist
    Then confirmed people, the reserved place and remaining waitlist are separate
    And the first draft and revision reason remain identifiable
    And the next action checks the reply deadline before offering the reserved place again

  Scenario: REAL-EVERY-005 — Preserve the learner's plans and source packet
    Given an initial reminder and a later revised plan with a reason
    When supplied comparisons are opened and the notebook is explicitly saved
    Then the learner's wording is retained through save, download and reload
    And downloads include the source notes and later update
    And edits clear the applicable self-check while earlier notebooks stay separate
