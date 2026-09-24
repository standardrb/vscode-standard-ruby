import * as assert from 'assert'
import * as fs from 'fs'
import * as path from 'path'
import { before, beforeEach } from 'mocha'
import { ConfigurationTarget, Uri, workspace } from 'vscode'
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

async function setAdditionalLanguages (languages: unknown): Promise<void> {
  await workspace.getConfiguration('standardRuby').update('additionalLanguages', languages, ConfigurationTarget.Workspace)
}

suite('Standard Ruby', () => {
  beforeEach(async () => {
    await auto.reset()
    await setAdditionalLanguages(undefined)
    await workspace.getConfiguration('standardRuby').update('autofix', undefined, ConfigurationTarget.Workspace)
  })

  suite('language support', () => {
    test('normalizes additional languages', async () => {
      assert.deepEqual(extension.normalizeAdditionalLanguages(['erb', ' erb ', '', 'ruby', 'gemfile', 'erb']), ['erb'])
      assert.deepEqual(extension.normalizeAdditionalLanguages(undefined), [])
      assert.deepEqual(extension.normalizeAdditionalLanguages('erb'), [])
      assert.deepEqual(extension.normalizeAdditionalLanguages(['yaml', 1, null, 'erb']), ['yaml', 'erb'])
    })

    test('supports configured languages for diagnostics and formatting', async () => {
      const additionalLanguages = extension.normalizeAdditionalLanguages(['erb'])

      assert.equal(extension.diagnosticsSupportedLanguage('ruby', additionalLanguages), true)
      assert.equal(extension.diagnosticsSupportedLanguage('gemfile', additionalLanguages), true)
      assert.equal(extension.diagnosticsSupportedLanguage('erb', additionalLanguages), true)
      assert.equal(extension.diagnosticsSupportedLanguage('yaml', additionalLanguages), false)

      assert.equal(extension.formattingSupportedLanguage('ruby', additionalLanguages), true)
      assert.equal(extension.formattingSupportedLanguage('gemfile', additionalLanguages), true)
      assert.equal(extension.formattingSupportedLanguage('erb', additionalLanguages), true)
      assert.equal(extension.formattingSupportedLanguage('yaml', additionalLanguages), false)
    })

    test('requires file-backed documents only for configured language diagnostics', async () => {
      const additionalLanguages = extension.normalizeAdditionalLanguages(['yaml'])

      // Base languages keep the historical manual-sync behavior for untitled docs.
      assert.equal(extension.diagnosticsSupportedDocument({ languageId: 'ruby', uri: Uri.parse('untitled:example.rb') }, additionalLanguages), true)

      // Additional languages require a real file path.
      assert.equal(extension.diagnosticsSupportedDocument({ languageId: 'yaml', uri: Uri.file('/tmp/example.yml') }, additionalLanguages), true)
      assert.equal(extension.diagnosticsSupportedDocument({ languageId: 'yaml', uri: Uri.parse('untitled:example.yml') }, additionalLanguages), false)
      assert.equal(extension.diagnosticsSupportedDocument({ languageId: 'yaml', uri: Uri.file('/tmp/example.yml') }, []), false)
    })

    test('formatting document support respects scheme rules per language', async () => {
      const additionalLanguages = extension.normalizeAdditionalLanguages(['erb'])

      // Base languages format regardless of scheme (preserves untitled-.rb behavior).
      assert.equal(extension.formattingSupportedDocument({ languageId: 'ruby', uri: Uri.parse('untitled:example.rb') }, additionalLanguages), true)

      // Additional languages require a real file path.
      assert.equal(extension.formattingSupportedDocument({ languageId: 'erb', uri: Uri.file('/tmp/example.erb') }, additionalLanguages), true)
      assert.equal(extension.formattingSupportedDocument({ languageId: 'erb', uri: Uri.parse('untitled:example.erb') }, additionalLanguages), false)

      // Unlisted languages are never formatting-supported.
      assert.equal(extension.formattingSupportedDocument({ languageId: 'yaml', uri: Uri.file('/tmp/example.yml') }, additionalLanguages), false)
    })
  })

  suite('document selector', () => {
    test('uses only Ruby and Gemfile selectors by default', async () => {
      assert.deepEqual(extension.buildDocumentSelector([]), [
        { scheme: 'file', language: 'ruby' },
        { scheme: 'file', pattern: '**/Gemfile' }
      ])
    })

    test('adds configured additional languages as file-only selectors', async () => {
      assert.deepEqual(extension.buildDocumentSelector(extension.normalizeAdditionalLanguages(['yaml', ' yaml ', ''])), [
        { scheme: 'file', language: 'ruby' },
        { scheme: 'file', pattern: '**/Gemfile' },
        { scheme: 'file', language: 'yaml' }
      ])
    })

    test('reads updated additional languages when rebuilding client options', async () => {
      await setAdditionalLanguages(['yaml'])
      assert.deepEqual(extension.buildLanguageClientOptions().documentSelector, [
        { scheme: 'file', language: 'ruby' },
        { scheme: 'file', pattern: '**/Gemfile' },
        { scheme: 'file', language: 'yaml' }
      ])

      await setAdditionalLanguages([])
      assert.deepEqual(extension.buildLanguageClientOptions().documentSelector, [
        { scheme: 'file', language: 'ruby' },
        { scheme: 'file', pattern: '**/Gemfile' }
      ])
    })
  })

  suite('formatting guards', () => {
    test('forwards formatting for configured additional languages', async () => {
      await setAdditionalLanguages(['erb'])
      let forwarded = false
      const edits = extension.buildLanguageClientOptions().middleware?.provideDocumentFormattingEdits?.(
        { languageId: 'erb', uri: Uri.file('/tmp/example.erb') } as any,
        {} as any,
        {} as any,
        () => {
          forwarded = true
          return []
        }
      )

      assert.deepEqual(edits, [])
      assert.equal(forwarded, true)
    })

    test('does not forward formatting for non-file additional-language documents', async () => {
      await setAdditionalLanguages(['erb'])
      let forwarded = false
      const edits = extension.buildLanguageClientOptions().middleware?.provideDocumentFormattingEdits?.(
        { languageId: 'erb', uri: Uri.parse('untitled:example.erb') } as any,
        {} as any,
        {} as any,
        () => {
          forwarded = true
          return []
        }
      )

      assert.equal(edits, undefined)
      assert.equal(forwarded, false)
    })

    test('forwards Ruby formatting when autofix is enabled', async () => {
      await workspace.getConfiguration('standardRuby').update('autofix', true, ConfigurationTarget.Workspace)
      let forwarded = false
      const edits = extension.buildLanguageClientOptions().middleware?.provideDocumentFormattingEdits?.(
        { languageId: 'ruby', uri: Uri.file('/tmp/example.rb') } as any,
        {} as any,
        {} as any,
        () => {
          forwarded = true
          return []
        }
      )

      assert.deepEqual(edits, [])
      assert.equal(forwarded, true)
    })

    test('does not forward Ruby formatting when autofix is disabled', async () => {
      await workspace.getConfiguration('standardRuby').update('autofix', false, ConfigurationTarget.Workspace)
      let forwarded = false
      const edits = extension.buildLanguageClientOptions().middleware?.provideDocumentFormattingEdits?.(
        { languageId: 'ruby', uri: Uri.file('/tmp/example.rb') } as any,
        {} as any,
        {} as any,
        () => {
          forwarded = true
          return []
        }
      )

      assert.equal(edits, undefined)
      assert.equal(forwarded, false)
    })
  })

  suite('configuration schema and docs', () => {
    test('contributes additional languages setting and activation signal', async () => {
      const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))
      const properties = packageJson.contributes.configuration[0].properties

      assert.deepEqual(properties['standardRuby.additionalLanguages'].default, [])
      assert.equal(properties['standardRuby.additionalLanguages'].items.type, 'string')
      assert.match(properties['standardRuby.additionalLanguages'].markdownDescription, /diagnostics/i)
      assert.match(properties['standardRuby.additionalLanguages'].markdownDescription, /autocorrect/i)
      assert.match(properties['standardRuby.additionalLanguages'].markdownDescription, /formatOnSave/)
      assert.equal(properties['standardRuby.additionalDocumentLanguages'], undefined)
      assert.equal(properties['standardRuby.additionalFormattingLanguages'], undefined)
      assert.ok(packageJson.activationEvents.includes('workspaceContains:.standard.yml'))
      assert.equal(packageJson.activationEvents.includes('onLanguage:yaml'), false)
    })

    test('documents additional languages without overclaiming YAML support', async () => {
      const readme = fs.readFileSync(path.join(__dirname, '../../../README.md'), 'utf8')

      assert.match(readme, /standardRuby\.additionalLanguages/)
      assert.match(readme, /"standardRuby\.additionalLanguages": \["erb"\]/)
      assert.match(readme, /receive diagnostics and can use \*\*Format Document\*\*/i)
      assert.match(readme, /autocorrect/i)
      assert.match(readme, /editor\.defaultFormatter/)
      assert.match(readme, /editor\.formatOnSave/)
      assert.match(readme, /testdouble\.vscode-standard-ruby/)
      assert.doesNotMatch(readme, /general YAML linter/i)
    })
  })

  suite('lifecycle commands', () => {
    test('start', async () => {
      await auto.start()
      assert.notEqual(extension.languageClient, null)
      assert.equal(extension.languageClient?.state, State.Running)
    })

    test('stop', async () => {
      await auto.start()
      await auto.stop()
      assert.equal(extension.languageClient, null)
    })

    test('restart', async () => {
      await auto.restart()
      assert.notEqual(extension.languageClient, null)
      assert.equal(extension.languageClient?.state, State.Running)
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
