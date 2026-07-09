import { exec } from 'child_process'
import { homedir } from 'os'
import * as path from 'path'
import { satisfies } from 'semver'
import {
  DiagnosticSeverity,
  ExtensionContext,
  OutputChannel,
  WorkspaceFolder,
  commands,
  window,
  workspace,
  ProviderResult,
  TextEdit,
  TextEditor,
  ThemeColor,
  StatusBarAlignment,
  StatusBarItem
} from 'vscode'
import {
  Disposable,
  Executable,
  ExecuteCommandRequest,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn
} from 'vscode-languageclient/node'
import { ClientManager, normalizePathForGlob } from './clientManager'

class ExecError extends Error {
  command: string
  options: object
  code: number | undefined
  stdout: string
  stderr: string

  constructor (message: string, command: string, options: object, code: number | undefined, stdout: string, stderr: string) {
    super(message)
    this.command = command
    this.options = options
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }

  log (): void {
    log(`Command \`${this.command}\` failed with exit code ${this.code ?? '?'} (exec options: ${JSON.stringify(this.options)})`)
    if (this.stdout.length > 0) {
      log(`stdout:\n${this.stdout}`)
    }
    if (this.stderr.length > 0) {
      log(`stderr:\n${this.stderr}`)
    }
  }
}

const promiseExec = async function (command: string, options: { cwd: string }): Promise<{ stdout: string, stderr: string }> {
  return await new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      stdout = stdout.toString().trim()
      stderr = stderr.toString().trim()
      if (error != null) {
        reject(new ExecError(error.message, command, options, error.code, stdout, stderr))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

// Multi-root workspace support via ClientManager
let clientManager: ClientManager | null = null
let outputChannel: OutputChannel | undefined
let statusBarItem: StatusBarItem | undefined

// Public API for accessing language clients
export function getLanguageClient (): LanguageClient | null {
  return clientManager?.getFirstClient() ?? null
}
export const languageClients = {
  get size (): number { return clientManager?.size ?? 0 },
  values (): IterableIterator<LanguageClient> { return clientManager?.values() ?? [].values() }
}

function log (s: string): void {
  outputChannel?.appendLine(`[client] ${s}`)
}

function getConfig<T> (key: string): T | undefined {
  return workspace.getConfiguration('standardRuby').get<T>(key)
}

function supportedLanguage (languageId: string): boolean {
  return languageId === 'ruby' || languageId === 'gemfile'
}

function registerCommands (): Disposable[] {
  return [
    commands.registerCommand('standardRuby.start', async () => await clientManager?.startAll()),
    commands.registerCommand('standardRuby.stop', async () => await clientManager?.stopAll()),
    commands.registerCommand('standardRuby.restart', async () => await clientManager?.restartAll()),
    commands.registerCommand('standardRuby.showOutputChannel', () => outputChannel?.show()),
    commands.registerCommand('standardRuby.formatAutoFixes', formatAutoFixes)
  ]
}

function registerWorkspaceListeners (): Disposable[] {
  const listeners: Disposable[] = [
    workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('standardRuby')) {
        await clientManager?.restartAll()
      }
    })
  ]
  if (clientManager != null) {
    listeners.push(clientManager.createWorkspaceFolderListener())
  }
  return listeners
}

export enum BundleStatus {
  valid = 0,
  missing = 1,
  errored = 2
}

export enum StandardBundleStatus {
  included = 0,
  excluded = 1,
  errored = 2
}

async function displayBundlerError (e: ExecError, folder: WorkspaceFolder): Promise<void> {
  e.log()
  log(`Failed to invoke Bundler in workspace folder "${folder.name}". After resolving the issue, run the command \`Standard Ruby: Start Language Server\``)
  if (getConfig<string>('mode') !== 'enableUnconditionally') {
    await displayError(`Failed to run Bundler in "${folder.name}" while initializing Standard Ruby`, ['Show Output'])
  }
}

async function isValidBundlerProject (folder: WorkspaceFolder): Promise<BundleStatus> {
  try {
    await promiseExec('bundle list --name-only', { cwd: folder.uri.fsPath })
    return BundleStatus.valid
  } catch (e) {
    if (!(e instanceof ExecError)) return BundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile')) {
      log(`No Gemfile found in workspace folder "${folder.name}"`)
      return BundleStatus.missing
    } else {
      await displayBundlerError(e, folder)
      return BundleStatus.errored
    }
  }
}

async function isInBundle (folder: WorkspaceFolder): Promise<StandardBundleStatus> {
  try {
    await promiseExec('bundle show standard', { cwd: folder.uri.fsPath })
    return StandardBundleStatus.included
  } catch (e) {
    if (!(e instanceof ExecError)) return StandardBundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile') || e.stderr === 'Could not find gem \'standard\'.') {
      return StandardBundleStatus.excluded
    } else {
      await displayBundlerError(e, folder)
      return StandardBundleStatus.errored
    }
  }
}

