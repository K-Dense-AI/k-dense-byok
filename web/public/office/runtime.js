/* Kady's isolated browser Office host. Document bytes never leave this origin. */
'use strict';
var canvas = document.getElementById('qtcanvas');
var base = location.origin + '/office-assets/zeta-2025-05-13/';
var port, loaded = false, filename, exportPending = false;
function notify(cmd, extra, transfer) { parent.postMessage({ source: 'kady-office', cmd, ...extra }, location.origin, transfer || []); }
var Module = {
  canvas,
  uno_scripts: [location.origin + '/office/zeta.js', location.origin + '/office/thread.js'],
  locateFile: (file, prefix) => (prefix || base) + file,
  mainScriptUrlOrBlob: new Blob(["importScripts('" + base + "soffice.js');"], { type: 'text/javascript' }),
  setStatus: text => { if (text) notify('progress', { message: text }); },
  onAbort: () => notify('error', { message: 'The Office engine could not start. Reload to try again.' }),
};
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => e.preventDefault(), { passive: false });
canvas.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); e.stopImmediatePropagation(); notify('save-request');
  } else {
    // Calc doesn't emit model modifications until the active cell is accepted.
    // Track pending keyboard edits too so closing the tab cannot silently lose them.
    if ((!e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || ['Backspace', 'Delete', 'Enter'].includes(e.key))) ||
        ((e.ctrlKey || e.metaKey) && ['v', 'x', 'z', 'y'].includes(e.key.toLowerCase()))) notify('modified');
    e.preventDefault();
  }
}, true);
canvas.addEventListener('paste', () => notify('modified'));
canvas.addEventListener('input', () => notify('modified'));
function exportFile(id) {
  if (!port || !loaded || exportPending) return;
  exportPending = true; port.postMessage({ cmd: 'export', id });
}
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.source !== 'kady-office-host') return;
  const message = event.data;
  if (message.cmd === 'load' && !loaded && port && message.bytes instanceof ArrayBuffer && /^(docx|pptx|xlsx)$/.test(message.kind)) {
    filename = 'document.' + message.kind; loaded = true;
    try { FS.mkdir('/tmp/office'); } catch {}
    FS.writeFile('/tmp/office/' + filename, new Uint8Array(message.bytes));
    port.postMessage({ cmd: 'load', filename, readOnly: !!message.readOnly, dark: !!message.dark });
  } else if (message.cmd === 'export') exportFile(message.id);
  else if (port && ['command', 'chrome', 'theme'].includes(message.cmd)) {
    port.postMessage(message);
    if (message.cmd === 'command') canvas.focus();
  }
});
if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
  notify('error', { message: 'This browser cannot start the Office engine here. Open Kady on localhost or HTTPS in a current Chrome, Edge, Firefox or Safari browser.' });
} else {
  const script = document.createElement('script'); script.src = base + 'soffice.js';
  script.onerror = () => notify('error', { message: 'Could not load the Office editor. Check your connection and reload.' });
  script.onload = () => Module.uno_main.then(thread => {
    port = thread;
    port.onmessage = event => {
      const message = event.data;
      if (message.cmd === 'ready') notify('ready');
      else if (message.cmd === 'opened') {
        canvas.style.visibility = 'visible'; window.dispatchEvent(new Event('resize'));
        setTimeout(() => window.dispatchEvent(new Event('resize')), 250); notify('opened');
      } else if (message.cmd === 'exported') {
        exportPending = false;
        const bytes = FS.readFile('/tmp/office/export.' + filename.split('.').pop()).slice().buffer;
        notify('exported', { id: message.id, bytes }, [bytes]);
      } else if (message.cmd === 'error') { exportPending = false; notify('error', { message: message.message }); }
      else if (message.cmd === 'save-request' || message.cmd === 'download-request') notify(message.cmd);
      else if (message.cmd === 'modified') notify('modified');
      else if (message.cmd === 'command-state' || message.cmd === 'selection' || message.cmd === 'export-started') notify(message.cmd, message);
    };
  }).catch(() => notify('error', { message: 'Office initialization failed. Reload to try again.' }));
  document.body.appendChild(script);
}
