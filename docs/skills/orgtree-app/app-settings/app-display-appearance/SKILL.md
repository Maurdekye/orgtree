---
name: orgtree-app-display-appearance
description: Explain visual accents, custom colors, contrast, agent colors and canvas background settings.
---

Up: [orgtree-app-settings](../SKILL.md)

# Appearance

Display > Appearance and Display > Canvas background control presentation across this desktop profile. Agents explain or suggest these controls; they do not change settings themselves. Changes apply immediately without restarting agents or rewriting their prompts. A theme or background choice is not a provider/account selection and does not alter work-state meaning.

| Control | Storage | Choices and initial behavior |
| --- | --- | --- |
| visual theme | `np:visualTheme`, with provenance visualThemeExplicit | Orgtree Grey, Claude Terracotta, Codex Teal, Antigravity Navy, Muse Eggshell, OpenRouter Lavender, LS Gold, Custom. |
| custom color | Same visualTheme field, encoded as custom plus a six-digit hex color | Visible only for Custom. The picker displays the selected hex value; its initial draft color is Orgtree grey. Settled changes save after a short debounce or on blur. |
| contrast color | `np:contrastTheme` | Charcoal default, Light, Solarized Light, Obsidian Black. Controls background/text brightness independently of the accent. |
| organization theme color for agents | `np:agentColorSource` | Off/provider by default; On uses organization instead of provider colors for agent surfaces. |
| background | `np:canvasBackground` (`ls:orgtree-canvas-background` in a plain browser), `theme` | Dot grid (`dots`, default), Square grid (`square-grid`), Triangle grid (`triangle-grid`), Hexagonal grid (`hex-grid`), Checkerboard (`checkerboard`), Square tiles (`square-tiles`), Triangle tiles (`triangle-tiles`), Hexagonal tiles (`hex-tiles`), None (`none`), Claude Waves (`ascii`; alias `claude-waves`). Applies immediately across open canvases. |
| intensity | Same `canvasBackground` object, `intensities[theme]` | Range 0–100% in 5% steps (`0..1`, step `0.05`), stored sparsely per theme and debounced (250 ms or on blur). Defaults: `dots` 100%, grids 55%, `checkerboard` 25%, gapped outlined tiles (`square-tiles`, `triangle-tiles`, `hex-tiles`) 35%, `none` 0%, `ascii` (Claude Waves) 65%. |

The native preference's built-in theme is orgtree with visualThemeExplicit false. The renderer treats a nonexplicit theme as automatic: the first installed supported CLI selects Claude, Codex, Antigravity or Muse appearance in that order, with Claude as first-paint/no-provider fallback. An explicit saved choice wins; older saved themes without a provenance flag are treated as explicit. Therefore no single preset is the guaranteed visible default on every machine. Provider detection here is installation-based, not proof of sign-in or inference availability.

With a native bridge, preferences persist independently of the engine's port and broadcast to windows. In a plain browser, the appearance modules use their browser-local stores instead. Errors remain visible rather than being proof a change was saved. These stores are preferences, not organization policy.

When already revealed under Custom, Rainbow mode toggles accent cycling. A preset hides that row without clearing its saved state; returning to Custom restores it. The regular theme choice does not replace semantic status colors or provider identity badges.

Under Canvas background, grids, Checkerboard and gapped outlined tiles pan and zoom with the canvas like a floor, while the dot grid keeps its gentle parallax. Legacy unversioned `square-tiles` preferences migrate to `checkerboard` (`version: 2` marks explicit outlined `square-tiles` choices). Claude Waves (`ascii`) renders a WebGL2 flowing ASCII field in the current theme's colors with pointer wakes and floor-click ripples; it pauses when hidden or at 0% intensity, bounds zoom-out work, and degrades and auto-recovers if external GPU/CPU load stalls frame delivery or WebGL context is lost.

Suggest contrast changes or a calmer canvas background/lower intensity for readability, and an accent/custom color or backdrop preset for visual preference. Suggest organization-colored agents when the user wants a consistent theme; provider colors preserve visual differentiation. Do not use a color or background change to diagnose provider limits, permissions or an agent's work status.