async function shouldEnableIfBundleIncludesStandard (folder: WorkspaceFolder): Promise<boolean> {
  const standardStatus = await isInBundle(folder)
  if (standardStatus === StandardBundleStatus.excluded) {
    log(`Skipping workspace folder "${folder.name}" - standard gem not in bundle`)
  }
  return standardStatus === StandardBundleStatus.included
}

async function shouldEnableForFolder (folder: WorkspaceFolder): Promise<boolean> {
  let bundleStatus
  switch (getConfig<string>('mode')) {
    case 'enableUnconditionally':
      return true
    case 'enableViaGemfileOrMissingGemfile':
      bundleStatus = await isValidBundlerProject(folder)
      if (bundleStatus === BundleStatus.valid) {
        return await shouldEnableIfBundleIncludesStandard(folder)
      } else {
        return bundleStatus === BundleStatus.missing
      }
    case 'enableViaGemfile':
      return await shouldEnableIfBundleIncludesStandard(folder)
    case 'onlyRunGlobally':
      return true
    case 'disable':
      return false
    default:
      log('Invalid value for standardRuby.mode')
      return false
  }
}

function hasCustomizedCommandPath (): boolean {
  const customCommandPath = getConfig<string>('commandPath')
  return customCommandPath != null && customCommandPath.length > 0
}

const variablePattern = /\$\{([^}]*)\}/
function resolveCommandPath (folder: WorkspaceFolder): string {
  let customCommandPath = getConfig<string>('commandPath') ?? ''

  for (let match = variablePattern.exec(customCommandPath); match != null; match = variablePattern.exec(customCommandPath)) {
    switch (match[1]) {
      case 'cwd':
        customCommandPath = customCommandPath.replace(match[0], folder.uri.fsPath)
        break
      case 'pathSeparator':
        customCommandPath = customCommandPath.replace(match[0], path.sep)
        break
      case 'userHome':
        customCommandPath = customCommandPath.replace(match[0], homedir())
        break
    }
  }

  return customCommandPath
}

async function getCommand (folder: WorkspaceFolder): Promise<string> {
  if (hasCustomizedCommandPath()) {
    return resolveCommandPath(folder)
  } else if (getConfig<string>('mode') !== 'onlyRunGlobally' && await isInBundle(folder) === StandardBundleStatus.included) {
    return 'bundle exec standardrb'
  } else {
    return 'standardrb'
  }
}

const requiredGemVersion = '>= 1.24.3'
async function supportedVersionOfStandard (command: string, folder: WorkspaceFolder): Promise<boolean> {
  try {
    const { stdout } = await promiseExec(`${command} -v`, { cwd: folder.uri.fsPath })
    const version = stdout.trim()
    if (satisfies(version, requiredGemVersion)) {
      return true
    } else {
      log(`Disabling for "${folder.name}" - unsupported standard version.`)
      log(`  Version reported by \`${command} -v\`: ${version} (${requiredGemVersion} required)`)
      await displayError(`Unsupported standard version in "${folder.name}": ${version} (${requiredGemVersion} required)`, ['Show Output'])
      return false
    }
  } catch (e) {
    if (e instanceof ExecError) e.log()
    log(`Failed to verify the version of standard in "${folder.name}", proceeding anyway…`)
    return true
  }
}

async function buildExecutable (folder: WorkspaceFolder): Promise<Executable | undefined> {
  const command = await getCommand(folder)
  if (command == null) {
    await displayError(`Could not find Standard Ruby executable for "${folder.name}"`, ['Show Output', 'View Settings'])
  } else if (await supportedVersionOfStandard(command, folder)) {
    const [exe, ...args] = (command).split(' ')
    return {
      command: exe,
      args: args.concat('--lsp'),
      options: {
        cwd: folder.uri.fsPath
      }
    }
  }
}

