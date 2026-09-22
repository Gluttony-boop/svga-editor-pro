export type LocalProjectKind = 'recovery' | 'recent'

/** 只保留显示名称和工程内容，不持久化可被自动覆盖的原文件路径。 */
export interface LocalProjectSummary {
  id: string
  kind: LocalProjectKind
  name: string
  updatedAt: number
  size: number
  revision: number
}

export interface LocalProjectRecord extends LocalProjectSummary {
  archive: Blob
}

export interface LocalProjectPreferences {
  recoveryEnabled: boolean
  recentEnabled: boolean
  /** 清除或改变设置会增加代次，阻止较早开始的异步备份重新写回来。 */
  epoch: number
}

export interface LocalProjectSnapshot {
  entries: LocalProjectSummary[]
  preferences: LocalProjectPreferences
  bytesUsed: number
}

export interface LocalProjectRepository {
  snapshot(): Promise<LocalProjectSnapshot>
  get(id: string): Promise<LocalProjectRecord | undefined>
  put(record: LocalProjectRecord, expectedEpoch: number): Promise<'stored' | 'stale' | 'disabled'>
  remove(id: string): Promise<void>
  clear(): Promise<void>
  configure(patch: Partial<Pick<LocalProjectPreferences, 'recoveryEnabled' | 'recentEnabled'>>): Promise<LocalProjectPreferences>
  subscribe(listener: (change: 'written' | 'invalidated') => void): () => void
  close(): void
}
