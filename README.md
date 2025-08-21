# 거리 비교 웹앱

카카오맵 / T맵 API를 사용하여 여러 출발지 주소(행 단위)와 하나의 도착지 주소 간 최단거리(자동차 경로 기준, 가용한 API 기준)를 비교합니다.

## 준비물

- Node.js 18+
- 카카오 REST API 키 (`Kakao Mobility Directions` 사용 시 동일 키로 `Authorization: KakaoAK` 헤더 필요. 일부 계정은 승인 필요할 수 있습니다.)
- Tmap `appKey`

## 환경변수 설정

`.env` 파일을 생성하고 다음 값을 채웁니다.

```
KAKAO_REST_KEY=카카오키
KAKAO_MOBILITY_REST_KEY=카카오모빌리티 길찾기 키(선택)
TMAP_APP_KEY=티맵키
GEMINI_API_KEY=구글 제미나이 API 키(선택)
PORT=3000
```

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후 사용합니다.

### Vercel 배포 (서버리스)

이 프로젝트는 Vercel 서버리스에 대응했습니다.

1) 코드 반영 후 Vercel에 연결하면 `api/index.js`가 Express 앱을 서버리스로 래핑합니다.
2) 환경변수(`KAKAO_REST_KEY`, `TMAP_APP_KEY`, 등)를 Vercel 프로젝트 설정에 추가하세요.
3) 프런트의 fetch(`/api/...`)는 그대로 동작합니다.

## 사용 방법

1. 테이블 첫 번째 칸의 텍스트 영역에 출발지 주소를 한 줄에 하나씩 붙여넣기
2. 상단 입력칸에 도착지 주소 입력
3. 거리 비교하기 클릭 → 각 행 우측에 카카오/T맵 거리(m)가 표시됩니다.

## 주의사항

- 카카오 모빌리티 Directions API는 사용 권한이 필요할 수 있습니다. 권한이 없으면 해당 값이 비어 보일 수 있습니다.
- Tmap은 일일 쿼터가 존재합니다. 대량 조회 시 지연 또는 실패가 발생할 수 있습니다.


