import fs from 'node:fs'

const ENTRYPOINTS = ['all', 'run-all', 'ci', 'integration', 'pack-template-rules']
/** Only regular, top-level suite modules are executable. Errors are never an empty plan. */
export function discoverSuites(testDir, { helpers = [], integrationOnly = [] } = {}) {
  const normalize = id => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+(?:\.mjs)?$/.test(id)) throw new Error('invalid suite exclusion: ' + id)
    return id.replace(/\.mjs$/, '')
  }
  if (!Array.isArray(helpers) || !Array.isArray(integrationOnly)) throw new Error('suite exclusions must be arrays')
  const excluded = new Set([...ENTRYPOINTS, ...helpers.map(normalize), ...integrationOnly.map(normalize)])
  return fs.readdirSync(testDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.mjs') && !e.name.startsWith('_'))
    .map(e => e.name.slice(0, -4)).filter(id => !excluded.has(id)).sort()
}
