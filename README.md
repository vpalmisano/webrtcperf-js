# WebRTC Perf javascript browser library
[GitHub page](https://github.com/vpalmisano/webrtcperf-js) | [Documentation](https://vpalmisano.github.io/webrtcperf)

A browser library used by the [webrtcperf](https://github.com/vpalmisano/webrtcperf)
tool to capture the RTC logs and run page inspection/automation.

## Userscript usage
The library can be used directly into a regular Google Chome browser session.

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Install the [User Script](https://gist.githubusercontent.com/vpalmisano/ada9e44c88fc83273877e0933b0d8d44/raw/webrtcperf.user.js)

### Examples
Access the RTC PeerConnections objects:
```js
webrtcperf.PeerConnections
```

Get the current RTC stats:
```js
await webrtcperf.collectPeerConnectionStats(true)
```

Use a video as getUserMedia default source:
```js
webrtcperf.config.VIDEO_URL = '<video URL>'
webrtcperf.config.AUDIO_URL = '<audio URL>'
```

