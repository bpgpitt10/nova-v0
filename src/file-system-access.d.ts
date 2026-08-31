export {}

type LooperFileSystemFileHandle = {
  kind: 'file'
  name: string
  getFile: () => Promise<File>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

type LooperFileSystemDirectoryHandle = {
  kind: 'directory'
  name: string
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<LooperFileSystemFileHandle>
  queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

declare global {
  interface Window {
    showOpenFilePicker: (options?: unknown) => Promise<LooperFileSystemFileHandle[]>
    showDirectoryPicker: (options?: { mode?: 'read' | 'readwrite' }) => Promise<LooperFileSystemDirectoryHandle>
  }
}
