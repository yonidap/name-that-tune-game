(() => {
  const app = document.querySelector('#app');
  if (!app) return;

  const options = [
    { value: 'short', icon: '⚡', title: 'QUICK HIT', songs: '15', note: 'Fast & loud' },
    { value: 'normal', icon: '♪', title: 'MAIN EVENT', songs: '21', note: 'Party pick', featured: true },
    { value: 'full', icon: '♛', title: 'FULL BATTLE', songs: '40', note: 'No mercy' }
  ];

  function enhanceSetup() {
    const select = document.querySelector('#game-length');
    if (!select || select.dataset.arcadeEnhanced === '1') return;
    select.dataset.arcadeEnhanced = '1';

    const field = select.closest('.field');
    if (!field) return;
    field.classList.add('game-length-field');
    select.classList.add('native-length-select');

    const picker = document.createElement('div');
    picker.className = 'arcade-length-picker';
    picker.setAttribute('role', 'radiogroup');
    picker.setAttribute('aria-label', 'Game length');

    const refresh = () => {
      picker.querySelectorAll('.arcade-length-card').forEach((card) => {
        const selected = card.dataset.value === select.value;
        card.classList.toggle('selected', selected);
        card.setAttribute('aria-checked', selected ? 'true' : 'false');
      });
    };

    options.forEach((option) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `arcade-length-card${option.featured ? ' featured' : ''}`;
      card.dataset.value = option.value;
      card.setAttribute('role', 'radio');
      card.innerHTML = `${option.featured ? '<span class="arcade-pick">PARTY PICK</span>' : ''}<span class="arcade-mode-icon">${option.icon}</span><b>${option.title}</b><strong>${option.songs}</strong><em>SONGS</em><small>${option.note}</small>`;
      card.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refresh();
      });
      picker.appendChild(card);
    });

    select.insertAdjacentElement('afterend', picker);
    refresh();
  }

  const observer = new MutationObserver(enhanceSetup);
  observer.observe(app, { childList: true, subtree: true });
  enhanceSetup();
})();
