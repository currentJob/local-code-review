import { expect, it } from 'vitest'
import { parseDiff } from './diff'
import { SAMPLE_DIFF } from './sample'

it('the built-in sample parses into its three files with consistent hunk counts', () => {
  const files = parseDiff(SAMPLE_DIFF)
  expect(files.map((f) => [f.path, f.skip])).toEqual([['src/users.ts', null], ['jobs/sync.py', null], ['package-lock.json', '의존성 잠금 파일']])
  for (const f of files) for (const h of f.hunks) {
    const [, , oldCount, , newCount] = h.header.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/)!.map(Number)
    expect(h.lines.filter((l) => l.kind !== 'add').length).toBe(oldCount)
    expect(h.lines.filter((l) => l.kind !== 'del').length).toBe(newCount)
  }
})
