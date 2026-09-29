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

test('updater overlay can select a public HTTPS mirror without source changes', () => {
  const config = createUpdaterOverlay({ publicKey: 'cHVibGljLWtleQ==', repositoryName: 'owner/editor', updateEndpoint: 'https://updates.example.com/latest.json' })
  assert.deepEqual(config.plugins.updater.endpoints, ['https://updates.example.com/latest.json'])
})

test('updater overlay rejects secrets and unsafe transports in custom endpoints', () => {
  for (const updateEndpoint of ['http://updates.example.com/latest.json', 'https://user:pass@updates.example.com/latest.json', 'https://updates.example.com/latest.json?token=abc', 'https://updates.example.com/secret/latest.json', 'https://updates.example.com:8443/latest.json']) {
    assert.throws(() => createUpdaterOverlay({ publicKey: 'key', repositoryName: 'owner/editor', updateEndpoint }), /HTTPS/)
  }
})
