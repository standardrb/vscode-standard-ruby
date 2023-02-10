import * as assert from 'assert'
import * as path from 'path'
import { TextEncoder } from 'util'

import { Uri, TextEditor, commands, window, workspace } from 'vscode'

import { WORKSPACE_DIR } from './setup'

export async function reset (): Promise<void> {
  await commands.executeCommand('workbench.action.closeAllEditors')
}

export async function createEditor (content: string): Promise<TextEditor> {
  const filename = `${Math.random().toString().slice(2)}.rb`
  const uri = Uri.file(`${WORKSPACE_DIR}${path.sep}${filename}`)
  await workspace.fs.writeFile(uri, new TextEncoder().encode(content))
  await window.showTextDocument(uri)
  assert.ok(window.activeTextEditor)
  assert.equal(window.activeTextEditor.document.getText(), content)
  return window.activeTextEditor
}

export function findNewestEditor (): TextEditor {
  return window.visibleTextEditors[window.visibleTextEditors.length - 1]
}

export async function formatDocument (): Promise<void> {
  return await commands.executeCommand('editor.action.formatDocument', 'testdouble.vscode-standard-ruby')
}

export async function formatAutoFixes (): Promise<void> {
  return await commands.executeCommand('standardRuby.formatAutoFixes')
}

export async function restart (): Promise<void> {
  return await commands.executeCommand('standardRuby.restart')
}

export async function start (): Promise<void> {
  return await commands.executeCommand('standardRuby.start')
}

export async function stop (): Promise<void> {
  return await commands.executeCommand('standardRuby.stop')
}
