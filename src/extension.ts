import { exec } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { satisfies } from 'semver'
import {
  Diagnostic,
  DiagnosticSeverity,
  ExtensionContext,
  OutputChannel,
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
  DidOpenTextDocumentNotification,
  Disposable,
  Executable,
  ExecuteCommandRequest,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn
} from 'vscode-languageclient/node'

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

const promiseExec = async function (command: string, options = { cwd: getCwd() }): Promise<{ stdout: string, stderr: string }> {
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

export let languageClient: LanguageClient | null = null
let outputChannel: OutputChannel | undefined
let statusBarItem: StatusBarItem | undefined
let diagnosticCache: Map<String, Diagnostic[]> = new Map()

function getCwd (): string {
  return workspace.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd()
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
    commands.registerCommand('standardRuby.start', startLanguageServer),
    commands.registerCommand('standardRuby.stop', stopLanguageServer),
    commands.registerCommand('standardRuby.restart', restartLanguageServer),
    commands.registerCommand('standardRuby.showOutputChannel', () => outputChannel?.show()),
    commands.registerCommand('standardRuby.formatAutoFixes', formatAutoFixes)
  ]
}

function registerWorkspaceListeners (): Disposable[] {
  return [
    workspace.onDidChangeConfiguration(async event => {
      if (event.affectsConfiguration('standardRuby')) {
        await restartLanguageServer()
      }
    })
  ]
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

async function displayBundlerError (e: ExecError): Promise<void> {
  e.log()
  log('Failed to invoke Bundler in the current workspace. After resolving the issue, run the command `Standard Ruby: Start Language Server`')
  if (getConfig<string>('mode') !== 'enableUnconditionally') {
    await displayError('Failed to run Bundler while initializing Standard Ruby', ['Show Output'])
  }
}

async function isValidBundlerProject (): Promise<BundleStatus> {
  try {
    await promiseExec('bundle list --name-only', { cwd: getCwd() })
    return BundleStatus.valid
  } catch (e) {
    if (!(e instanceof ExecError)) return BundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile')) {
      log('No Gemfile found in the current workspace')
      return BundleStatus.missing
    } else {
      await displayBundlerError(e)
      return BundleStatus.errored
    }
  }
}

async function isInBundle (): Promise<StandardBundleStatus> {
  try {
    await promiseExec('bundle show standard', { cwd: getCwd() })
    return StandardBundleStatus.included
  } catch (e) {
    if (!(e instanceof ExecError)) return StandardBundleStatus.errored

    if (e.stderr.startsWith('Could not locate Gemfile') || e.stderr === 'Could not find gem \'standard\'.') {
      return StandardBundleStatus.excluded
    } else {
      await displayBundlerError(e)
      return StandardBundleStatus.errored
    }
  }
}

async function shouldEnableIfBundleIncludesStandard (): Promise<boolean> {
  const standardStatus = await isInBundle()
  if (standardStatus === StandardBundleStatus.excluded) {
    log('Disabling Standard Ruby extension, because standard isn\'t included in the bundle')
  }
  return standardStatus === StandardBundleStatus.included
}

