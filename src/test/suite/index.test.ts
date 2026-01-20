import * as assert from 'assert'
import { before, beforeEach } from 'mocha'
import { State } from 'vscode-languageclient'

import * as auto from './automation'
import * as extension from '../../extension'

const UNFORMATTED = `class Foo
  def bar
    puts 'baz'
  end
end
`

const FORMATTED = `class Foo
  def bar
    puts "baz"
  end
end
`

suite('Standard Ruby', () => {
  beforeEach(auto.reset)

  suite('lifecycle commands', () => {
    test('start', async () => {
      await auto.start()
      const client = extension.getLanguageClient()
      assert.notEqual(client, null)
      assert.equal(client?.state, State.Running)
    })

    test('stop', async () => {
      await auto.start()
      await auto.stop()
      assert.equal(extension.languageClients.size, 0)
    })

    test('restart', async () => {
      await auto.restart()
      const client = extension.getLanguageClient()
      assert.notEqual(client, null)
      assert.equal(client?.state, State.Running)
    })
  })

  suite('functional commands', () => {
    before(auto.reset)

    test('format', async () => {
      const editor = await auto.createEditor(UNFORMATTED)
      await auto.formatDocument()
      assert.equal(editor.document.getText(), FORMATTED)
    })

    test('format with custom command', async () => {
      const editor = await auto.createEditor(UNFORMATTED)
      await auto.formatAutoFixes()
      assert.equal(editor.document.getText(), FORMATTED)
    })
  })
})
