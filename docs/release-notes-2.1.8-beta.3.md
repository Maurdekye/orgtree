# Orgtree 2.1.8-beta.3

Three changes. One closes the known issue beta.2 shipped with, and two make the
message composers behave the same way wherever you are.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## The usage-limit countdown no longer reaches zero early

beta.2 shipped with this named as a known issue: a frozen agent's countdown hit
zero roughly a minute before the agent was actually allowed to wake. The freeze
was never stuck — the wake adds a short grace period that the displayed number
did not account for, so the badge sat at zero while nothing appeared to happen.

The badge now counts down **twice**, in sequence. First to the reset time the
provider itself stated, which is what it has always shown and what it should
keep showing. Then, when that reaches zero, a second short countdown to the
moment the agent can actually resume. Two honest numbers rather than one number
quietly carrying an allowance it never mentioned.

The wake fires at exactly the same instant it always did. This build changed
where that allowance is calculated and what the screen tells you about it, not
how long anything waits.

## One attachment icon everywhere

The file-attachment button did not use the same picture in every place you can
attach a file, so the same action looked like a different feature depending on
which box you were typing in. Every attachment control in the app is now a
paperclip, including the docket item's attach button, which was previously text
only.

## The notice toggle is now in every reply box

A **notice** is a message that lands in the recipient's mailbox and is read when
they next run, instead of waking them for it — the right shape for a heads-up
that is worth knowing but not worth interrupting anyone over.

Until now that toggle existed in only one composer. It is now in the ticket
reply, the mail reply and the presentation reply as well, and it works the same
way in all of them: the control sits above the attach button, **Alt+N** toggles
it, a send that cannot be delivered as a notice falls back to ordinary mail
rather than failing, and a sent notice is drawn with a dotted border.

Each box remembers its own setting and starts switched off. Arming the toggle in
one reply box does not arm it in another, and it disarms itself once the message
is sent.

The org-inbox compose modal is the one deliberate exception. It addresses parties
outside this organization, and a notice to an outside address is refused by the
server regardless — a control that could never do anything there would be worse
than no control.

## Also in this build

The stale-quota fix that shipped in beta.2 has now been confirmed working on a
live agent, not only in tests. An agent that had been re-freezing every five
minutes for twenty-two hours on a quota message that was no longer true was
released within four minutes of that build going live, and completed a normal
turn.
