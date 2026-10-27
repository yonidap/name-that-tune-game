(() => {
  const app = document.querySelector('#app');
  if (!app) return;

  function makeQrDataUrl(text) {
    if (typeof window.qrcode !== 'function') return null;
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 4);
  }

  function enhancePanel(panel, type) {
    const urlNode = panel?.querySelector('.join-url');
    if (!urlNode || urlNode.dataset.qrEnhanced === '1') return;

    const url = urlNode.textContent.trim();
    if (!/^https?:\/\//i.test(url)) return;

    const dataUrl = makeQrDataUrl(url);
    if (!dataUrl) return;

    urlNode.dataset.qrEnhanced = '1';
    urlNode.classList.add('join-url-qr');

    const stack = document.createElement('div');
    stack.className = `qr-stack qr-${type}`;

    const frame = document.createElement('div');
    frame.className = 'qr-frame';

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = type === 'host' ? 'QR code for host controller' : 'QR code to join as captain';
    img.width = 220;
    img.height = 220;
    frame.appendChild(img);

    const label = document.createElement('div');
    label.className = 'qr-label';
    label.textContent = type === 'host' ? 'SCAN FOR HOST CONTROL' : 'SCAN TO JOIN';

    const fallback = document.createElement('div');
    fallback.className = 'qr-fallback';
    fallback.textContent = type === 'host' ? 'PIN required after scanning' : 'or enter the room code above';

    stack.append(frame, label, fallback);
    urlNode.replaceChildren(stack);
  }

  function enhanceLobby() {
    const lobby = document.querySelector('.lobby-grid');
    if (!lobby) return;
    enhancePanel(lobby.querySelector('.captain-join'), 'captain');
    enhancePanel(lobby.querySelector('.host-join'), 'host');
  }

  const observer = new MutationObserver(enhanceLobby);
  observer.observe(app, { childList: true, subtree: true });
  enhanceLobby();
})();
