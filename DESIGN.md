---
name: "Deep Native local learning reader"
description: "The implemented visual system for source-grounded practice and private browser notebooks."
colors:
  ink: "#172c46"
  muted: "#51647c"
  paper: "#f5f7fb"
  surface: "#ffffff"
  surface-subtle: "#edf2f8"
  line: "#d9e2ee"
  line-strong: "#afbed1"
  blue: "#2459d6"
  blue-hover: "#1845b0"
  blue-soft: "#eaf0ff"
  navy: "#17365f"
  green: "#18715c"
  green-soft: "#e9f5ef"
  teal: "#146576"
  teal-soft: "#eaf5f7"
  amber: "#875619"
  amber-soft: "#fff4e3"
  focus: "#174dbb"
  source-line: "#bddce2"
  repair-line: "#dfbf8c"
  checked-line: "#a5d5bd"
  on-navy-muted: "#dce8f7"
typography:
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "2rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  headline-mobile:
    fontFamily: "Inter, sans-serif"
    fontSize: "1.7rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  resume-title:
    fontFamily: "Inter, sans-serif"
    fontSize: "1.8rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Inter, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  lesson-title:
    fontFamily: "Inter, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  subtitle:
    fontFamily: "Inter, sans-serif"
    fontSize: "1.075rem"
    fontWeight: 720
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.6
  lesson-body:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  lesson-body-mobile:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.7
  button-label:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 680
    lineHeight: 1.5
  nav-label:
    fontFamily: "Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.6
  field:
    fontFamily: "Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  source-body:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  status-label:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.6
  code:
    fontFamily: "ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  status: "6px"
  step: "9px"
  control: "10px"
  choice: "12px"
  surface: "14px"
spacing:
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
  "14": "14px"
  "16": "16px"
  "18": "18px"
  "20": "20px"
  "22": "22px"
  "24": "24px"
  "26": "26px"
  "28": "28px"
  "30": "30px"
  "40": "40px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.surface}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-primary-hover:
    backgroundColor: "{colors.blue-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.blue}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
  button-secondary-hover:
    backgroundColor: "{colors.blue-soft}"
  button-text:
    textColor: "{colors.blue}"
    padding: "8px 0"
  writing-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "16px"
    width: "100%"
  main-navigation:
    textColor: "{colors.muted}"
    typography: "{typography.nav-label}"
    rounded: "{rounded.control}"
    padding: "12px 14px"
  main-navigation-current:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
  route-option:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.step}"
    padding: "8px 16px"
  route-option-selected:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
  notebook-status:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.muted}"
    typography: "{typography.status-label}"
    rounded: "{rounded.status}"
    padding: "5px 10px"
  source-card:
    backgroundColor: "{colors.teal-soft}"
    textColor: "{colors.ink}"
    typography: "{typography.source-body}"
    rounded: "{rounded.surface}"
    padding: "20px"
  answer-feedback:
    backgroundColor: "{colors.amber-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.choice}"
    padding: "20px"
  answer-feedback-positive:
    backgroundColor: "{colors.green-soft}"
  answer-choice:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.choice}"
    padding: "16px 18px"
  answer-choice-selected:
    backgroundColor: "{colors.blue-soft}"
  answer-choice-correct:
    backgroundColor: "{colors.green-soft}"
  answer-choice-reconsider:
    backgroundColor: "{colors.amber-soft}"
  lesson-stage:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.muted}"
    rounded: "{rounded.step}"
    padding: "10px 5px"
  lesson-stage-current:
    backgroundColor: "{colors.blue-soft}"
    textColor: "{colors.blue}"
  lesson-surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "26px 30px 0"
  resume-panel:
    backgroundColor: "{colors.navy}"
    textColor: "{colors.surface}"
    rounded: "{rounded.surface}"
    padding: "28px 30px"
  resume-action:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.navy}"
    typography: "{typography.button-label}"
    rounded: "{rounded.control}"
    padding: "11px 18px"
---

# Design System: Deep Native local learning reader

## Overview

**Creative North Star: "The Working Notebook"**

The Working Notebook is calm, explicit and practical. Cool paper surrounds white working surfaces; deep navy gives the current lesson a clear entry point. Blue connects actions and current position, while source context and checked responses have their own restrained colors. The reader uses familiar controls, named navigation and compact stroke icons so its authored examples and the learner’s writing carry the experience.

This is a code-derived record of assets/docs/learning-design/reader, captured on 28 October 2026. It covers this local reader only. It does not establish a visual migration of the hosted application or a production release. PRODUCT.md records product constraints; .impeccable/surfaces/assets-docs-learning-design-reader.md owns the surface direction. The tokens below describe the implemented CSS, with literal reused values extracted where no CSS custom property exists.

