export function syntheticSeed() {
  return {
    label: "Synthetic demo data — never a live member or provider record",
    members: [
      {
        id: "member-general-example",
        address: "general.learner@example.invalid",
        background: "explorer",
        goals: ["everyday", "work"],
        membership: "foundation",
        payment: "none",
      },
      {
        id: "member-professional-example",
        address: "non-it.professional@example.invalid",
        background: "professional",
        goals: ["work", "everyday"],
        membership: "foundation",
        payment: "none",
      },
      {
        id: "member-technical-example",
        address: "it.practitioner@example.invalid",
        background: "technical",
        goals: ["build", "work"],
        membership: "test-coaching",
        payment: "test-paid",
      },
    ],
    staff: [
      { id: "coach-assigned-example", role: "coach", assignment: "assigned" },
      { id: "coach-revoked-example", role: "coach", assignment: "revoked" },
      {
        id: "reviewer-assigned-example",
        role: "reviewer",
        assignment: "assigned",
      },
      { id: "editor-example", role: "editor", assignment: "not-applicable" },
      {
        id: "moderator-example",
        role: "moderator",
        assignment: "not-applicable",
      },
      {
        id: "operator-example",
        role: "operator",
        assignment: "not-applicable",
      },
    ],
  } as const;
}
