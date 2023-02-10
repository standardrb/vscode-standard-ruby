import * as path from 'path'
import * as Mocha from 'mocha'
import * as glob from 'glob'

export async function run (): Promise<void> {
  const mocha = new Mocha({
    asyncOnly: true,
    color: true,
    forbidOnly: process.env.CI != null,
    timeout: 30000,
    ui: 'tdd'
  })

  const testsRoot = path.resolve(__dirname, '..')

  return await new Promise((resolve, reject) => {
    glob('**/**.test.js', { cwd: testsRoot }, (err, files) => {
      if (err != null) {
        return reject(err)
      }

      files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)))

      try {
        mocha.run(failures => {
          if (failures > 0) {
            if (process.env.CI != null) {
              setTimeout(() => reject(new Error(`${failures} tests failed; pausing for dramatic effect.`)), 3000)
            } else {
              reject(new Error(`${failures} tests failed.`))
            }
          } else {
            resolve()
          }
        })
      } catch (err) {
        console.error(err)
        reject(err)
      }
    })
  })
}
