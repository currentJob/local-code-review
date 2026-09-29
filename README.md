# 로컬 AI 코드리뷰

`git diff` 를 붙여 넣으면 **브라우저 안의 코드 모델**이 변경 사항을 검토합니다. 서버가 없고, 코드는 기기 밖으로 나가지 않습니다.

[사이트 열기](https://currentjob.github.io/local-code-review/)

## 쓰는 법

1. 터미널에서 변경 사항을 복사합니다: `git diff | clip`(Windows), `git diff | pbcopy`(macOS), 브랜치 전체는 `git diff main...HEAD`.
2. 붙여 넣거나 `.diff`/`.patch` 파일을 엽니다. 코드만 붙여 넣어도 됩니다.
3. **모델 준비**(첫 회 약 1.3GB 다운로드) → **리뷰 시작**.
4. 결과는 파일별 지적(심각도·줄 번호·앞뒤 코드)으로 보이고, **마크다운 복사**로 PR 코멘트에 붙일 수 있습니다.

## 구성

| 부분 | 내용 |
|---|---|
| 모델 | [Qwen2.5-Coder-1.5B-Instruct](https://huggingface.co/onnx-community/Qwen2.5-Coder-1.5B-Instruct) ONNX (Apache-2.0). WebGPU + fp16 이면 `q4f16`(약 1.3GB), 아니면 `q4` |
| 실행 | [transformers.js](https://github.com/huggingface/transformers.js) 4.2 · ONNX Runtime Web. **Web Worker** 에서 돌려 화면이 멈추지 않는다. WebGPU 가 없거나 실패하면 CPU(WASM)로 전환(느림) |
| 보관 | 모델은 Hugging Face 에서 한 번 받아 Cache Storage(`transformers-cache`)에 둔다. 영구 보관을 요청하고(`navigator.storage.persist`), 보관에 실패하면 화면에 알린다. "저장한 모델 지우기"로 지울 수 있다 |
| diff 해석 | `src/lib/diff.ts` — 파일·hunk·새 파일 기준 줄 번호. lock 파일·빌드 결과물·바이너리·삭제 파일은 뺀다. hunk 머리의 줄 수가 틀린(손본) diff 도 읽는다. 큰 파일은 6,000자 단위로 나눈다 |
| 요청·해석 | `src/lib/review.ts` — 예시 한 쌍을 넣은 요청문, `- [high] L12: …` 형식을 관대하게 읽는 해석기, 반복 감지(줄 번호만 바꾼 되풀이 포함) 시 생성 중단 |

## 한계

- **1.5B 모델의 의견입니다.** 예제 diff 에서 `except: pass`, `with` 없는 `open` 은 짚었지만, 비밀번호 로그 출력과 `Math.floor` 버그는 놓쳤고 SQL 문자열 조립은 낮은 심각도로 봤습니다. 줄 번호가 한두 줄 어긋나기도 합니다. 사람 리뷰를 대신하지 않습니다.
- 0.5B 모델은 같은 문장을 줄 번호만 바꿔 되풀이하고 명백한 SQL 인젝션도 놓쳐 넣지 않았습니다.
- WebGPU 가 없는 브라우저(일부 Safari·Firefox·구형 기기)는 CPU 로 돌아 매우 느립니다.
- 시크릿 창 등 저장소가 막힌 환경에서는 모델을 보관하지 못해 매번 다시 받습니다.

## 개발

```sh
npm ci
npm run dev       # http://localhost:5173
npm test          # vitest — diff 해석·요청·답 해석·반복 감지
npm run build
```

`main` 에 push 하면 `.github/workflows/deploy-pages.yml` 이 테스트·빌드 후 GitHub Pages 에 올립니다.

## 실측 (2026-09-29 · Windows · WebGPU fp16)

| 항목 | 값 |
|---|---|
| 첫 모델 준비(다운로드 포함) | 79초 (헤드리스 Edge) |
| 예제 diff 리뷰(2개 파일) | 29~33초 |
| 보관 용량 | 1,360MB |
