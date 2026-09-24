import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import * as fs from 'fs'
import * as path from 'path'

import { USER_DATA_DIR, WORKSPACE_DIR } from './suite/setup'

async function resolveVSCodeExecutablePath (): Promise<string> {
  const configuredExecutablePath = process.env.VSCODE_TEST_EXECUTABLE_PATH ?? process.env.VSCODE_EXECUTABLE_PATH
  if (configuredExecutablePath != null && configuredExecutablePath.length > 0) return configuredExecutablePath

  const downloadedExecutablePath = await downloadAndUnzipVSCode()
  const codeExecutablePath = downloadedExecutablePath.replace(/\/Electron$/, '/Code')
  if (fs.existsSync(codeExecutablePath)) return codeExecutablePath
  if (fs.existsSync(downloadedExecutablePath)) return downloadedExecutablePath

  return downloadedExecutablePath
}

async function main (): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../')
    const extensionTestsPath = path.resolve(__dirname, './suite/index')
    const vscodeExecutablePath = await resolveVSCodeExecutablePath()
    await runTests({ vscodeExecutablePath, extensionDevelopmentPath, extensionTestsPath, launchArgs: ['--disable-extensions', '--disable-gpu', '--user-data-dir', USER_DATA_DIR, WORKSPACE_DIR] })
  } catch (err) {
    console.error('Failed to run tests')
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