**Key Characteristics:**

- A single self-hosted sans family with a compact, deliberate hierarchy.
- Flat surfaces distinguished by tone, fine borders and open spacing.
- Named learning, practice and private-work destinations with visible current state.
- Explicit saving and evidence-based status labels beside the work they describe.

## Colors

The palette uses cool neutrals and a distinct color for each kind of interaction. The frontmatter is the normative value list; names below explain application without redefining those values.

### Primary

- **Action blue** (`blue`, `blue-hover`, `blue-soft`): actions, selected routes, current navigation, current stages and the lesson progress bar.
- **Anchor navy** (`navy`): the resume panel and brand text. `on-navy-muted` supports secondary text within that panel.
- **Focus blue** (`focus`): the visible keyboard outline, separate from a selected control’s border.

### Secondary

- **Source teal** (`teal`, `teal-soft`, `source-line`): source cards, applied-case context and the return from targeted practice.

### Tertiary

- **Checked green** (`green`, `green-soft`, `checked-line`): a selected answer that matches the supplied source and the self-check control.
- **Repair amber** (`amber`, `amber-soft`, `repair-line`): checked responses that need reconsideration and explicitly flawed teaching samples.

### Neutral

- **Reading ink** (`ink`) and **supporting slate** (`muted`): primary content and explanatory labels.
- **Cool paper** (`paper`), **white surface** (`surface`) and **soft inset** (`surface-subtle`): page, work regions and secondary control backgrounds.
- **Fine line** (`line`) and **control line** (`line-strong`): dividers and interactive boundaries.

**The Semantic Color Rule.** Use blue for action and current position, teal for source context, green for a checked match, and amber for reconsideration. Pair these colors with explanatory text; color alone does not carry the result.

## Typography

**Display and body family:** Inter, with sans-serif fallback. The variable font is self-hosted at `assets/docs/learning-design/reader/fonts/InterVariable.woff2`, with weights (100–900), normal style, optical sizing and `font-display: swap`. The adjacent `LICENSE.txt` and `provenance.json` retain the SIL Open Font License and pinned upstream provenance. No remote font request is needed. Inline code alone uses a monospace fallback.

Page headings use the `headline` role, resume headings `resume-title`, section headings `section-title`, and authored lesson headings `lesson-title`. They share compact negative tracking and a strong variable weight. Body and lesson-body roles differ in leading, allowing exercise prose more breathing room. Button, navigation, source and status roles retain their own observed sizes instead of imposing a new mathematical scale.

At the mobile breakpoint, page headlines use `headline-mobile`, ordinary section headings reduce to (1.3rem), lesson headings to (19px), and lesson prose to `lesson-body-mobile`. Writing fields remain at `field`. Main lesson paragraphs are limited to (72ch); page descriptions use (65ch). Status and auxiliary labels use smaller type without taking over the content hierarchy.

**The Readable Work Rule.** Keep writing fields at the implemented body size on small screens, preserve visible field labels, and keep paragraphs narrow enough to scan alongside their source.

## Layout

The desktop shell uses a sticky, independently scrollable left rail (220px) and a flexible main region capped at (1500px), with main horizontal padding (40px). Learn uses a main path and activity context column (260px), separated by a gap (28px). A lesson uses a white working article and source column (270px), also separated by (28px). The source column is sticky at (24px) while wide; the learner can also use “Check the source” and “Back to exercise” controls.

The lesson-only topbar is sticky at the top with stacking level (3). It carries notebook status, the browser-only location and “Save notebook”; the footer retains the full save/download actions and earlier-notebook recovery. The topbar is at least (76px) on desktop and (68px) on mobile. This is an explicit save control; its fixed presence is not an autosave promise.

Responsive changes are implemented at three maximum-width breakpoints:

| Width  | Implemented change                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1180px | Main padding becomes 28px; lesson source column becomes 230px with 20px gap; the Learn context moves below the path; footer save actions stack.                                                                                                             |
| 1000px | Rail becomes 200px; lesson and source become one main column; source/notebook context uses two columns; feedback and review criteria stack.                                                                                                                 |
| 720px  | The rail becomes a top navigation with three named destinations; course contents can expand below it. Main padding becomes 20px. The source and notebook stack; lesson article padding becomes 18px 16px 0; contribution fields and work/review rows stack. |

The four lesson stages remain visible as a four-column control at every size. Course rows place their action below their text on mobile. Tables scroll within their own containers; source text, notebook records and work previews wrap long content. Spacing is an observed set of reused values, not a forced single-step scale.

