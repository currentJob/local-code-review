/**
 * `git diff` (unified diff) → 파일·hunk·줄.
 *
 * 리뷰 모델에게는 **새 파일 기준 줄 번호**를 붙여서 보낸다. 모델이 "L42" 라고 답하면 그 번호로
 * 화면의 줄을 찾는다. diff 가 아니라 코드만 붙여 넣은 경우도 한 파일짜리 diff 처럼 다룬다.
 */

export type LineKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: LineKind
  text: string
  /** 새 파일 기준 줄 번호(삭제된 줄은 null) */
  newLine: number | null
  oldLine: number | null
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary'
  hunks: Hunk[]
  additions: number
  deletions: number
  /** 리뷰에서 뺀 이유. 없으면 리뷰 대상 */
  skip: string | null
}

const SKIP_NAMES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|vendor|\.next|coverage|__pycache__)\//
const SKIP_EXT = /\.(min\.(js|css)|map|png|jpe?g|gif|webp|ico|pdf|zip|onnx|wasm|woff2?|ttf|lock)$/i

export function skipReason(file: Pick<DiffFile, 'path' | 'status' | 'additions'>): string | null {
  if (file.status === 'binary') return '바이너리 파일'
  if (file.status === 'deleted') return '삭제된 파일'
  if (SKIP_NAMES.test(file.path)) return '의존성 잠금 파일'
  if (SKIP_DIRS.test(file.path)) return '빌드 결과물·외부 코드'
  if (SKIP_EXT.test(file.path)) return '생성·압축·바이너리 파일'
  if (file.additions === 0) return '추가된 줄 없음'
  return null
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseDiff(input: string): DiffFile[] {
  const text = input.replace(/\r\n/g, '\n')
  if (!/^(diff --git |--- |@@ )/m.test(text)) return text.trim() ? [pastedCode(text)] : []

  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: Hunk | null = null
  let oldNo = 0, newNo = 0
  // hunk 머리의 줄 수만큼은 **무조건 내용**이다. 그래서 "-- 주석" 을 지운 줄("--- ...")이나
  // "++x" 를 더한 줄("+++x")을 파일 머리로 착각하지 않는다.
  let oldLeft = 0, newLeft = 0
  const rows = text.split('\n')

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    // 내용 줄은 ' ', '+', '-', '\' 로만 시작한다. 그래서 "diff --git"·"@@" 는 언제나 새 머리다.
    // 사람이 손본 diff 는 hunk 머리의 줄 수가 틀리기 쉬워, 줄 수가 남았는지는 "---/+++" 판단에만 쓴다.
    const content = hunk != null && /^[ +\-\\]/.test(raw) || (hunk != null && raw === '' && (oldLeft > 0 || newLeft > 0))
    const fileHeader = raw.startsWith('--- ') && Boolean(rows[i + 1]?.startsWith('+++ ')) && oldLeft <= 0 && newLeft <= 0
    if (content && !fileHeader) {
      const f = file as unknown as DiffFile
      const hk = hunk as unknown as Hunk
      if (raw.startsWith('+')) { hk.lines.push({ kind: 'add', text: raw.slice(1), newLine: newNo++, oldLine: null }); f.additions++; newLeft-- }
      else if (raw.startsWith('-')) { hk.lines.push({ kind: 'del', text: raw.slice(1), newLine: null, oldLine: oldNo++ }); f.deletions++; oldLeft-- }
      else if (raw.startsWith('\\')) { /* "\ No newline at end of file" */ }
      else { hk.lines.push({ kind: 'ctx', text: raw.slice(1), newLine: newNo++, oldLine: oldNo++ }); oldLeft--; newLeft-- }
      continue
    }
    const git = raw.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (git) {
      file = { path: git[2], status: 'modified', hunks: [], additions: 0, deletions: 0, skip: null }
      files.push(file); hunk = null
      continue
    }
    if (raw.startsWith('--- ')) {
      // `diff --git` 없이 `---`/`+++` 로 시작하는 diff(diff -u 등)는 여기서 파일이 시작된다.
      if (!file || (file as DiffFile).hunks.length) {
        file = { path: raw.slice(4).split('\t')[0].replace(/^a\//, ''), status: 'modified', hunks: [], additions: 0, deletions: 0, skip: null }
        files.push(file); hunk = null
      }
      if (raw.slice(4).startsWith('/dev/null')) (file as DiffFile).status = 'added'
      continue
    }
    if (!file) continue
    const f = file as DiffFile
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).split('\t')[0]
      if (path === '/dev/null') f.status = 'deleted'
      else f.path = path.replace(/^b\//, '')
      continue
    }
    if (raw.startsWith('new file mode')) { f.status = 'added'; continue }
    if (raw.startsWith('deleted file mode')) { f.status = 'deleted'; continue }
    if (raw.startsWith('rename to ')) { f.status = 'renamed'; f.path = raw.slice(10); continue }
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') { f.status = 'binary'; continue }
    const h = raw.match(HUNK_RE)
    if (h) {
      oldNo = Number(h[1]); oldLeft = h[2] == null ? 1 : Number(h[2])
      newNo = Number(h[3]); newLeft = h[4] == null ? 1 : Number(h[4])
      hunk = { header: raw, lines: [] }
      f.hunks.push(hunk)
    }
  }
  for (const f of files) f.skip = skipReason(f)
  return files
}

/** diff 가 아닌 코드 조각: 전부 '추가된 줄'로 보고 1번부터 번호를 붙인다. */
function pastedCode(text: string): DiffFile {
  const lines = text.replace(/\n$/, '').split('\n')
  return {
    path: '붙여 넣은 코드',
    status: 'added',
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((t, i) => ({ kind: 'add', text: t, newLine: i + 1, oldLine: null })) }],
    additions: lines.length,
    deletions: 0,
    skip: null,
  }
}

/** 모델에 보낼 형태: `  42 + code`. 삭제 줄은 번호 자리를 비운다. */
export function formatForModel(hunks: Hunk[]): string {
  return hunks.map((h) => [h.header, ...h.lines.map((l) => {
    const no = l.newLine == null ? '    ' : String(l.newLine).padStart(4)
    const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
    return `${no} ${mark} ${l.text}`
  })].join('\n')).join('\n')
}

/**
 * 한 파일을 모델 한 번에 넣을 크기로 나눈다(hunk 단위, 한 hunk 가 너무 크면 줄 단위로 자른다).
 * 작은 모델은 긴 입력에서 급격히 나빠져 조각을 작게 유지한다.
 */
export function chunkFile(file: DiffFile, maxChars = 6000): Hunk[][] {
  const pieces: Hunk[] = []
  for (const h of file.hunks) {
    let cur: Hunk = { header: h.header, lines: [] }
    let size = h.header.length
    for (const l of h.lines) {
      const add = l.text.length + 8
      if (cur.lines.length && size + add > maxChars) { pieces.push(cur); cur = { header: `${h.header} (이어서)`, lines: [] }; size = cur.header.length }
      cur.lines.push(l); size += add
    }
    if (cur.lines.length) pieces.push(cur)
  }
  const chunks: Hunk[][] = []
  let group: Hunk[] = []
  let size = 0
  for (const p of pieces) {
    const s = formatForModel([p]).length
    if (group.length && size + s > maxChars) { chunks.push(group); group = []; size = 0 }
    group.push(p); size += s
  }
  if (group.length) chunks.push(group)
  return chunks
}
