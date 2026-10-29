# Authored teaching examples for #34, not live AI or an automatic writing grade.
Feature: Improve a request through source-grounded follow-up
  Learners use supplied conversations to revise their own private practice.

  Scenario: DIALOGUE-001 — A hint leads to a supported repair and a reason
    Given the Everyday, Work or Technical fresh source from Lesson 2
    And an invented learner request makes a specific unsupported claim
    When the learner reads the supplied guide hint and tries a repair
    Then the worked reply identifies the relevant source fact or gap
    And the revised request retains supported details and removes the assumption
    And the learner explains why that change makes the request checkable

  Scenario: DIALOGUE-002 — Ask for missing evidence before judging a revision
    Given a learner says they improved a request without showing the new wording
    When the supplied guide responds
    Then the guide asks for the request and the source detail being checked
    And it does not say the unseen revision is correct or complete

  Scenario: DIALOGUE-003 — Continue useful work without inventing a fact
    Given the learner asks for a venue, deadline or input limit absent from the source
    When the supplied guide responds
    Then the response identifies the unsupported claim
    And it offers a supported draft or a specific clarification question
    And it does not record the missing fact as agreed or observed

  Scenario: DIALOGUE-004 — Keep supplied dialogue separate from the learner's writing
    Given the learner has written an initial request in the existing fresh-case field
    When they open a worked conversation and its comparison
    Then the teaching replies are labelled as supplied examples
    And their writing is not replaced or automatically graded
    When they retain their attempt, repair and reason and explicitly save
    Then the local notebook can restore and download those exact words
    And earlier content versions remain separately recoverable
