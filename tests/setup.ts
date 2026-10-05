import fs from 'fs'
import path from 'path'

const runtimePath = path.resolve(__dirname, '.runtime-env.json')
if (!fs.existsSync(runtimePath)) {
  throw new Error('tests/.runtime-env.json is missing. Global setup did not run.')
}
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as Record<string, string>
for (const [key, value] of Object.entries(runtime)) {
  process.env[key] = value
}
