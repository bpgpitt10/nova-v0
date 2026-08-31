export {}

declare global {
  interface Window {
    showOpenFilePicker: (options?: unknown) => Promise<
      Array<{
        kind: 'file'
        name: string
        getFile: () => Promise<File>
        queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
        requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
      }>
    >
  }
}
