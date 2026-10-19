# Notices

Orgtree source reused from Maurdekye/claude-orgtree retains its original MIT notice in LICENSE.
Electron, Chromium, Node.js, React, Python and other distributed dependencies retain their own licenses.
Their full license files must accompany packaged distribution; this note does not replace those licenses.

`engine/rs/orgtree-engine/assets/codex-default-instructions.md` is the default prompt of OpenAI's Codex CLI
(https://github.com/openai/codex), as Codex 0.160.0 sends it for a model missing from its catalog,
Copyright OpenAI, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
Orgtree passes it back to Codex unchanged in the model catalogs it writes for language servers.

The engine's MQTT watchdogs (`docs/rust-engine/mqtt-watchdogs.md`) use rumqttc 0.25.1
(https://github.com/bytebeamio/rumqtt), licensed under the Apache License, Version 2.0. The crates it brings
in are flume, spin, fixedbitset, tokio-stream, rustls-pemfile, rustls-native-certs and rustls-webpki 0.102,
plus schannel, openssl-probe or security-framework/core-foundation on their platforms. Each is under
MIT, Apache-2.0 or ISC terms (license check 2026-10-19).
