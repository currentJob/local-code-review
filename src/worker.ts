/// <reference lib="webworker" />
/**
 * 모델 실행 전용 Web Worker. 화면이 멈추지 않게 추론을 여기서 한다.
 *
 * - WebGPU 가 있으면 GPU(fp16 가능하면 q4f16, 아니면 q4), 없으면 WASM(CPU)로 돌린다.
 * - 모델 파일은 Hugging Face 에서 받아 브라우저 Cache Storage('transformers-cache')에 보관한다.
 *   다음 방문부터는 다시 받지 않는다(브라우저가 저장소를 비우지 않는 한).
 * - 코드는 이 워커 밖(네트워크)으로 나가지 않는다. 네트워크는 모델 파일 다운로드에만 쓴다.
 */
import { InterruptableStoppingCriteria, TextStreamer, env, pipeline, type TextGenerationPipeline } from '@huggingface/transformers'
import { MODELS, type ModelId, type ToWorker, type FromWorker, type Backend } from './lib/protocol'
import { shouldStop } from './lib/review'

env.allowLocalModels = false
env.useBrowserCache = true

const post = (msg: FromWorker) => self.postMessage(msg)
const stopper = new InterruptableStoppingCriteria()
let generator: TextGenerationPipeline | null = null
let loaded: ModelId | null = null
let current: Backend | null = null

async function detectBackend(): Promise<Backend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu
  if (!gpu) return { device: 'wasm', dtype: 'q4', label: 'CPU (WASM)' }
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return { device: 'wasm', dtype: 'q4', label: 'CPU (WASM)' }
    return adapter.features.has('shader-f16')
      ? { device: 'webgpu', dtype: 'q4f16', label: 'GPU (WebGPU · fp16)' }
      : { device: 'webgpu', dtype: 'q4', label: 'GPU (WebGPU)' }
  } catch {
    return { device: 'wasm', dtype: 'q4', label: 'CPU (WASM)' }
  }
}

async function load(model: ModelId) {
  if (generator && loaded === model) { post({ type: 'ready', model, backend: current! }); return }
  generator = null; loaded = null
  const backend = await detectBackend()
  const files = new Map<string, { loaded: number; total: number }>()
  const make = (b: Backend) => pipeline('text-generation', MODELS[model].repo, {
    device: b.device,
    dtype: b.dtype,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file) return
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
      let done = 0, total = 0
      for (const f of files.values()) { done += f.loaded; total += f.total }
      post({ type: 'progress', loaded: done, total })
    },
  }) as Promise<TextGenerationPipeline>
  try {
    generator = await make(backend)
    current = backend
  } catch (error) {
    if (backend.device !== 'webgpu') throw error
    // 드라이버·브라우저에 따라 WebGPU 세션 생성이 실패한다 → CPU 로 한 번 더.
    const cpu: Backend = { device: 'wasm', dtype: 'q4', label: 'CPU (WASM) · GPU 실패로 전환' }
    generator = await make(cpu)
    current = cpu
  }
  loaded = model
  post({ type: 'ready', model, backend: current! })
}

async function review(id: number, messages: { role: string; content: string }[], maxTokens: number) {
  if (!generator) throw new Error('모델이 아직 준비되지 않았습니다.')
  stopper.reset()
  let text = ''
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk: string) => {
      text += chunk
      post({ type: 'token', id, text: chunk })
      if (shouldStop(text)) stopper.interrupt()
    },
  })
  await generator(messages, {
    max_new_tokens: maxTokens,
    do_sample: false,
    repetition_penalty: 1.1,
    streamer,
    stopping_criteria: stopper,
  } as Record<string, unknown>)
  post({ type: 'done', id, text })
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data
  try {
    if (msg.type === 'load') await load(msg.model)
    else if (msg.type === 'review') await review(msg.id, msg.messages, msg.maxTokens)
    else if (msg.type === 'cancel') stopper.interrupt()
  } catch (error) {
    post({ type: 'error', id: 'id' in msg ? msg.id : undefined, message: error instanceof Error ? error.message : String(error) })
  }
}