async function shouldEnableExtension (): Promise<boolean> {
  let bundleStatus
  switch (getConfig<string>('mode')) {
    case 'enableUnconditionally':
      return true
    case 'enableViaGemfileOrMissingGemfile':
      bundleStatus = await isValidBundlerProject()
      if (bundleStatus === BundleStatus.valid) {
        return await shouldEnableIfBundleIncludesStandard()
      } else {
        return bundleStatus === BundleStatus.missing
      }
    case 'enableViaGemfile':
      return await shouldEnableIfBundleIncludesStandard()
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
function resolveCommandPath (): string {
  let customCommandPath = getConfig<string>('commandPath') ?? ''

  for (let match = variablePattern.exec(customCommandPath); match != null; match = variablePattern.exec(customCommandPath)) {
    switch (match[1]) {
      case 'cwd':
        customCommandPath = customCommandPath.replace(match[0], process.cwd())
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

function getCustomCommand (): string | undefined {
  const customCommandPath = resolveCommandPath()
  try {
    if (statSync(customCommandPath).isFile()) {
      return customCommandPath
    }
  } catch {
    log(`Custom commandPath not found: ${customCommandPath}`)
  }
}

async function getCommand (): Promise<string | undefined> {
  if (hasCustomizedCommandPath()) {
    return getCustomCommand()
  } else if (getConfig<string>('mode') !== 'onlyRunGlobally' && await isInBundle() === StandardBundleStatus.included) {
    return 'bundle exec standardrb'
  } else {
    return 'standardrb'
  }
}

const requiredGemVersion = '>= 1.24.3'
async function supportedVersionOfStandard (command: string): Promise<boolean> {
  try {
    const { stdout } = await promiseExec(`${command} -v`)
    const version = stdout.trim()
    if (satisfies(version, requiredGemVersion)) {
      return true
    } else {
      log('Disabling because the extension does not support this version of the standard gem.')
      log(`  Version reported by \`${command} -v\`: ${version} (${requiredGemVersion} required)`)
      await displayError(`Unsupported standard version: ${version} (${requiredGemVersion} required)`, ['Show Output'])
      return false
    }
  } catch (e) {
    if (e instanceof ExecError) e.log()
    log('Failed to verify the version of standard installed, proceeding anyway…')
    return true
  }
}

async function buildExecutable (): Promise<Executable | undefined> {
  const command = await getCommand()
  if (command == null) {
    await displayError('Could not find Standard Ruby executable', ['Show Output', 'View Settings'])
  } else if (await supportedVersionOfStandard(command)) {
    const [exe, ...args] = (command).split(' ')
    return {
      command: exe,
      args: args.concat('--lsp')
    }
  }
}

function buildLanguageClientOptions (): LanguageClientOptions {
  return {
    documentSelector: [
      { scheme: 'file', language: 'ruby' },
      { scheme: 'file', pattern: '**/Gemfile' }
    ],
    diagnosticCollectionName: 'standardRuby',
    initializationFailedHandler: (error) => {
      log(`Language server initialization failed: ${String(error)}`)
      return false
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel,
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher('**/.standard.yml'),
        workspace.createFileSystemWatcher('**/Gemfile.lock')
      ]
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

async function createLanguageClient (): Promise<LanguageClient | null> {
  const run = await buildExecutable()
  if (run != null) {
    log(`Starting language server: ${run.command} ${run.args?.join(' ') ?? ''}`)
    return new LanguageClient('Standard Ruby', { run, debug: run }, buildLanguageClientOptions())
  } else {
    return null
  }
}

async function displayError (message: string, actions: string[]): Promise<void> {
  const action = await window.showErrorMessage(message, ...actions)
  switch (action) {
    case 'Restart':
      await restartLanguageServer()
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

async function syncOpenDocumentsWithLanguageServer (languageClient: LanguageClient): Promise<void> {
  for (const textDocument of workspace.textDocuments) {
    if (supportedLanguage(textDocument.languageId)) {
      await languageClient.sendNotification(
        DidOpenTextDocumentNotification.type,
        languageClient.code2ProtocolConverter.asOpenTextDocumentParams(textDocument)
      )
    }
  }
}

async function handleActiveTextEditorChange (editor: TextEditor | undefined): Promise<void> {
  if (languageClient == null || editor == null) return

  if (supportedLanguage(editor.document.languageId) && !diagnosticCache.has(editor.document.uri.toString())) {
    await languageClient.sendNotification(
      DidOpenTextDocumentNotification.type,
      languageClient.code2ProtocolConverter.asOpenTextDocumentParams(editor.document)
    )
  }
  updateStatusBar()
}

async function afterStartLanguageServer (languageClient: LanguageClient): Promise<void> {
  diagnosticCache = new Map()
  await syncOpenDocumentsWithLanguageServer(languageClient)
  updateStatusBar()
}

async function startLanguageServer (): Promise<void> {
  if (languageClient != null || !(await shouldEnableExtension())) return

  try {
    languageClient = await createLanguageClient()
    if (languageClient != null) {
      await languageClient.start()
      await afterStartLanguageServer(languageClient)
    }
  } catch (error) {
    languageClient = null
    await displayError(
      'Failed to start Standard Ruby Language Server', ['Restart', 'Show Output']
    )
  }
}

async function stopLanguageServer (): Promise<void> {
  if (languageClient == null) return

  log('Stopping language server...')
  await languageClient.stop()
  languageClient = null
}

async function restartLanguageServer (): Promise<void> {
  log('Restarting language server...')
  await stopLanguageServer()
  await startLanguageServer()
}

async function formatAutoFixes (): Promise<void> {
  const editor = window.activeTextEditor
  if (editor == null || languageClient == null || !supportedLanguage(editor.document.languageId)) return

  try {
    await languageClient.sendRequest(ExecuteCommandRequest.type, {
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

  if (languageClient == null || editor == null || !supportedLanguage(editor.document.languageId)) {
    statusBarItem.hide()
  } else {
    const diagnostics = diagnosticCache.get(editor.document.uri.toString())
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
        statusBarItem.tooltip = `Standard Ruby: ${warningCount === 1 ? '1 warning' : `${errorCount} warnings`}`
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
}

export async function activate (context: ExtensionContext): Promise<void> {
  outputChannel = window.createOutputChannel('Standard Ruby')
  statusBarItem = createStatusBarItem()
  window.onDidChangeActiveTextEditor(handleActiveTextEditorChange)
  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    ...registerCommands(),
    ...registerWorkspaceListeners()
  )

  await startLanguageServer()
}

export async function deactivate (): Promise<void> {
  await stopLanguageServer()
}
