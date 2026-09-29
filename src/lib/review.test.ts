import { describe, expect, it } from 'vitest'
import { parseDiff } from './diff'
import { buildMessages, parseFindings, reviewableLines, shouldStop, toMarkdown } from './review'

describe('parseFindings', () => {
  it('reads the requested format and tolerant variants from small models', () => {
    const answer = [
      '- [high] L12: 사용자 입력을 그대로 SQL 에 넣습니다. 바인딩 파라미터를 쓰세요.',
      '* [Medium] Line 30 - 예외를 삼킵니다.',
      '1. [낮음] 줄 7: 로그에 토큰이 남습니다.',
      '- [low]: 파일 전체에 테스트가 없습니다.',
      '여기서부터는 설명입니다.',
      '- [nit] L3: 이름이 깁니다.',
    ].join('\n')
    expect(parseFindings(answer)).toEqual([
      { severity: 'high', line: 12, message: '사용자 입력을 그대로 SQL 에 넣습니다. 바인딩 파라미터를 쓰세요.' },
      { severity: 'medium', line: 30, message: '예외를 삼킵니다.' },
      { severity: 'low', line: 7, message: '로그에 토큰이 남습니다.' },
      { severity: 'low', line: null, message: '파일 전체에 테스트가 없습니다.' },
    ])
  })

  it('drops "none" answers, duplicates and made-up line numbers', () => {
    expect(parseFindings('- 없음')).toEqual([])
    expect(parseFindings('- [low] L1: 없음')).toEqual([])
    const twice = '- [high] L2: 같은 지적\n- [high] L2: 같은 지적'
    expect(parseFindings(twice)).toHaveLength(1)
    expect(parseFindings('- [high] L999: 없는 줄', new Set([1, 2]))).toEqual([{ severity: 'high', line: null, message: '없는 줄' }])
  })
})

describe('prompt and export', () => {
  const [file] = parseDiff('--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n keep()\n-old()\n+eval(input)\n')

  it('sends the numbered diff with the file path', () => {
    const messages = buildMessages(file.path, file.hunks)
    // system → 예시 질문 → 예시 답 → 실제 파일
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(parseFindings(messages[2].content).map((f) => f.line)).toEqual([2, 3])
    const user = messages[3]
    expect(user.content).toContain('File: a.js')
    expect(user.content).toContain('   2 + eval(input)')
    expect([...reviewableLines(file.hunks)]).toEqual([1, 2])
  })

  it('exports markdown with counts and a no-findings line', () => {
    const md = toMarkdown([
      { path: 'a.js', findings: [{ severity: 'high', line: 2, message: 'eval 금지' }] },
      { path: 'b.js', findings: [] },
    ], 'Qwen2.5-Coder-0.5B')
    expect(md).toContain('(1건)')
    expect(md).toContain('- **높음** `L2` eval 금지')
    expect(md).toContain('### `b.js`\n- 지적 사항 없음')
  })
})

describe('shouldStop', () => {
  it('stops on repeated lines, NONE, or too many findings, but not mid-line', () => {
    expect(shouldStop('- 없음\n- 없음\n')).toBe(true)
    expect(shouldStop('NONE\n')).toBe(true)
    expect(shouldStop('NON')).toBe(false)
    expect(shouldStop('- [high] L1: a\n- [low] L2: b\n- [low] L2')).toBe(false)
    expect(shouldStop(Array.from({ length: 6 }, (_, i) => `- [low] L${i}: x${i}`).join('\n') + '\n')).toBe(true)
  })
})

describe('small-model repetition', () => {
  const loop = [1, 2, 3].map((n) => `- [high] L${n}: 같은 말을 반복합니다 → 같은 말`).join('\n') + '\n'
  it('stops generation and keeps a single finding when only the line number changes', () => {
    expect(shouldStop(loop)).toBe(true)
    expect(parseFindings(loop)).toEqual([{ severity: 'high', line: 1, message: '같은 말을 반복합니다 → 같은 말' }])
  })
})
