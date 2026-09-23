(function () {
  'use strict';

  function bindTabs() {
    const tabs = Array.from(document.querySelectorAll('.view-tab'));
    const panels = Array.from(document.querySelectorAll('.view-panel'));
    if (!tabs.length || !panels.length) return;

    function showView(viewId) {
      const panel = document.getElementById(viewId);
      if (!panel) return;

      panels.forEach(function (item) {
        item.hidden = item.id !== viewId;
      });
      tabs.forEach(function (tab) {
        tab.classList.toggle('active', tab.dataset.view === viewId);
        tab.setAttribute('aria-selected', tab.dataset.view === viewId ? 'true' : 'false');
      });
    }

    tabs.forEach(function (tab) {
      tab.type = 'button';
      tab.addEventListener('click', function (event) {
        event.preventDefault();
        showView(tab.dataset.view);
      });
    });

    // Keep the requested initial state and do not touch localStorage.
    showView('reservationsView');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTabs, { once: true });
  } else {
    bindTabs();
  }
}());
