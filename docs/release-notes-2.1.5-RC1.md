# Orgtree 2.1.5-RC1

- A self-update now waits until the installer is actually observed running before Orgtree exits. A pid coming back is no longer treated as proof: an installer that is declined at the permission prompt, or that dies immediately, no longer leaves the application shut down having installed nothing.
- When an update cannot be handed off, Orgtree says so from a process that is still alive to say it: it records the outcome, relaunches, and the relaunched instance shows the failure, naming the reason and where the log is. The old behaviour put the message on a process that was already exiting, so nobody saw it.
- Closing a console window no longer kills Orgtree cold. The application now handles console-close, interrupt and break signals and shuts down in order. Closing the originating console, the parent shell, or the engine cannot cancel an update that has already been accepted.
- Update progress is recorded in durable phase markers, so an update that ends badly can be diagnosed afterwards instead of leaving only silence.
- The Windows installer writes its own log from its first line onward, including the command line it received and whether it was started with administrator rights, so a failure before any page is shown still leaves a record.
- Tests that disturb the desktop — ones that open consoles, show dialogs or run the real installer toolchain — have been moved behind two barriers. An ordinary `npm test` cannot reach them, and each one refuses to run without an explicit opt-in, so running the test suite can no longer take over the machine.
- A team docket is available behind the agent context menu, and staffing an item is recorded as its own readable docket update.
- Quick Staff adds submenu staffing that creates the seat and assigns the work in one action, with standard progress preservation.
- Context menus now open in the window the right-click came from, and presenting a document focuses the popped-out window that is already open instead of opening another.
- Agent cards show more at a glance: names appear on far-zoom hover, a zoom-in cursor marks zoomable cards, a pinned desk shows its account ID once in its token list, and Codex cards keep their serving account across the turn.
- Gemini usage reporting and the account UI show the authoritative account tier.
- Questions with no options are presented as free response, bulk subordinate retirement is available as a context action, a frozen agent can be continued on another account from its menu, and the canvas halt outline is limited to the organization killswitch.
- Mail delivery is steadier: a retired import binding can no longer silence a mailbox, long managed tool calls yield at safe delivery boundaries, and unpublishable tool results are retired without consuming active capacity.
