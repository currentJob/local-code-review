/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 는 /<repo>/ 아래에 올라간다. 배포 워크플로가 VITE_BASE_URL 을 넣는다.
export default defineConfig({
  base: process.env.VITE_BASE_URL ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  // transformers.js 는 ORT wasm 을 스스로 받는다. 사전 번들링하면 그 경로가 깨진다(OCR 프로젝트와 같은 이유).
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
