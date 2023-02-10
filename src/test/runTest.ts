import { runTests } from '@vscode/test-electron'
import * as path from 'path'

import { USER_DATA_DIR, WORKSPACE_DIR } from './suite/setup'

async function main (): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../')
    const extensionTestsPath = path.resolve(__dirname, './suite/index')
    await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: ['--disable-extensions', '--disable-gpu', '--user-data-dir', USER_DATA_DIR, WORKSPACE_DIR] })
  } catch (err) {
    console.error('Failed to run tests')
    process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
