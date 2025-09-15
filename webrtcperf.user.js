// ==UserScript==
// @name         webrtcperf-js
// @namespace    https://github.com/vpalmisano/webrtcperf-js
// @version      1.1.13
// @updateURL    https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js
// @downloadURL  https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js
// @description  WebRTC Perf javascript browser library
// @author       Vittorio Palmisano
// @match        https://*/*
// @run-at       document-start
// @icon         https://raw.githubusercontent.com/vpalmisano/webrtcperf/refs/heads/devel/media/logo.svg
// @resource     webrtcperf.js https://unpkg.com/@vpalmisano/webrtcperf-js@1.1.13/dist/webrtcperf.js
// @grant        GM_getResourceText
// @grant        GM_addElement
// ==/UserScript==
try {
  GM_addElement('script', {
    textContent: GM_getResourceText('webrtcperf.js'),
    type: 'text/javascript',
    id: 'webrtcperf-js',
  });
} catch (e) {
  console.error('Error loading webrtcperf.js', e);
}