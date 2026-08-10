import {
  Diagnostic,
  TextDocument,
  WorkspaceFolder,
  workspace
} from 'vscode'
import {
  DidOpenTextDocumentNotification,
  Disposable,
  LanguageClient
} from 'vscode-languageclient/node'

export interface ClientManagerOptions {
  log: (message: string) => void
  createClient: (folder: WorkspaceFolder) => Promise<LanguageClient | null>
  shouldEnableForFolder: (folder: WorkspaceFolder) => Promise<boolean>
  onError: (message: string, folder: WorkspaceFolder) => Promise<void>
  onStatusUpdate: () => void
  supportedLanguage: (languageId: string) => boolean
}

/**
 * Manages multiple language clients for multi-root workspace support.
 *
 * VS Code multi-root workspaces can contain folders with different Standard Ruby
 * configurations (e.g., one folder using standard-rails plugin, another using plain
 * standard). This class ensures each folder gets its own language server instance
 * running with the correct configuration.
 */
export class ClientManager {
  // One language client per workspace folder, keyed by folder URI
  private readonly clients: Map<string, LanguageClient> = new Map()

  // Diagnostic cache per folder - used by status bar and middleware
  private readonly diagnosticCaches: Map<string, Map<string, Diagnostic[]>> = new Map()

  // Track file system watchers per folder so we can dispose them when stopping servers
  private readonly watchers: Map<string, Disposable[]> = new Map()

  // Track folders with server start in progress to prevent race conditions
  private readonly pendingStarts: Set<string> = new Set()

  private readonly options: ClientManagerOptions

  constructor (options: ClientManagerOptions) {
    this.options = options
  }

  /**
   * Get the language client for a document's workspace folder.
   */
  getClient (document: TextDocument): LanguageClient | undefined {
    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return undefined
    return this.clients.get(this.getFolderKey(folder))
  }

  /**
   * Get the first available client.
   */
  getFirstClient (): LanguageClient | null {
    return this.clients.values().next().value ?? null
  }

  /**
   * Get the number of active clients.
   */
  get size (): number {
    return this.clients.size
  }

  /**
   * Iterate over all clients.
   */
  values (): IterableIterator<LanguageClient> {
    return this.clients.values()
  }

  /**
   * Get diagnostics for a document from its folder's cache.
   */
  getDiagnostics (document: TextDocument): Diagnostic[] | undefined {
    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return undefined
    return this.diagnosticCaches.get(this.getFolderKey(folder))?.get(document.uri.toString())
  }

  /**
   * Get the diagnostic cache for a folder.
   */
  getDiagnosticCacheForFolder (folder: WorkspaceFolder): Map<string, Diagnostic[]> {
    const key = this.getFolderKey(folder)
    let cache = this.diagnosticCaches.get(key)
    if (cache == null) {
      cache = new Map()
      this.diagnosticCaches.set(key, cache)
    }
    return cache
  }

  /**
   * Register file system watchers for a folder.
   *
   * Watchers are tracked here so they can be properly disposed when a folder's
   * language server is stopped, preventing resource leaks.
   */
  registerWatchers (folder: WorkspaceFolder, watcherDisposables: Disposable[]): void {
    this.watchers.set(this.getFolderKey(folder), watcherDisposables)
  }

  /**
   * Start the language server for a specific workspace folder.
   */
  async startForFolder (folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)

    // Already running for this folder
    if (this.clients.has(key)) return

    // Prevent race condition: startForFolder can be called multiple times concurrently
    // (e.g., from workspace folder listener and manual start command). Without this
    // guard, we could end up with duplicate servers for the same folder.
    if (this.pendingStarts.has(key)) return
    this.pendingStarts.add(key)

