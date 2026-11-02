/** Screen presentation only; never modify persisted or agent-facing values. */
export type SensitiveSpan = { start: number; end: number }
export function sensitiveSpans(_text: string, _known: readonly string[] = []): SensitiveSpan[] { return [] }
export function redactScreenText(text: string, _known: readonly string[] = []): string { return text }
export function knownScreenValues(_value: unknown): string[] { return [] }
export function nativeScreenText(text: string, _enabled: boolean): string { return text }
