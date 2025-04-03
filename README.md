# WebRTC Perf javascript browser library
[GitHub page](https://github.com/vpalmisano/webrtcperf-js) | [Documentation](https://vpalmisano.github.io/webrtcperf)

A browser library used by the [webrtcperf](https://github.com/vpalmisano/webrtcperf)
tool to capture the RTC logs and run page inspection/automation.

## Userscript usage
The library can be used directly into a regular Google Chome browser session.

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Install the [User Script](https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js)

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
// Start audio or video with getUserMedia
```

Use a fake screenshare as getDisplayMedia source:
```js
await webrtcperf.startFakeScreenshare()
webrtcperf.overrides.getDisplayMedia = constraints => Object.assign(constraints, { preferCurrentTab: true })
// Start a screensharing with getDisplayMedia
```