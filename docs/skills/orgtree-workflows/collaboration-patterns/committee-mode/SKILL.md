---
name: orgtree-committee-mode
description: Run independent proposals and supervisor-led revision rounds across different models to reach consensus or an undetermined result.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Committee mode

Use this procedure when the user asks for a design, plan or answer **by committee**. It is an organising workflow carried out through ordinary staffing, mail and records. A request for a committee answer does not authorize implementing its proposals.

## Staff the committee

**The canonical host is a dedicated project node for the committee.** The supervisor creates it under their seat with `orgtree_project` (`action=create`) or **New project…**. In **Project Settings**, switch **Subordinates may message each other** OFF and save before members begin. Hire every member directly under that project (`parent=<project>`); place reused members directly under it too. Members report to the nearest agent above the project, the committee's supervisor, and send their committee proposals and clarifying questions only to that supervisor.

The supervisor, usually the coordinator, chooses several members. Honour any members or models the user specifies. **Every member must use a different model**: two accounts running the same model do not supply the required diversity. Check current availability, account eligibility, capacity and the applicable model-placement instructions rather than treating a template or an old model list as permission to use a model.

Inspect existing live and archived expertise before hiring; reuse or rehire suitable members when possible. Give each the same question, the same materials, a clear reporting supervisor, the round limit and the communication rule below. A new hire needs its actual first task in `kickoff`; an existing member needs its task by mail. Do not copy another member's draft into a kickoff or expose it through shared working files.

Keep a docket item or supervisor-owned file containing the question, members and their models, current round, answers and the consensus verdict with reasons. The default maximum is **10 rounds**, counting the initial independent proposals as round 1. The user may set a different limit.

## Proposals and revised rounds

1. **Independent proposals.** Each member answers the question alone and sends its answer only to the supervisor. The supervisor mails members individually and collects the complete round before sharing any drafts.
2. **Consensus check.** The supervisor judges whether the members have reached consensus. If yes, deliver the single consensus answer to the user and record the verdict. Do not turn a majority preference into a claim of consensus.
3. **If there is no consensus and rounds remain,** send the full set of that round's answers to every member. Say that consensus has not been reached and request a revised proposal addressing the other answers. Do not send different subsets to different members.
4. **Revised proposals.** Each member sends the supervisor its current answer, then states for each other member's answer what it adopts, what it rejects and why. The supervisor checks consensus again and repeats only while rounds remain.

**No member-to-member contact in any round.** The only shared material is the full set of previous-round answers distributed by the supervisor. Clarifying questions go to the supervisor, who gives the same clarification to all members. Do not grant or use a lateral audience to bypass this workflow's independence rule. The supervisor returns members' answers and clarifications without claiming that a peer message supplies new authority.

On Orgtree 4.4, this project setting defaults on, applies only to the project's direct children and is not inherited. Keeping every committee member directly under the same committee project puts member-to-member mail behind its OFF setting; cross-project reporting peers are unaffected. Off also hides those siblings' lateral connector lines.

A directional audience can normally authorize mail through this block, and the nearest agent supervisor can grant one between its direct reporting siblings. **Do not grant or use that exception for committee member contact.** Requests and supervisor/subordinate communication remain available; send committee clarifications to the supervisor. The switch helps enforce the workflow, but an existing audience or a different actual parent can still permit mail technically. Check placement and audiences when staffing rather than treating Off as proof of complete isolation.

At the round limit, if there is still no consensus, leave the answer **UNDETERMINED**. Explain where the members remain split and the assumptions or values behind each position. Identify ambiguity or missing constraints in the question and suggest how it could be re-posed. Do not choose a winner or merge incompatible proposals into a supposed decision.

## Supervise without repeated status queries

Read reports and their recorded work before asking for status. Let completed proposals arrive by mail; for an observable external condition, use a persistent one-shot watchdog when available. Keep the round record current and do not leave background work tied to a turn that has ended. Finishing the committee's answer does not silently widen the task into implementation.

The procedure records the approved committee rules of 2026-10-16, including supervisor-only communication during revisions and the undetermined outcome at the limit, plus canonical project hosting with peer mail OFF (user 2026-10-17 22:00Z). Publication in the glossary was requested on 2026-10-17, replacing the earlier restriction to org notes.

## See also

- [orgtree-dev-team](../dev-team/SKILL.md)
- `orgtree-projects`, `orgtree-tool-project` and `orgtree-peer-mail` (orgtree-working › team): create the committee's project, keep members directly under it and apply its peer-mail setting.
- `orgtree-tool-hire`, `orgtree-tool-rehire`, `orgtree-tool-list-tiers` and `orgtree-credits` (orgtree-working › team): staffing, models and concurrent capacity.
- `orgtree-tool-message` and `orgtree-tool-audience` (orgtree-working › mail): send proposals to the supervisor; reachability does not waive committee independence.
- `orgtree-tool-work` (orgtree-working › docket): keep the durable question, rounds, outcome and remaining uncertainty.
- `orgtree-tool-watchdog` (orgtree-working › watchdogs): wait for observable conditions without polling.
