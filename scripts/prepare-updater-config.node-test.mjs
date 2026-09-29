import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdaterOverlay } from './prepare-updater-config.mjs'

test('updater overlay targets GitHub Releases and keeps signing protections', () => {
  const config = createUpdaterOverlay({ publicKey: 'cHVibGljLWtleQ==', repositoryName: 'owner/editor' })
  assert.equal(config.bundle.createUpdaterArtifacts, true)
  assert.deepEqual(config.plugins.updater.endpoints, ['https://github.com/owner/editor/releases/latest/download/latest.json'])
  assert.equal(config.plugins.updater.requireSignedVersion, true)
  assert.equal(config.plugins.updater.allowDowngrades, false)
  assert.equal(config.plugins.updater.dangerousAcceptInvalidCerts, false)
})

test('updater overlay rejects untrusted repository and multiline key input', () => {
  assert.throws(() => createUpdaterOverlay({ publicKey: 'a\nb', repositoryName: 'owner/editor' }), /单行/)
  assert.throws(() => createUpdaterOverlay({ publicKey: 'key', repositoryName: 'https://evil.example/editor' }), /格式无效/)
})
