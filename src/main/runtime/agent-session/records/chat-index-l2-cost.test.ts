// @orca-isolated-worker -- Suite hooks own the temporary SQL worker bundle.
// Scratch benchmark for chat-index-l2 (not committed): per-request cost of whole-history scans.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  storedTestAgentSessionRecord,
  withTestAgentSessionDatabase
} from './agent-session-record-store-persistence.test-fixture'
import { openTestAgentSessionDatabase, closeTestAgentSessionDatabase } from './agent-session-record-store-test-harness'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { structuredAgentSessionNamingSnapshot } from '../../../native-chat/agent-session-wire/observations/structured-agent-session-status-feed-deps'
import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { agentSessionExecutionLocationsEqual } from '../../../../shared/agent-session/lifecycle/agent-session-record'

const SIZES = (process.env.L2_SIZES ?? '1000,9500,18000,36000').split(',').map(Number)
const WORKSPACES = 1900

function seedRow(index: number) {
  const sessionId = `chat-${String(index).padStart(6, '0')}`
  const base = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, claimStatus: 'released', ownerProcess: null, reservedSpawnToken: null })
  )
  return storedTestAgentSessionRecord({
    ...base,
    location: { ...base.location, workspaceId: `workspace-${index % WORKSPACES}` },
    conversationName: `Chat ${index} about a reasonably long topic name`
  })
}

function time(runs: number, fn: () => unknown): number {
  fn()
  const t = performance.now()
  for (let i = 0; i < runs; i++) fn()
  return +((performance.now() - t) / runs).toFixed(2)
}

it('chat-index-l2 cost', { timeout: 1_800_000 }, async () => {
  const results: unknown[] = []
  for (const total of SIZES) {
    const root = await mkdtemp(join(tmpdir(), 'l2-bench-'))
    const journalDatabase = await openTestAgentSessionDatabase(root)
    await withTestAgentSessionDatabase(root, (db) => {
      const insert = db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
      db.exec('BEGIN')
      for (let i = 0; i < total; i++) {
        const row = seedRow(i)
        insert.run(row.sessionId, JSON.stringify(row))
      }
      db.exec('COMMIT')
    })
    const store = AgentSessionRecordStore.open({
      journalDatabase,
      records: await journalDatabase.loadRecords(),
      hostId: 'local',
      legacySessionTabIds: []
    })
    const location = store.listConversations()[0]!.location
    const naming = structuredAgentSessionNamingSnapshot({
      getConversation: store.getConversation,
      listConversations: store.listConversations,
      namingActiveSessionIds: () => [],
      namingFailure: () => undefined
    } as never)
    results.push({
      total,
      listConversationsMs: time(20, () => store.listConversations()),
      aiVaultOwnershipProjectionMs: time(20, () => listStructuredProviderSessionOwnership(store.listConversations())),
      workspaceSelectionMs: time(20, () =>
        store.listConversations().filter((c) => agentSessionExecutionLocationsEqual(c.location, location))
      ),
      namingSnapshotMs: time(20, () =>
        structuredAgentSessionNamingSnapshot({
          getConversation: store.getConversation,
          listConversations: store.listConversations,
          namingActiveSessionIds: () => [],
          namingFailure: () => undefined
        } as never)
      ),
      namingSnapshotBytes: Buffer.byteLength(JSON.stringify(naming))
    })
    await closeTestAgentSessionDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
  console.log('L2-COST ' + JSON.stringify(results))
})
