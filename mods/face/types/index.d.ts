export type Face = { face: string; line: string }

declare module 'claude-code' {
  interface PluginState {
    'face': { face: Face; isHidden: boolean }
  }
}
