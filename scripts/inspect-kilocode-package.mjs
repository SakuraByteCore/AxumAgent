import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function npmJson(args) {
  return JSON.parse(execFileSync('npm', args.concat('--json'), { encoding: 'utf8' }))
}

const version = npmJson(['view', '@kilocode/cli@latest', 'version'])
const cli = npmJson(['view', `@kilocode/cli@${version}`, 'os', 'cpu', 'bin'])
console.log({ version, cli })

if (!cli.os?.includes('linux') || cli.os?.includes('android')) {
  throw new Error(`unexpected @kilocode/cli platform metadata: ${JSON.stringify(cli.os)}`)
}

const platformPackage = `@kilocode/cli-linux-arm64@${version}`
const platform = npmJson(['view', platformPackage, 'os', 'cpu', 'bin'])
console.log({ platformPackage, platform })

const dir = mkdtempSync(join(tmpdir(), 'kilocode-inspect-'))
const tarball = execFileSync('npm', ['pack', platformPackage, '--silent'], { cwd: dir, encoding: 'utf8' }).trim()
mkdirSync(join(dir, 'pkg'))
execFileSync('tar', ['-xzf', join(dir, tarball), '-C', join(dir, 'pkg'), '--strip-components=1'])
const fileOutput = execFileSync('file', [join(dir, 'pkg/bin/kilo')], { encoding: 'utf8' })
console.log(fileOutput)
if (!fileOutput.includes('aarch64')) throw new Error('linux-arm64 binary is not aarch64')
const binary = readFileSync(join(dir, 'pkg/bin/kilo'))
const needle = Buffer.from('/lib/ld-linux-aarch64.so.1')
if (!binary.includes(needle)) throw new Error('expected GNU/Linux dynamic loader marker not found')
console.log('KiloCode linux-arm64 package is GNU/Linux aarch64, not Android/bionic.')
