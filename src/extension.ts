import { exec } from 'child_process'
import { statSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'
import { satisfies } from 'semver'
import { promisify } from 'util'
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

const promiseExec = promisify(exec)

export let languageClient: LanguageClient | null = null
let outputChannel: OutputChannel | undefined
let statusBarItem: StatusBarItem | undefined
let enableExtension: boolean = true
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
        enableExtension = await determineWhetherToEnableExtension()
        if (enableExtension) {
          await restartLanguageServer()
        } else {
          await stopLanguageServer()
        }
      }
    })
  ]
}

async function determineWhetherToEnableExtension (): Promise<boolean> {
  let shouldEnable
  switch (getConfig<string>('mode')) {
    case 'enableUnconditionally':
      return true
    case 'enableViaGemfileOrMissingGemfile':
      if (await isValidBundlerProject()) {
        shouldEnable = await isInBundle()
        if (!shouldEnable) {
          log('Disabling Standard Ruby extension, because a Gemfile was found but standard is not installed in the bundle  (ran `bundle show standard`)')
        }
        return shouldEnable
      } else {
        return true
      }
    case 'enableViaGemfile':
      shouldEnable = await isInBundle()
      if (!shouldEnable) {
        log('Disabling Standard Ruby extension, because standard is not installed in the bundle (ran `bundle show standard`)')
      }
      return shouldEnable
    case 'disable':
      return false
    default:
      log('Invalid value for standardRuby.mode')
      return false
  }
}

async function isValidBundlerProject (): Promise<boolean> {
  try {
    await promiseExec('bundle list --name-only', { cwd: getCwd() })
    return true
  } catch {
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

async function isInBundle (): Promise<boolean> {
  try {
    await promiseExec('bundle show standard', { cwd: getCwd() })
    return true
  } catch {
    return false
  }
}

async function getCommand (): Promise<string | undefined> {
  if (hasCustomizedCommandPath()) {
    return getCustomCommand()
  } else if (await isInBundle()) {
    return 'bundle exec standardrb'
  } else {
    return 'standardrb'
  }
}

const requiredGemVersion = '>= 1.24.2'
async function supportedVersionOfStandard (command: string): Promise<boolean> {
  try {
    const { stdout } = await promiseExec(`${command} -v`)
    const version = stdout.trim()
    if (satisfies(version, requiredGemVersion)) {
      return true
    } else {
      log('Disabling extension because the extension does not support this version of the standard gem.')
      log(`  Version reported by \`${command} -v\`: ${version} (${requiredGemVersion} required)`)
      await displayError(`Unsupported standard version: ${version} (${requiredGemVersion} required)`, ['Show Output'])
      return false
    }
  } catch {
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
      fileEvents: [workspace.createFileSystemWatcher('**/.standard.yml')]
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
    if (textDocument.languageId === 'ruby') {
      await languageClient.sendNotification(
        DidOpenTextDocumentNotification.type,
        languageClient.code2ProtocolConverter.asOpenTextDocumentParams(textDocument)
      )
    }
  }
}

async function handleActiveTextEditorChange (editor: TextEditor | undefined): Promise<void> {
  if (languageClient == null || editor == null || editor.document.languageId !== 'ruby') return

  if (!diagnosticCache.has(editor.document.uri.toString())) {
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
  if (languageClient != null) return

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
  if (editor == null || languageClient == null || editor.document.languageId !== 'ruby') return

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

  if (languageClient == null || editor == null || editor.document.languageId !== 'ruby') {
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
        statusBarItem.color = undefined
        statusBarItem.backgroundColor = new ThemeColor('statusBarItem.errorBackground')
      } else if (warningCount > 0) {
        statusBarItem.tooltip = `Standard Ruby: ${warningCount === 1 ? '1 warning' : `${errorCount} warnings`}`
        statusBarItem.text = 'Standard $(warning)'
        statusBarItem.color = 'yellow'
        statusBarItem.backgroundColor = undefined
      } else if (otherCount > 0) {
        statusBarItem.tooltip = `Standard Ruby: ${otherCount === 1 ? '1 hint' : `${otherCount} issues`}`
        statusBarItem.text = 'Standard $(info)'
        statusBarItem.color = 'cyan'
        statusBarItem.backgroundColor = undefined
      } else {
        statusBarItem.tooltip = 'Standard Ruby: No issues!'
        statusBarItem.text = 'Standard $(ruby)'
        statusBarItem.color = undefined
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

  if (await determineWhetherToEnableExtension()) {
    await startLanguageServer()
  }
}

export async function deactivate (): Promise<void> {
  await stopLanguageServer()
}
