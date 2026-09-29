import { describe, expect, it } from 'vitest'
import { chunkFile, formatForModel, parseDiff } from './diff'

const GIT_DIFF = `diff --git a/src/db.sql b/src/db.sql
index 1111111..2222222 100644
--- a/src/db.sql
+++ b/src/db.sql
@@ -1,4 +1,4 @@
 SELECT 1;
--- old comment
+++ new comment
 SELECT 2;
 SELECT 3;
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -10,1 +10,1 @@
-  "version": "1.0.0"
+  "version": "1.0.1"
diff --git a/new.py b/new.py
new file mode 100644
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+def f():
+    return 1
\\ No newline at end of file
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`

describe('parseDiff', () => {
  const files = parseDiff(GIT_DIFF)

  it('splits files and keeps new-file line numbers', () => {
    expect(files.map((f) => f.path)).toEqual(['src/db.sql', 'package-lock.json', 'new.py', 'logo.png'])
    const sql = files[0]
    expect(sql.hunks[0].lines.map((l) => [l.kind, l.newLine])).toEqual([
      ['ctx', 1], ['del', null], ['add', 2], ['ctx', 3], ['ctx', 4],
    ])
  })

  it('reads "-- comment" / "++ comment" edits as content, not as file headers', () => {
    const sql = files[0]
    expect(sql.hunks[0].lines[1]).toMatchObject({ kind: 'del', text: '-- old comment' })
    expect(sql.hunks[0].lines[2]).toMatchObject({ kind: 'add', text: '++ new comment' })
    expect([sql.additions, sql.deletions]).toEqual([1, 1])
  })

  it('marks what not to review', () => {
    expect(files.map((f) => f.skip)).toEqual([null, '의존성 잠금 파일', null, '바이너리 파일'])
    expect(files[2]).toMatchObject({ status: 'added', additions: 2 })
  })

  it('handles plain diff -u output with several files', () => {
    const plain = '--- a.js\t2026-01-01\n+++ a.js\t2026-01-02\n@@ -1 +1 @@\n-x\n+y\n--- b.js\n+++ b.js\n@@ -3,0 +4 @@\n+z\n'
    const out = parseDiff(plain)
    expect(out.map((f) => [f.path, f.additions])).toEqual([['a.js', 1], ['b.js', 1]])
    expect(out[1].hunks[0].lines[0].newLine).toBe(4)
  })

  it('survives hand-edited diffs whose hunk line counts are wrong', () => {
    const tooBig = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,40 +1,50 @@\n x\n-y\n+z\ndiff --git a/b.py b/b.py\n--- a/b.py\n+++ b/b.py\n@@ -1,1 +1,1 @@\n-p\n+q\n'
    const tooSmall = '--- a/c.js\n+++ b/c.js\n@@ -1,1 +1,1 @@\n-a\n+b\n+c\n+d\n'
    expect(parseDiff(tooBig).map((f) => [f.path, f.additions, f.deletions])).toEqual([['a.ts', 1, 1], ['b.py', 1, 1]])
    expect(parseDiff(tooSmall)[0].additions).toBe(3)
  })

  it('treats pasted code (not a diff) as one new file numbered from 1', () => {
    const [f] = parseDiff('const a = 1\r\nconsole.log(a)\n')
    expect(f.path).toBe('붙여 넣은 코드')
    expect(f.hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2])
    expect(parseDiff('   \n')).toEqual([])
  })
})

describe('formatForModel / chunkFile', () => {
  it('prefixes new line numbers and blanks them on deleted lines', () => {
    const text = formatForModel(parseDiff(GIT_DIFF)[0].hunks)
    expect(text.split('\n').slice(1, 4)).toEqual(['   1   SELECT 1;', '     - -- old comment', '   2 + ++ new comment'])
  })

  it('splits big files into chunks under the size limit without losing lines', () => {
    const body = Array.from({ length: 400 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n')
    const [file] = parseDiff(`--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,400 @@\n${body}\n`)
    const chunks = chunkFile(file, 3000)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every((c) => formatForModel(c).length <= 3300)).toBe(true)
    expect(chunks.flat().flatMap((h) => h.lines).length).toBe(400)
  })
})
