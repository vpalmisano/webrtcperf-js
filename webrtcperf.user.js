// ==UserScript==
// @name         webrtcperf-js
// @namespace    https://github.com/vpalmisano/webrtcperf-js
// @version      1.0.4
// @updateURL    https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js
// @downloadURL  https://raw.githubusercontent.com/vpalmisano/webrtcperf-js/refs/heads/main/webrtcperf.user.js
// @description  WebRTC Perf javascript browser library
// @author       Vittorio Palmisano
// @match        https://*/*
// @run-at       document-start
// @icon         https://raw.githubusercontent.com/vpalmisano/webrtcperf/refs/heads/devel/media/logo.svg
// @resource     JS https://unpkg.com/@vpalmisano/webrtcperf-js@1.0.4/dist/webrtcperf.js
// @grant        GM_getResourceText
// ==/UserScript==
const element = document.createElement('script');
element.innerText = GM_getResourceText('JS');
element.type = 'text/javascript';
document.head.appendChild(element);