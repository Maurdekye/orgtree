---
name: orgtree-api-key-fallback
description: Explain native-account activation and the separate opt-in permission for automatic metered-key fallback.
---
Up: [orgtree-providers](../SKILL.md)

# Subscription inference and API-key fallback

These app-wide provider controls govern different decisions.

| Control | Default and meaning |
| --- | --- |
| Native subscription Active / `subscription-inference` | On. Allows that provider's ambient native sign-in to serve inference; it is the Active checkbox on its native/default account row. |
| “fall back to <provider> API-key accounts” / `apikey-fallback` | Off. Permits automatic fallback to a metered key after applicable subscription options/limits are exhausted, subject to the agent's own fallback policy and all eligibility gates. |

Registered subscription rows keep their own Active switches; the native subscription control is not a substitute for all row switches. The fallback checkbox is shown only when the backend publishes that provider's fallback map and an enabled key account exists. A missing control in an older payload is not equivalent to an explicit false setting.

Turning on key fallback can bill API credits. It does not force a current turn to move, turn on an inactive key, enable an excluded org lane or establish model entitlement. Turning native inference off can prevent the native account from serving subsequent work; registered rows are still judged individually.

These controls update engine settings without an OS elevation or whole-app restart. An actual account/session move has its own cache/context cost. Agents explain and suggest; the user changes settings.

Suggest key fallback only when paid failover is desired and understood. For ordinary capacity planning use `orgtree-account-lanes` (orgtree-working › accounts), rather than enabling a billing path to solve a missing reading. Add/activate the intended key through [accounts registry](../accounts-registry/SKILL.md).

## See also

- [orgtree-accounts-registry](../accounts-registry/SKILL.md)
