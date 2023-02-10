import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const inheritedScratchDir = process.env.VSCODE_STANDARD_RUBY_TEST_SCRATCH_DIR
const SCRATCH_DIR = inheritedScratchDir ?? fs.mkdtempSync(`${os.tmpdir()}${path.sep}vscode-standard-ruby-`)
process.env.VSCODE_STANDARD_RUBY_TEST_SCRATCH_DIR = SCRATCH_DIR

export const USER_DATA_DIR = path.join(SCRATCH_DIR, 'user-data')
export const WORKSPACE_DIR = path.join(SCRATCH_DIR, 'workspace')

if (inheritedScratchDir == null) {
  fs.mkdirSync(USER_DATA_DIR)
  fs.mkdirSync(WORKSPACE_DIR)
  console.log('Scratch folder:', SCRATCH_DIR)
}
