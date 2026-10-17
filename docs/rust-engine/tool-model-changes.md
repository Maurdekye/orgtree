# Model changes in transcript tool chips

Successful `orgtree_switch_model` and `orgtree_retool` results can carry a
recorded model transition. The applied switch result records `previous_tier`
from the locked node alongside `tier`. Queued and unchanged switches do not
claim an applied transition. Ordinary retool calls do not change the tier and
therefore do not acquire a model transition merely because input names one.

The shared transcript projector reads the complete successful result before
clipping and stores `model_change: {from, to}` on that agent's tool reference.
`from: null` means an older result did not record the before-state. Input and
the current tree never supply a historical model. Refusals, malformed results,
queues, no-ops and staffing calls do not produce this metadata.

The agent link keeps its current model and navigation. Historical cards use
the existing `TierChip`, without a current agent identity tooltip. The user's
compressed layout (2026-10-17 23:01Z) is:

| Old model known | Agent still on the recorded new model | Display |
| --- | --- | --- |
| Yes | Yes | Old card → agent link |
| Yes | No | Old card → recorded new card, agent link |
| No | Yes | Agent link |
| No | No | → recorded new card, agent link |

If the current directory cannot resolve an agent, the recorded cards remain
beside an inert name. Missing current facts cannot remove the recorded new
card. Historical cards never read today's model or tooltip to fill old facts.
Clicks on the cards do not expand the tool; the agent link retains its own
focus/menu behavior. Hire/staff rows retain their existing presentation.

Focused coverage lives in `modelchange.test.tsx` (all four layouts, reload,
suppression and navigation) and `runtime/convo_model_tests.rs` (recorded result
facts, legacy unknown before-state and negative controls). The synthetic
`modelchange-fixture.tsx` captures the real tool chip in all four states.