## Elevation & Depth

The reader is flat at rest. Background tones, borders and whitespace establish hierarchy; the current lesson stage adds a blue inset underline (2px). Keyboard focus uses a solid blue outline (3px) with offset (4px). The stylesheet declares an ambient `--shadow` value but does not apply it to a component; it is deliberately not promoted into this system’s elevation vocabulary.

**The Flat Surface Rule.** Use tonal fills and fine borders to separate regions. The active stage’s inset underline is a state indicator, not elevation.

## Shapes

Main working and context panels use `surface` rounding; answer choices, details and feedback use `choice`; buttons, textareas and main navigation use `control`; route and stage controls use `step`; status labels use `status`. Borders are fine (1px). Circular stage numerals are sequence markers. Compact inline SVGs use geometric strokes (1.8px) and normally occupy (20px); they accompany meaningful text. The brand’s `dn` text mark is retained.

## Components

### Buttons

Primary actions use blue with white labels; hover uses the deeper action blue. Secondary actions use white, a strong neutral border and blue text; hover adds a pale blue surface and blue border. Both share `button-label`, a minimum height (46px), and the recorded `control` rounding. Text buttons keep a transparent background and blue label with a minimum height (44px). The resume action reverses to white on navy. Mobile primary/secondary labels become (13px) with padding (10px 14px).

Background changes and button presses transition over (0.16s); pressed primary and secondary actions move down (1px). Disabled buttons use opacity (0.5) and a default cursor. Reduced-motion preferences remove these transitions and press transforms. Visible keyboard focus retains the shared outline.

### Route options and notebook status

Everyday, Work and Technical form a wrapping selection group. The selected option uses a blue border and pale-blue fill with `aria-pressed`; the group has a visible “Your examples” label. It selects example context, not a privilege or paid tier. Notebook status is a passive neutral badge with plain language such as “Unsaved changes”; it is not a success medal. Save errors remain explained in the status text.

### Sources and feedback

Source cards use teal-tinted surfaces, a fine source border and readable wrapped text. Their heading is a functional source label. Checked answer feedback uses amber by default and green for a matching response, always with an explanatory message and the learner’s selected answer. Supplied teaching samples and free-writing self-checks stay explicitly labelled.

### Inputs and choices

Writing fields have visible labels, a white surface, strong neutral border, `control` rounding and vertical resizing, with a minimum height (150px). Radio options are full-width rounded rows with a native radio control. Hover and selection use blue; after checking, the selected option uses green or amber as appropriate. Checkbox self-checks record the learner’s judgment. The disabled self-check cannot be used before its required writing exists.

### Navigation and lesson stages

Learn, Practice and My work use named buttons with geometric SVG icons. Hover adds a subtle surface; `aria-current="page"` gives the active destination a pale-blue background and blue label. Course contents is a disclosure with individual lesson names and actual notebook states. Four stage controls use `aria-current="step"`; their active underline and filled numeral identify position. The blue progress bar reports the current step out of four, not performance.

### Resume, practice return and private work

The navy resume panel offers the current lesson or applied case with a single continuation action. Course rows expose all six lesson names and a specific activity state. Practice lists checked answers that need another look and lets the learner choose any skill. My work lists retained drafts and decisions, then links back to the relevant writing stage. Final-review help targets a criterion’s practice; its teal return panel keeps the route back to the preserved final record explicit.

**The Explicit Notebook Rule.** Keep the save action and browser-only storage explanation together. A navigation change or typed draft must not be styled as proof of a successful save.

The sidecar contains isolated visual specimens of implemented components; these do not execute saving, routing, answer evaluation or notebook recovery. Its eight-step tonal ramps are generated previews, not additional application color tokens. The source evidence is `style.css`, `reader.mjs`, font provenance, and the supplied desktop, mobile, lesson and reduced-height mobile save captures under `.impeccable/review/`. The latest review disposition applies only to the reachable-save, typography and blue-progress fixes; this document does not extend it to whole-surface or production acceptance.

## Do's and Don'ts

### Do:

- Do keep source context visually distinct and reachable from the exercise.
- Do preserve named controls, visible keyboard focus, and text descriptions of current state.
- Do keep the primary lesson save action reachable while the learner writes.
- Do describe progress using checked practices, written lessons, recorded self-checks, and the current step.
- Do retain separate route drafts and the distinction between a first draft and its revision.

### Don't:

- Don’t style self-checks or activity counts as mastery, grades, credentials, or independent review.
- Don’t imply automatic saving, account synchronization, public sharing, or a contacted reviewer.
- Don’t promote these local reader tokens into a claim that the hosted application has been restyled.
