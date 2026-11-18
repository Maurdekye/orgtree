# Orgtree 4.6.3

Orgtree 4.6.3 makes every agent's model version either **latest** or **pinned**, so new agents always run the newest version of their model, lets tools change an existing agent's version, and adds Gemini Neon ahead of its release. It still bundles Mail hub 2.4.0.

## Model versions

- **Latest or pinned.** An agent's model version is now either *latest*, which follows its model's newest version and moves when a release adds a newer one, or pinned to a version, which never changes. New agents start on latest. The **Model version** menu shows "latest (6.2)" instead of a "default".
- **A one-time switch.** Sol, Astra and Fable agents without a pinned version move to the newest version (Sol and Astra 6.2, Fable 5.2) at their next turn, or when rehired. The first turn after the switch costs a little more, because the prompt cache starts fresh.
- **Automatic pins become latest.** Agents hired on 4.5.10 to 4.6.2 without picking a version were saved as pinned to Fable 5.2 or Sol/Astra 6.2. This update turns those pins back into latest. Agents pinned to an older version keep it.
- **Changing a version from tools.** `orgtree_switch_model`, `orgtree_retool` and `orgtree_rehire` accept `model_version` ("latest" or a version), so an agent can move to another version of its model without being replaced. A change applies at the agent's next turn. `orgtree_state_inspect` shows each agent's version setting, the version it resolves to and its model.

## Gemini Neon

- **Ready before it ships.** Gemini Neon (`gemini-4-neon`) is added ahead of Google making it available. It shows up for hiring, staffing and model switching only once your Antigravity account's model list includes it, and stays hidden until then. No real Neon turn has been checked yet.
- **Placement.** Neon sits after Krypton with the letter N, in a neon red-orange, with Krypton's low and high effort. Its 2-credit seat is a placeholder until a price is published. The legacy-models rules are unchanged.

## Notes

- Database change: migration 0089 (the automatic pins above).
- Hubchat 1.3.9, released alongside, opens links to Orgtree orgs again after Orgtree's data was moved with **Data location**.
- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.3`, plus the agents image `:4.6.3-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
