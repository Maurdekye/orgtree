import { contextBridge } from 'electron'

// No privileged API exposed until the main-process validators land.
contextBridge.exposeInMainWorld('orgtreeBootstrap', Object.freeze({ protocol: 1 }))
