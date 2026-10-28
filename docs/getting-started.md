# Getting started

[Documentation](../README.md#documentation) · [Next: Workspace](workspace.md)

Watch [Orgtree School 1: Introduction](https://youtu.be/c2SF2xMG0uk) (8:43) for a guided tour of Orgtree's workspace and agent workflow.

## After the tour

After a first look at Orgtree, use these guides to put the basics to work on a real task: connect a harness, create an organization, hire an agent and talk in its desk. You do not need to configure a large organization to begin.

If you already have a connected provider, an organization and an agent working on a task, keep that setup and continue with [Workspace](workspace.md). Return to this page when installing on another computer or starting a fresh team. Later guides cover larger teams, settings, model routes, outside connections and automation.

| Word | What it means |
| --- | --- |
| Harness | A coding application, such as Claude Code or Codex, that combines a model with tools. |
| Agent | A persistent member of your Orgtree organization, running through a harness, with its own conversation, mailbox and working folder. |
| Organization | Your workspace for a team, its instructions, work items, mail and documents. |
| Charter | An agent's standing job description. Your message supplies its current task. |
| Desk | The place to talk to an agent and inspect its work. |
| Credits | Capacity for seats and delegated teams, separate from model-provider charges. |

<a id="install"></a>

## Install Orgtree

The published installer is for **64-bit Windows**. Windows builds are unsigned; macOS and Linux builds remain prototypes.

1. Open the [latest release](https://github.com/Maurdekye/orgtree/releases/latest).
2. Download **`Orgtree-Setup-<version>.exe`** and run it. GitHub's source-code ZIP is for source, not installation.
3. Open **Orgtree** from the Start menu. The centered Welcome card lets you choose a theme and startup behavior, then create an organization. Narrow windows keep side padding; shorter windows scroll to the remaining actions.

The installer includes the desktop app, local engine and PostgreSQL database. You do not need to install Node.js, Rust or PostgreSQL to use the packaged app. A newer installation keeps your organization data. Model access and provider applications are set up separately.

If the background engine cannot start, Orgtree shows the reason with **Retry**
and **Quit**. A disabled background-engine task needs an installation repair:
run Setup again as administrator, then choose **Retry**. Turning **Run on boot**
off only disables automatic triggers and still permits a manual start. Failed
updates restore the previous task and trigger states when Setup can complete its
rollback; they record any failure in `orgtree-installer.log` beside Setup or in
`%TEMP%`. Keep that log if repair fails. Task rollback does not restore replaced
files, so completing Setup remains the repair for a partial installation.

<a id="set-up-a-provider"></a>

## Connect one provider

Install and sign into one supported harness using its own setup instructions. For example, use [Claude Code](https://code.claude.com/docs/en/setup) or the [Codex CLI](https://developers.openai.com/codex/cli). You only need the provider you intend to use now.

Open **Orgtree menu > App settings > Providers** and check its installed and sign-in state. **Harnesses** lists installed tools, versions and installation links. The default Codex row offers **Sign in / Sign in again**, opening its browser authorization for the default profile. Complete that flow yourself; managed-account rows target their own profiles. Browser-only clients have no native sign-in bridge.

**Refresh** requests a fresh ordinary provider/sign-in check. Overlapping requests and rapid repeats can share a result; this is different from refreshing account usage. Refresh does not complete browser authorization or prove that model inference works.

<a id="language-servers"></a>

Orgtree does not include model access. Your subscription, API charges and provider limits still apply. If you need another provider, managed account, OpenRouter or a model server, use [Providers, models and tools](providers-and-tools.md) after the first task works.

<a id="your-first-organization"></a>

## Create your first organization

On the welcome card, enter an **Organization name** and keep **Starting layout: Empty** to build the team yourself. Click **Create organization**. You can also create another organization later through the **Orgtree** menu.

The new canvas starts with the **YOU** eye card. The first-use guide points at the actual hire and message controls. Its hire-token note sits left of the token group and its name note right of the draft; they move above/below when space is tight and yield when no clear space remains. The first-message note stays toward the right of the composer, clear of staged attachment previews; in a narrow view it can move above or below the composer and previews. If you choose a starting layout that already hires agents, it begins with the first-message step instead. A layout is optional. Each note has a **Dismiss** button that ends the guide for that organization at any step; it does not come back.

## Hire one agent

1. Hover the **YOU** card to show hire tokens, grouped by provider. Each token represents a model you can currently use.
2. Click a token. The dashed **uninitialized** draft is a proposal, not an agent already running.
3. Give the agent a name. Optionally select a charter preset or write a short role, such as “Investigate this repository and explain its structure.”
4. Open the permission gear and choose the folders and tools needed for this task. Changes are saved to the draft immediately; close the gear menu, then click **Hire**.

The new card takes the draft's place and its desk opens. Seat prices use organizational credits; they are not dollar prices or token balances. Disabled choices explain their current restriction. If a hire is refused, read the reason and correct the saved draft rather than repeatedly clicking Hire.

Start with access to the material needed. Harnesses differ in how they enforce folder and command permissions; [Managing agents](managing-agents.md) explains those choices before you give a team broader access.

## Give it a first task

Use the desk's **Chat** box. State the result, constraints and how you will judge completion. For example:

> Read the project README and source tree. Write a short plan for adding a settings page. Do not change files yet. Explain the main steps and anything you need me to decide.

Attach files or images with the paperclip, or drag them into the composer. Send the message and follow the streamed reply and tool rows. Hiring alone is not a substitute for sending the task.

Read the result, answer any question cards and send a follow-up. Ask for a written plan or presentation when you want something to review away from the live transcript. **Docket** holds work items; **Presented** holds documents. [Messages and work](messages-and-work.md) explains those views and replies.

## Keep going

Use [Workspace](workspace.md) to move around and keep useful panels in view. Then learn to [manage agents](managing-agents.md), including their charters, model, effort, folders and stop controls. Add a coordinator and specialists when the task benefits from them.

**Quick chat** is a shortcut once you know this flow: it hires a **new** agent from one message. It does not send to an existing agent. Keep using an existing desk when continuing that agent's work.

## If the first steps fail

- **No model to hire:** check the provider's installed/sign-in state and the organization's allowed accounts. An installed harness alone does not establish model access or remaining capacity.
- **Creating or hiring reports a partial result:** inspect the organization or new card before retrying. A later upload or setup error can occur after something was created.
- **A grant or folder is refused:** read the current capacity or permission reason. Changing a label does not provide more credits or access.
- **The agent stops:** distinguish a deliberate Halt, a provider-limit freeze and an error before choosing a recovery action. See [Operating and troubleshooting](operating-orgtree.md).

These guides describe Orgtree 4.4.2. Model availability, subscriptions and external applications can change independently of Orgtree.
