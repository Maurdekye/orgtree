export interface StreamerBoundary {
  update(on: boolean, known?: readonly string[], ready?: boolean): void
  dispose(): void
}
export function installStreamerBoundary(_doc: Document): StreamerBoundary {
  return { update() {}, dispose() {} }
}
