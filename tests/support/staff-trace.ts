// Specs that sign staff in keep traces off in ordinary runs, so a synthetic
// staff credential is never written to a trace by default.
//
// The full-release runner (scripts/verify-full-release.mjs) requires one trace
// archive for every execution and sets DNE_FULL_RELEASE_RUN_ID. Only in that
// run are these traces recorded. The staff credentials in them are random,
// exist only in that run's throwaway test databases, which are dropped when
// the tests and the run end, and expire within a day. Release traces stay in
// the ignored artifacts/ folder on the machine that ran them. Never commit,
// attach or upload them. Nothing in them works against a hosted site or any
// lasting database, and no GitHub workflow runs the release runner.
export const staffTrace: "on" | "off" = process.env.DNE_FULL_RELEASE_RUN_ID
  ? "on"
  : "off";
