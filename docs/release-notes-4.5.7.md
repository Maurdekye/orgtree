# Orgtree 4.5.7

Orgtree 4.5.7 fixes the mail spark on the canvas and adds OpenCode Go to the language model servers. It still bundles Mail hub 2.4.0.

## Canvas

- **The first outside mail sparks.** When the first outside mail to an organization arrives, its org inbox tile appears just afterward, and the spark that should have run into it was dropped. The spark now waits for the tile and plays once it appears.
- **Mail sparks follow their wire while the layout moves.** A spark used to keep the path it had when the mail arrived. It now follows its wire as it is drawn, so it stays on the line when an agent is added or the layout shifts, and it ends if the wire is gone.

## Providers

- **An OpenCode Go subscription can be registered as a language model server.** In **App settings > Providers > Language model servers > Add**, choose **OpenCode Go**. The preset fills the address (`https://opencode.ai/inference/go`), the base path (`openai/v1`), the OpenCode harness and the OpenAI Chat Completions API style; only OpenCode is offered. Enter your key, then **Find models**. Entering the same settings by hand as a Custom server also works, and the documentation covers both and the 401/403 and MissingSessionID cases.
- This is based on a user's report on issue #8 that these settings worked in 4.5.6. The Orgtree team has not tested it against a real OpenCode Go subscription.

## Untested

- The OpenCode Go preset has been tested by automated tests only, not against a real OpenCode Go subscription or endpoint.
- The spark changes have been tested by automated tests, not by watching a first outside mail arrive in a live organization.

## Notes

- There are no database changes and no installer changes in this release.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