    try {
      if (!(await this.options.shouldEnableForFolder(folder))) {
        this.options.log(`Skipping workspace folder "${folder.name}" - extension disabled or not applicable`)
        return
      }

      const client = await this.options.createClient(folder)
      if (client != null) {
        this.clients.set(key, client)
        await client.start()
        await this.afterStart(client, folder)
        this.options.log(`Language server started for "${folder.name}"`)
      }
    } catch (error) {
      // Clean up partial state on failure
      this.clients.delete(key)
      this.cleanupWatchers(key)
      this.options.log(`Failed to start language server for "${folder.name}": ${String(error)}`)
      await this.options.onError(`Failed to start Standard Ruby Language Server for "${folder.name}"`, folder)
    } finally {
      this.pendingStarts.delete(key)
    }
  }

  /**
   * Stop the language server for a specific workspace folder.
   */
  async stopForFolder (folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)
    const client = this.clients.get(key)
    if (client == null) return

    this.options.log(`Stopping language server for "${folder.name}"...`)
    await client.stop()
    this.clients.delete(key)
    this.diagnosticCaches.delete(key)
    this.cleanupWatchers(key)
  }

  /**
   * Start language servers for all workspace folders.
   */
  async startAll (): Promise<void> {
    for (const folder of workspace.workspaceFolders ?? []) {
      await this.startForFolder(folder)
    }
  }

  /**
   * Stop all language servers.
   */
  async stopAll (): Promise<void> {
    this.options.log('Stopping all language servers...')
    for (const client of this.clients.values()) {
      await client.stop()
    }
    this.clients.clear()
    this.diagnosticCaches.clear()
    this.cleanupAllWatchers()
  }

  /**
   * Restart all language servers.
   */
  async restartAll (): Promise<void> {
    this.options.log('Restarting all language servers...')
    await this.stopAll()
    await this.startAll()
  }

  /**
   * Create a disposable that handles workspace folder changes.
   */
  createWorkspaceFolderListener (): Disposable {
    return workspace.onDidChangeWorkspaceFolders(async event => {
      for (const folder of event.removed) {
        await this.stopForFolder(folder)
      }
      for (const folder of event.added) {
        await this.startForFolder(folder)
      }
    })
  }

  /**
   * Send a document open notification if needed.
   *
   * When the user switches to a document that the language server hasn't seen yet
   * (not in the diagnostic cache), we notify the server so it can provide diagnostics.
   * This handles the case where documents were opened before the server started.
   */
  async notifyDocumentOpenIfNeeded (document: TextDocument): Promise<void> {
    if (!this.options.supportedLanguage(document.languageId)) return

    const folder = workspace.getWorkspaceFolder(document.uri)
    if (folder == null) return

    const client = this.clients.get(this.getFolderKey(folder))
    if (client == null) return

    // If we haven't received diagnostics for this document, the server doesn't know
    // about it yet. Send an open notification so the server can lint it.
    const cache = this.getDiagnosticCacheForFolder(folder)
    if (!cache.has(document.uri.toString())) {
      await client.sendNotification(
        DidOpenTextDocumentNotification.type,
        client.code2ProtocolConverter.asOpenTextDocumentParams(document)
      )
    }
  }

  private getFolderKey (folder: WorkspaceFolder): string {
    return folder.uri.toString()
  }

  private async afterStart (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
    this.diagnosticCaches.set(this.getFolderKey(folder), new Map())
    await this.syncOpenDocuments(client, folder)
    this.options.onStatusUpdate()
  }

  /**
   * Notify the language server about all documents that are already open in this folder.
   *
   * When a language server starts, it doesn't know about documents that were opened
   * before it was running. This method sends open notifications for all such documents
   * so the server can provide immediate diagnostics without waiting for the user to
   * edit or switch tabs.
   */
  private async syncOpenDocuments (client: LanguageClient, folder: WorkspaceFolder): Promise<void> {
    const key = this.getFolderKey(folder)
    for (const doc of workspace.textDocuments) {
      if (!this.options.supportedLanguage(doc.languageId)) continue
      const docFolder = workspace.getWorkspaceFolder(doc.uri)
      if (docFolder == null || this.getFolderKey(docFolder) !== key) continue

      await client.sendNotification(
        DidOpenTextDocumentNotification.type,
        client.code2ProtocolConverter.asOpenTextDocumentParams(doc)
      )
    }
  }

  private cleanupWatchers (key: string): void {
    this.watchers.get(key)?.forEach(w => w.dispose())
    this.watchers.delete(key)
  }

  private cleanupAllWatchers (): void {
    for (const watcherList of this.watchers.values()) {
      watcherList.forEach(w => w.dispose())
    }
    this.watchers.clear()
  }
}

/**
 * Normalize path for glob patterns.
 *
 * Windows uses backslashes in file paths (C:\Users\...) but glob patterns require
 * forward slashes to work correctly. This function converts backslashes to forward
 * slashes so globs work cross-platform.
 */
export function normalizePathForGlob (fsPath: string): string {
  return fsPath.replace(/\\/g, '/')
}
