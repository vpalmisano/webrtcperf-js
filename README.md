# WebRTC Perf javascript browser library
[GitHub page](https://github.com/vpalmisano/webrtcperf-js) | [Documentation](https://vpalmisano.github.io/webrtcperf-js/)

A browser library used by the [webrtcperf](https://github.com/vpalmisano/webrtcperf)
tool to capture the RTC logs and run page inspection/automation. It can also be
used stand-alone importing the javascript package into the page before loading
the other javascript sources.
It contains some utilities to debug the page RTC connections, the getUserMedia and
getDisplayMedia, evaluate the end-to-end delay, etc. 

## Import the library
```html
<head>
  <script type="text/javascript" src="https://unpkg.com/@vpalmisano/webrtcperf-js/dist/webrtcperf.js"></script>
</head>
```

## Userscript usage
The library can be used directly into a regular Google Chome browser session.

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Install the [User Script](https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js)

## Example usage
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
webrtcperf.config.MEDIA_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
// Start audio or video with getUserMedia
```

Use a fake screenshare as getDisplayMedia source:
```js
await webrtcperf.startFakeScreenshare()
webrtcperf.overrides.getDisplayMedia = constraints => Object.assign(constraints, { preferCurrentTab: true })
// Start a screensharing with getDisplayMedia
```