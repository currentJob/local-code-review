import { useEffect, useMemo, useRef, useState } from 'react'
import { chunkFile, parseDiff, type DiffFile } from './lib/diff'
import { buildMessages, parseFindings, reviewableLines, severityLabel, toMarkdown, type Finding } from './lib/review'
import { MODELS, type Backend, type FromWorker, type ModelId } from './lib/protocol'
import { SAMPLE_DIFF } from './lib/sample'

type ModelState =
  | { kind: 'idle' }
  | { kind: 'loading'; loaded: number; total: number }
  | { kind: 'ready'; backend: Backend }
  | { kind: 'error'; message: string }

interface FileResult {
  status: 'waiting' | 'running' | 'done' | 'stopped' | 'error'
  findings: Finding[]
  raw: string
  part: number
  parts: number
}

const CACHE_NAME = 'transformers-cache'
const MAX_TOKENS = 400
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes > 1e9 ? 0 : 1)}MB`

export default function App() {
  const [input, setInput] = useState('')
  const files = useMemo(() => parseDiff(input), [input])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const model: ModelId = 'coder-1.5b'
  const [modelState, setModelState] = useState<ModelState>({ kind: 'idle' })
  const [results, setResults] = useState<Record<string, FileResult>>({})
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState('')
  const [storage, setStorage] = useState<{ used: number; persisted: boolean; hasModel: boolean } | null>(null)
  const [copied, setCopied] = useState(false)
  const worker = useRef<Worker | null>(null)
  const waiters = useRef(new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>())
  const stopRef = useRef(false)
  const seq = useRef(0)

  // 워커는 한 번만 만든다.
  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (event: MessageEvent<FromWorker>) => {
      const msg = event.data
      if (msg.type === 'progress') setModelState({ kind: 'loading', loaded: msg.loaded, total: msg.total })
      else if (msg.type === 'ready') { setModelState({ kind: 'ready', backend: msg.backend }); refreshStorage() }
      else if (msg.type === 'token') setLive((t) => t + msg.text)
      else if (msg.type === 'done') { waiters.current.get(msg.id)?.resolve(msg.text); waiters.current.delete(msg.id) }
      else if (msg.type === 'error') {
        if (msg.id != null) { waiters.current.get(msg.id)?.reject(new Error(msg.message)); waiters.current.delete(msg.id) }
        else setModelState({ kind: 'error', message: msg.message })
      }
    }
    worker.current = w
    refreshStorage()
    return () => w.terminate()
  }, [])

  async function refreshStorage() {
    try {
      const cache = await caches.open(CACHE_NAME)
      let used = 0, hasModel = false
      for (const req of await cache.keys()) {
        const res = await cache.match(req)
        used += Number(res?.headers.get('content-length') ?? 0)
        if (req.url.includes(MODELS[model].repo) && /\.onnx(_data)?$/.test(req.url)) hasModel = true
      }
      setStorage({ used, persisted: (await navigator.storage?.persisted?.()) ?? false, hasModel })
    } catch { setStorage(null) }
  }

  async function prepareModel() {
    setModelState({ kind: 'loading', loaded: 0, total: 0 })
    // 수백 MB 를 받으므로 브라우저가 임의로 지우지 않게 요청한다(거절돼도 동작은 같다).
    try { await navigator.storage?.persist?.() } catch { /* 지원하지 않는 브라우저 */ }
    worker.current?.postMessage({ type: 'load', model })
  }

  async function deleteModels() {
    if (!window.confirm('이 브라우저에 저장한 모델 파일을 모두 지울까요? 다음에 쓸 때 다시 받습니다.')) return
    await caches.delete(CACHE_NAME)
    setModelState({ kind: 'idle' })
    worker.current?.terminate()
    // 메모리에 올린 모델도 버리도록 워커를 새로 만든다.
    location.reload()
  }

  function ask(messages: { role: string; content: string }[]) {
    const id = ++seq.current
    return new Promise<string>((resolve, reject) => {
      waiters.current.set(id, { resolve, reject })
      worker.current?.postMessage({ type: 'review', id, messages, maxTokens: MAX_TOKENS })
    })
  }

  const targets = files.filter((f) => !f.skip && !excluded.has(f.path))

  async function runReview() {
    if (modelState.kind !== 'ready' || !targets.length) return
    stopRef.current = false
    setRunning(true)
    const initial: Record<string, FileResult> = {}
    const plans = targets.map((f) => ({ file: f, chunks: chunkFile(f) }))
    for (const { file, chunks } of plans) initial[file.path] = { status: 'waiting', findings: [], raw: '', part: 0, parts: chunks.length }
    setResults(initial)
    for (const { file, chunks } of plans) {
      for (let i = 0; i < chunks.length; i++) {
        if (stopRef.current) break
        setResults((r) => ({ ...r, [file.path]: { ...r[file.path], status: 'running', part: i + 1 } }))
        setLive('')
        try {
          const answer = await ask(buildMessages(file.path, chunks[i]))
          const found = parseFindings(answer, reviewableLines(chunks[i]))
          setResults((r) => {
            const prev = r[file.path]
            return { ...r, [file.path]: { ...prev, findings: [...prev.findings, ...found], raw: `${prev.raw}${prev.raw ? '\n\n' : ''}${answer}` } }
          })
        } catch (error) {
          setResults((r) => ({ ...r, [file.path]: { ...r[file.path], status: 'error', raw: String(error) } }))
          break
        }
      }
      setResults((r) => ({ ...r, [file.path]: { ...r[file.path], status: stopRef.current ? 'stopped' : r[file.path].status === 'error' ? 'error' : 'done' } }))
      if (stopRef.current) break
    }
    setLive('')
    setRunning(false)
  }

  function stop() {
    stopRef.current = true
    worker.current?.postMessage({ type: 'cancel' })
  }

  async function openFile(file: File | undefined) {
    if (!file) return
    if (file.size > 2_000_000) { window.alert('2MB 이하의 diff 파일만 열 수 있습니다.'); return }
    setInput(await file.text())
    setResults({})
  }

  const reviewed = Object.entries(results).map(([path, r]) => ({ path, findings: r.findings }))
  const total = reviewed.reduce((n, r) => n + r.findings.length, 0)

  async function copyMarkdown() {
    await navigator.clipboard.writeText(toMarkdown(reviewed, MODELS[model].name))
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="app">
      <header className="hero">
        <p className="eyebrow">Local AI · Code review</p>
        <h1>로컬 AI 코드리뷰</h1>
        <p>변경 사항(git diff)을 브라우저 안의 코드 모델이 검토합니다. <strong>코드는 이 기기 밖으로 나가지 않습니다.</strong></p>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>1. 변경 사항</h2>
          <div className="howto">
            <span>터미널에서 복사:</span>
            <code>git diff | clip</code><span className="muted">Windows</span>
            <code>git diff | pbcopy</code><span className="muted">macOS</span>
            <code>git diff main...HEAD</code><span className="muted">브랜치 전체</span>
          </div>
          <textarea
            value={input}
            onChange={(e) => { setInput(e.target.value); setResults({}) }}
            placeholder="여기에 git diff 결과나 코드를 붙여 넣으세요."
            spellCheck={false}
            wrap="off"
            aria-label="diff 입력"
          />
          <div className="row">
            <label className="button secondary">
              .diff / .patch 열기
              <input type="file" accept=".diff,.patch,.txt,text/plain" onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = '' }} />
            </label>
            <button className="secondary" type="button" onClick={() => { setInput(SAMPLE_DIFF); setResults({}) }}>예제 diff 넣기</button>
            {input && <button className="ghost" type="button" onClick={() => { setInput(''); setResults({}) }}>지우기</button>}
          </div>
          {files.length > 0 && (
            <ul className="files">
              {files.map((f) => (
                <li key={f.path} className={f.skip ? 'skipped' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={Boolean(f.skip) || running}
                      checked={!f.skip && !excluded.has(f.path)}
                      onChange={(e) => setExcluded((s) => { const n = new Set(s); if (e.target.checked) n.delete(f.path); else n.add(f.path); return n })}
                    />
                    <span className="path">{f.path}</span>
                  </label>
                  <span className="stat">{f.skip ?? <><b className="add">+{f.additions}</b> <b className="del">−{f.deletions}</b></>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>2. 모델</h2>
          <div className="model on">
            <strong>{MODELS[model].name}</strong>
            <span className="muted">{MODELS[model].size} · 코드 전용 모델 (Apache-2.0)</span>
          </div>
          <ModelStatus state={modelState} onPrepare={prepareModel} />
          {modelState.kind === 'ready' && storage && !storage.hasModel && (
            <p className="status warn">이 브라우저가 모델 파일을 보관하지 못했습니다(시크릿 창·저장공간 부족 등). 다음에 열면 다시 받습니다.</p>
          )}
          <p className="muted small">
            모델은 Hugging Face 에서 한 번 받아 이 브라우저에 보관합니다.
            {storage && <> 현재 {mb(storage.used)} 사용{storage.persisted ? ' · 영구 보관' : ''}.</>}
            {storage && storage.used > 0 && <> <button className="link" type="button" onClick={deleteModels}>저장한 모델 지우기</button></>}
          </p>

          <h2>3. 리뷰</h2>
          <div className="row">
            <button type="button" onClick={runReview} disabled={modelState.kind !== 'ready' || running || !targets.length}>
              {running ? '리뷰 중…' : `리뷰 시작 (${targets.length}개 파일)`}
            </button>
            {running && <button className="secondary" type="button" onClick={stop}>중단</button>}
            {!running && total > 0 && <button className="secondary" type="button" onClick={copyMarkdown}>{copied ? '복사했습니다' : '마크다운 복사'}</button>}
          </div>
          {modelState.kind !== 'ready' && <p className="muted small">먼저 모델을 준비하세요.</p>}
          {running && live && <pre className="live" aria-live="polite">{live}</pre>}
        </section>

        {Object.keys(results).length > 0 && (
          <section className="panel results">
            <h2>결과 · {total}건</h2>
            {Object.entries(results).map(([path, r]) => (
              <FileCard key={path} path={path} result={r} file={files.find((f) => f.path === path)} />
            ))}
            <p className="muted small">작은 모델의 의견입니다. 틀린 지적이 섞일 수 있으니 사람이 확인하세요.</p>
          </section>
        )}
      </main>

      {/* 모바일: 지금 할 다음 동작 하나를 화면 아래에 고정한다(긴 한 줄 화면에서 버튼을 찾으러 스크롤하지 않게). */}
      <div className="mobile-actions" role="region" aria-label="빠른 실행">
        {running ? (
          <button type="button" className="secondary" onClick={stop}>중단</button>
        ) : modelState.kind === 'ready' ? (
          <button type="button" onClick={runReview} disabled={!targets.length}>{targets.length ? `리뷰 시작 (${targets.length}개 파일)` : '변경 사항을 먼저 넣으세요'}</button>
        ) : modelState.kind === 'loading' ? (
          <button type="button" disabled>모델 준비 중…</button>
        ) : (
          <button type="button" onClick={prepareModel}>모델 준비 (약 1.3GB)</button>
        )}
        {Object.keys(results).length > 0 && (
          <button type="button" className="secondary" onClick={() => document.querySelector('.results')?.scrollIntoView({ behavior: 'smooth' })}>
            결과 {total}건
          </button>
        )}
      </div>

      <footer className="foot">
        <b>로컬 AI 코드리뷰</b> · 처리는 모두 이 브라우저에서 합니다 · 모델: Qwen2.5-Coder (Apache-2.0) · 실행: transformers.js / ONNX Runtime Web ·{' '}
        <a href="https://github.com/currentJob/local-code-review" target="_blank" rel="noreferrer">소스</a>
      </footer>
    </div>
  )
}

function ModelStatus({ state, onPrepare }: { state: ModelState; onPrepare: () => void }) {
  if (state.kind === 'ready') return <p className="status ok">준비됨 · {state.backend.label}{state.backend.device === 'wasm' && ' — GPU 가 없어 느릴 수 있습니다'}</p>
  if (state.kind === 'loading') {
    const pct = state.total ? Math.round((state.loaded / state.total) * 100) : 0
    return (
      <div className="status">
        <progress max={100} value={pct} aria-label="모델 다운로드" />
        <span>{state.total ? `${mb(state.loaded)} / ${mb(state.total)} (${pct}%)` : '모델 준비 중…'}</span>
      </div>
    )
  }
  return (
    <div className="row">
      <button type="button" onClick={onPrepare}>모델 준비</button>
      {state.kind === 'error' && <span className="status bad">불러오지 못했습니다: {state.message}</span>}
    </div>
  )
}

function FileCard({ path, result, file }: { path: string; result: FileResult; file?: DiffFile }) {
  const label = { waiting: '대기', running: result.parts > 1 ? `검토 중 ${result.part}/${result.parts}` : '검토 중', done: '완료', stopped: '중단됨', error: '오류' }[result.status]
  return (
    <article className="filecard">
      <header><span className="path">{path}</span><span className={`badge ${result.status}`}>{label}</span></header>
      {result.status === 'done' && !result.findings.length && <p className="muted">지적 사항 없음</p>}
      <ul className="findings">
        {result.findings.map((f, i) => (
          <li key={i} className={`sev-${f.severity}`}>
            <span className="sev">{severityLabel(f.severity)}</span>
            {f.line != null && <span className="line">L{f.line}</span>}
            <span className="msg">{f.message}</span>
            {f.line != null && file && <Snippet file={file} line={f.line} />}
          </li>
        ))}
      </ul>
      {result.raw && <details><summary>모델 원문</summary><pre>{result.raw}</pre></details>}
    </article>
  )
}

/** 지적한 줄 앞뒤 3줄. */
function Snippet({ file, line }: { file: DiffFile; line: number }) {
  for (const h of file.hunks) {
    const at = h.lines.findIndex((l) => l.newLine === line)
    if (at < 0) continue
    const around = h.lines.slice(Math.max(0, at - 3), at + 4)
    return (
      <pre className="snippet">{around.map((l, i) => (
        <div key={i} className={`${l.kind}${l.newLine === line ? ' hit' : ''}`}>
          <span className="no">{l.newLine ?? ''}</span>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '} {l.text}
        </div>
      ))}</pre>
    )
  }
  return null
}