function buildLanguageClientOptions (folder: WorkspaceFolder): LanguageClientOptions {
  const globPath = normalizePathForGlob(folder.uri.fsPath)

  // Create watchers and register them with the client manager
  const watchers = [
    workspace.createFileSystemWatcher(`${globPath}/**/.standard.yml`),
    workspace.createFileSystemWatcher(`${globPath}/**/.standard_todo.yml`),
    workspace.createFileSystemWatcher(`${globPath}/**/Gemfile.lock`)
  ]
  clientManager?.registerWatchers(folder, watchers)

  // Get the diagnostic cache for this folder
  const diagnosticCache = clientManager?.getDiagnosticCacheForFolder(folder) ?? new Map()

  return {
    documentSelector: [
      { scheme: 'file', language: 'ruby', pattern: `${globPath}/**/*` },
      { scheme: 'file', pattern: `${globPath}/**/Gemfile` }
    ],
    diagnosticCollectionName: `standardRuby-${folder.name}`,
    workspaceFolder: folder,
    initializationFailedHandler: (error) => {
      log(`Language server initialization failed for "${folder.name}": ${String(error)}`)
      return false
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel,
    synchronize: {
      fileEvents: watchers
    },
    middleware: {
      provideDocumentFormattingEdits: (document, options, token, next): ProviderResult<TextEdit[]> => {
        if (getConfig<boolean>('autofix') ?? true) {
          return next(document, options, token)
        }
      },
      handleDiagnostics: (uri, diagnostics, next) => {
        diagnosticCache.set(uri.toString(), diagnostics)
        updateStatusBar()
        next(uri, diagnostics)
      }
    }
  }
}

async function createLanguageClient (folder: WorkspaceFolder): Promise<LanguageClient | null> {
  const run = await buildExecutable(folder)
  if (run != null) {
    log(`Starting language server for "${folder.name}": ${run.command} ${run.args?.join(' ') ?? ''} (cwd: ${folder.uri.fsPath})`)
    return new LanguageClient(
      `Standard Ruby (${folder.name})`,
      { run, debug: run },
      buildLanguageClientOptions(folder)
    )
  } else {
    return null
  }
}

async function displayError (message: string, actions: string[]): Promise<void> {
  const action = await window.showErrorMessage(message, ...actions)
  switch (action) {
    case 'Restart':
      await clientManager?.restartAll()
      break
    case 'Show Output':
      outputChannel?.show()
      break
    case 'View Settings':
      await commands.executeCommand('workbench.action.openSettings', 'standardRuby')
      break
    default:
      if (action != null) log(`Unknown action: ${action}`)
  }
}

async function handleActiveTextEditorChange (editor: TextEditor | undefined): Promise<void> {
  if (clientManager == null || editor == null) {
    updateStatusBar()
    return
  }

  await clientManager.notifyDocumentOpenIfNeeded(editor.document)
  updateStatusBar()
}

async function formatAutoFixes (): Promise<void> {
  const editor = window.activeTextEditor
  if (editor == null || !supportedLanguage(editor.document.languageId)) return

  const client = clientManager?.getClient(editor.document)
  if (client == null) return

  try {
    await client.sendRequest(ExecuteCommandRequest.type, {
      command: 'standardRuby.formatAutoFixes',
      arguments: [{
        uri: editor.document.uri.toString(),
        version: editor.document.version
      }]
    })
  } catch (e) {
    await displayError(
      'Failed to apply Standard Ruby fixes to the document.', ['Show Output']
    )
  }
}

function createStatusBarItem (): StatusBarItem {
  const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 0)
  statusBarItem.command = 'workbench.action.problems.focus'
  return statusBarItem
}

function updateStatusBar (): void {
  if (statusBarItem == null) return
  const editor = window.activeTextEditor

  if (clientManager == null || editor == null || !supportedLanguage(editor.document.languageId)) {
    statusBarItem.hide()
    return
  }

  const client = clientManager.getClient(editor.document)
  if (client == null) {
    statusBarItem.hide()
    return
  }

  const diagnostics = clientManager.getDiagnostics(editor.document)

  if (diagnostics == null) {
    statusBarItem.tooltip = 'Standard Ruby'
    statusBarItem.text = 'Standard $(ruby)'
    statusBarItem.color = undefined
    statusBarItem.backgroundColor = undefined
  } else {
    const errorCount = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error).length
    const warningCount = diagnostics.filter((d) => d.severity === DiagnosticSeverity.Warning).length
    const otherCount = diagnostics.filter((d) =>
      d.severity === DiagnosticSeverity.Information ||
        d.severity === DiagnosticSeverity.Hint
    ).length
    if (errorCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${errorCount === 1 ? '1 error' : `${errorCount} errors`}`
      statusBarItem.text = 'Standard $(error)'
      statusBarItem.backgroundColor = new ThemeColor('statusBarItem.errorBackground')
    } else if (warningCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${warningCount === 1 ? '1 warning' : `${warningCount} warnings`}`
      statusBarItem.text = 'Standard $(warning)'
      statusBarItem.backgroundColor = new ThemeColor('statusBarItem.warningBackground')
    } else if (otherCount > 0) {
      statusBarItem.tooltip = `Standard Ruby: ${otherCount === 1 ? '1 hint' : `${otherCount} issues`}`
      statusBarItem.text = 'Standard $(info)'
      statusBarItem.backgroundColor = undefined
    } else {
      statusBarItem.tooltip = 'Standard Ruby: No issues!'
      statusBarItem.text = 'Standard $(ruby)'
      statusBarItem.backgroundColor = undefined
    }
  }
  statusBarItem.show()
}

export async function activate (context: ExtensionContext): Promise<void> {
  outputChannel = window.createOutputChannel('Standard Ruby')
  statusBarItem = createStatusBarItem()

  // Initialize client manager for multi-root workspace support
  clientManager = new ClientManager({
    log,
    createClient: createLanguageClient,
    shouldEnableForFolder,
    onError: async (message, _folder) => {
      await displayError(message, ['Restart', 'Show Output'])
    },
    onStatusUpdate: updateStatusBar,
    supportedLanguage
  })

  window.onDidChangeActiveTextEditor(handleActiveTextEditorChange)
  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    ...registerCommands(),
    ...registerWorkspaceListeners()
  )

  log('Activating Standard Ruby extension with multi-root workspace support')
  await clientManager.startAll()
}

export async function deactivate (): Promise<void> {
  await clientManager?.stopAll()
}
