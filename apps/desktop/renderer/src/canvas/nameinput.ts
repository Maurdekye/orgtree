/** Normalize names the user enters in UI forms before validation/submission. */
export function normalizeUserEnteredName(name: string): string {
  return name.trim().replace(/ +/g, '-')
}
