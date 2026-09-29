/** 화면 ↔ 워커 메시지와 모델 목록. */

// 0.5B 도 시험했지만 같은 문장을 줄 번호만 바꿔 되풀이하고 명백한 SQL 인젝션도 놓쳐 뺐다(2026-09-29 실측).
export const MODELS = {
  'coder-1.5b': {
    repo: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    name: 'Qwen2.5-Coder 1.5B',
    size: '약 1.3GB (GPU) · 1.9GB (CPU)',
    note: '더 정확 · WebGPU 권장',
  },
} as const

export type ModelId = keyof typeof MODELS

export interface Backend {
  device: 'webgpu' | 'wasm'
  dtype: 'q4f16' | 'q4'
  label: string
}

export type ToWorker =
  | { type: 'load'; model: ModelId }
  | { type: 'review'; id: number; messages: { role: string; content: string }[]; maxTokens: number }
  | { type: 'cancel' }

export type FromWorker =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; model: ModelId; backend: Backend }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }
