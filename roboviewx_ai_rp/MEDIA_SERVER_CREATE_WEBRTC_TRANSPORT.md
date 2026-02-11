# media-server: createWebRtcTransport RPC 스펙

edge-agent의 `device.createSendTransport()`는 아래 필드가 **필수**입니다.  
서버의 createWebRtcTransport RPC는 반드시 다음 형태로 반환해야 합니다.

## 필수 반환 필드

```ts
{
  id: string,                    // transport.id (또는 클라이언트에서 transportId → id 로 매핑 가능)
  iceParameters: object,        // transport.iceParameters
  iceCandidates: array,         // transport.iceCandidates (빈 배열이라도 필수)
  dtlsParameters: object        // transport.dtlsParameters
}
```

## 권장 서버 구현 (mediasoup)

```ts
// createWebRtcTransport RPC 핸들러
const transport = await room.router.createWebRtcTransport({
  listenIps: [...],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  // ...
});

return {
  id: transport.id,
  iceParameters: transport.iceParameters,
  iceCandidates: transport.iceCandidates,
  dtlsParameters: transport.dtlsParameters,
};
```

## JSON-RPC로 감싸는 경우

`result` 안에 위 객체가 들어가면 됩니다.

```ts
// 응답 예시
{ "jsonrpc": "2.0", "id": 1, "result": {
  "id": "...",
  "iceParameters": { ... },
  "iceCandidates": [ ... ],
  "dtlsParameters": { ... }
}}
```

edge-agent는 `result` / `transportOptions` / 최상위 객체를 방어적으로 언랩하므로,  
서버가 `result`만 올바르게 채우면 됩니다.

## 주의

- **id 누락** → `TypeError: missing id` (mediasoup-client)
- **iceCandidates 누락** → edge-agent에서 명시적 에러 throw
- iceCandidates는 **배열**이어야 하며, 빈 배열 `[]` 이어도 됩니다.
