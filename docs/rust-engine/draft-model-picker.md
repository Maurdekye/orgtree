# Model selection before a manual hire

The uninitialized canvas draft previously displayed a passive model token.
Clicking that icon opens the same `SpawnChips` hire-token pyramid used off a
node and in Quick chat. It replaces the plain tier menu after the user's
2026-10-17 19:29Z feedback on the original 2026-10-16 request, for 4.4.0.
Choosing a token changes the model that final Hire submits.

The draft remains mounted. Its name, manual charter, charter presets, grant,
parent and sibling/superior placement survive a model choice. Its provider
theme, icon and credit-bar seat update from the selected tier. Escape closes
the picker before the draft's own Escape-to-cancel handler. Keyboard button
activation, token focus and Tab navigation remain available. Closing restores
focus to the draft's model icon. The popup shares Quick chat's own-document
portal, outside-press/Escape dismissal and pointer-leave behavior.

Choices use `SpawnChips` directly, including provider presence, enabled/sign-in
state, legacy/conditional models and dynamic OpenRouter/language-server tiers.
The picker consumes existing availability state; it begins no discovery load.
Disabled choices show the existing reason. Final Hire remains authoritative
for current availability, entitlement, account, permissions and credit checks.
Neither opening the menu nor choosing a tier performs an engine mutation.

Staged folders, tools and visibility remain unchanged. Changing provider drops
the previous account binding; known target staffing offers also exclude an
incompatible binding. A known unsupported effort maps by the effort bar's
ordering (highest at or below the old level, else lowest); a model with no
effort setting clears the override. Unknown support keeps the staged value,
subject to final admission. The obsolete Luna-only pool preference is omitted
when the target is not Luna. Draft permissions can edit the new proposal.

`OrgCanvas` updates only `draft.tier`, preserving relationship information.
Its existing finalization handles ordinary, sibling and superior hires and
the undo-history composite path; no engine implementation changes are needed.

Focused evidence comes from `uninitmodel.test.tsx` and the synthetic
`tools/rig/proofs/uninit-model.mjs` renderer-to-engine proof. The latter uses
fake CLIs and an isolated scratch database, saves before/picker/after PNGs,
and checks that only the selected model is created by final Hire. Verification
receipts and limitations are recorded on the docket item
`change-the-model-of-an-uninitialized-manual-hire`.

The proof accepts an already seeded organization: it snapshots persisted agent
identities, generations, parents, tiers, charters, states and grants before
opening the draft. Engine reads before and after model selection must match
that snapshot exactly. Final Hire must leave every existing row unchanged and
add exactly one new live top-level `selected-sol` with the selected tier and
original charter. Its grant must equal the effective `default_top_grant` read
from the engine before opening, unchanged through selection; neither an empty
organization nor a fixed grant is implicit. All five check names and the three
picker/draft positive checks remain unchanged. [verified: 2026-10-22,
`tools/rig/proofs/uninit-model.mjs`, `tools/rig/desktop/uninit-model.cjs`]
