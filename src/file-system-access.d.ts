export {}

declare global {
  interface Window {
    showOpenFilePicker: (options?: unknown) => Promise<unknown[]>
  }
}
