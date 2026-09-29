/**
 * 리뷰 요청문과 모델 답 해석.
 *
 * 작은 모델(0.5B~1.5B)은 JSON 같은 엄격한 형식을 자주 깨뜨린다. 그래서 한 줄에 하나씩
 * `- [high] L42: 설명` 형식만 요구하고, 해석은 관대하게 한다. 형식에서 벗어난 줄은 버리지 않고
 * 원문 보기에 그대로 남는다.
 */
import { formatForModel, type Hunk } from './diff'

export type Severity = 'high' | 'medium' | 'low'

export interface Finding {
  severity: Severity
  /** 새 파일 기준 줄 번호. 모델이 번호를 안 줬으면 null */
  line: number | null
  message: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

// 작은 모델은 형식 설명보다 **예시 한 쌍**을 훨씬 잘 따른다. 설명에 "[high|medium|low]" 처럼 자리표시를
// 쓰면 그대로 베껴 쓰고, "문제가 없으면 '없음'" 을 한국어로 주면 그 줄만 반복했다(0.5B 실측).
const SYSTEM = `You review code changes. Find real defects in the added lines (marked +):
security holes (SQL injection, secrets in logs, eval of input), bugs (wrong logic, off-by-one, missing await, null access),
swallowed errors, leaked resources, data loss.
Ignore style and naming. Each line of the diff starts with its line number.
Write one line per defect, in Korean, exactly like the example: - [high] L<line>: <problem> → <fix>
Severity is high, medium or low. At most 5 lines. No other text.
If there is no defect, write only: NONE`

const EXAMPLE_USER = `File: app.js

@@ -1,3 +1,5 @@
   1   function getUser(id) {
   2 +   const q = "SELECT * FROM users WHERE id = " + id
   3 +   console.log("token", process.env.API_TOKEN)
   4 +   return db.run(q)
   5   }`

const EXAMPLE_ANSWER = `- [high] L2: 입력값을 SQL 문자열에 그대로 이어 붙여 SQL 인젝션 위험이 있습니다 → 바인딩 파라미터로 전달하세요.
- [medium] L3: 비밀 토큰을 로그에 남깁니다 → 로그에서 빼거나 가리세요.`

export function buildMessages(path: string, hunks: Hunk[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: EXAMPLE_USER },
    { role: 'assistant', content: EXAMPLE_ANSWER },
    { role: 'user', content: `File: ${path}\n\n${formatForModel(hunks)}` },
  ]
}

const SEVERITY: Record<string, Severity> = {
  high: 'high', critical: 'high', major: 'high', '높음': 'high', '심각': 'high',
  medium: 'medium', med: 'medium', moderate: 'medium', '보통': 'medium', '중간': 'medium',
  low: 'low', minor: 'low', info: 'low', '낮음': 'low',
}

const LINE_RE = /^\s*(?:[-*•]|\d+[.)])?\s*\[?\s*([A-Za-z가-힣]+)\s*\]?\s*[:\-–]?\s*(?:L(?:ine)?\s*|줄\s*|line\s*)?(\d+)?\s*[:\-–)]?\s*(.+)$/i

export function parseFindings(answer: string, validLines?: Set<number>): Finding[] {
  const out: Finding[] = []
  for (const raw of answer.split('\n')) {
    const m = raw.match(LINE_RE)
    if (!m) continue
    const severity = SEVERITY[m[1].toLowerCase()]
    if (!severity) continue
    let line = m[2] ? Number(m[2]) : null
    // 모델이 없는 줄 번호를 지어내면 번호만 버리고 지적은 남긴다.
    if (line != null && validLines && !validLines.has(line)) line = null
    const message = m[3].trim().replace(/^[:\-–]\s*/, '')
    if (!message || /^(없음|none)\.?$/i.test(message)) continue
    // 같은 문장을 줄 번호만 바꿔 되풀이하면 첫 번째만 남긴다.
    if (out.some((f) => f.message === message)) continue
    out.push({ severity, line, message })
  }
  return out
}

/** 변경된(추가·문맥) 줄 번호들 — 모델이 가리킬 수 있는 줄. */
export function reviewableLines(hunks: Hunk[]): Set<number> {
  const set = new Set<number>()
  for (const h of hunks) for (const l of h.lines) if (l.newLine != null) set.add(l.newLine)
  return set
}

/**
 * 작은 모델은 같은 줄을 끝없이 반복하곤 한다. 끝난 줄이 앞 줄과 같거나, "NONE" 으로 답했거나,
 * 지적이 5줄을 넘으면 거기서 멈춘다(토큰과 시간을 아낀다).
 */
export function shouldStop(text: string): boolean {
  const done = text.split('\n').slice(0, -1).map((l) => l.trim()).filter(Boolean)
  if (!done.length) return false
  if (/^NONE\b/i.test(done[0])) return true
  // 줄 번호만 바꿔 같은 문장을 되풀이하는 경우도 반복으로 본다.
  const bodies = done.map(messageBody)
  if (new Set(bodies).size < bodies.length) return true
  return done.filter((l) => /^[-*]?\s*\[/.test(l)).length > 5
}

/** "- [high] L12: 설명" → "설명" (반복 판정용). */
function messageBody(line: string): string {
  return line.replace(/^[-*\d.)\s]*\[?[A-Za-z가-힣]+\]?\s*[:\-–]?\s*(?:L(?:ine)?\s*|줄\s*)?\d*\s*[:\-–)]?\s*/i, '').trim()
}

const LABEL: Record<Severity, string> = { high: '높음', medium: '보통', low: '낮음' }
export const severityLabel = (s: Severity) => LABEL[s]

export interface FileReview {
  path: string
  findings: Finding[]
}

export function toMarkdown(reviews: FileReview[], model: string): string {
  const total = reviews.reduce((n, r) => n + r.findings.length, 0)
  const body = reviews.map((r) => {
    const items = r.findings.length
      ? r.findings.map((f) => `- **${LABEL[f.severity]}**${f.line != null ? ` \`L${f.line}\`` : ''} ${f.message}`).join('\n')
      : '- 지적 사항 없음'
    return `### \`${r.path}\`\n${items}`
  }).join('\n\n')
  return `## 로컬 AI 코드리뷰 (${total}건)\n\n${body}\n\n> ${model} · 브라우저에서 실행, 코드는 기기 밖으로 나가지 않음. 작은 모델의 의견이니 사람이 확인하세요.\n`
}
