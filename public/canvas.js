/**
 * Layer constructor — drag-to-reorder layer chips in the canvas preview.
 * Mirrors the UX pattern from azbet-image-generator.
 */
(function () {
  const panelArea   = document.getElementById('skPanelArea');
  const sideInput   = document.getElementById('panelSideInput');
  const orderInput  = document.getElementById('layerOrderInput');
  const sideBtns    = document.querySelectorAll('.sk-side-btn');
  const canvas      = document.getElementById('skCanvas');

  if (!panelArea) return;

  // ── Drag-to-reorder (mouse + touch) ──────────────────────────────────────

  let dragging  = null;
  let placeholder = null;

  function makePlaceholder(height) {
    const el = document.createElement('div');
    el.className = 'sk-placeholder';
    el.style.height = height + 'px';
    return el;
  }

  panelArea.querySelectorAll('.sk-layer').forEach(layer => {
    // Mouse
    layer.addEventListener('mousedown', startDrag);
    // Touch
    layer.addEventListener('touchstart', startDrag, { passive: false });
  });

  function startDrag(e) {
    e.preventDefault();
    dragging = e.currentTarget;
    const rect = dragging.getBoundingClientRect();

    placeholder = makePlaceholder(rect.height);
    dragging.after(placeholder);
    dragging.classList.add('sk-dragging');

    const startY  = (e.touches ? e.touches[0].clientY : e.clientY);
    const offsetY = startY - rect.top;

    // Lift the element to fixed position for drag ghost
    dragging.style.width    = rect.width + 'px';
    dragging.style.position = 'fixed';
    dragging.style.top      = rect.top + 'px';
    dragging.style.left     = rect.left + 'px';
    dragging.style.zIndex   = '999';

    function onMove(ev) {
      const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      dragging.style.top = (clientY - offsetY) + 'px';

      // Find insertion point
      const siblings = [...panelArea.querySelectorAll('.sk-layer:not(.sk-dragging)')];
      let inserted = false;
      for (const sib of siblings) {
        const sibRect = sib.getBoundingClientRect();
        if (clientY < sibRect.top + sibRect.height / 2) {
          panelArea.insertBefore(placeholder, sib);
          inserted = true;
          break;
        }
      }
      if (!inserted) panelArea.appendChild(placeholder);
    }

    function onEnd() {
      // Drop dragging element into placeholder position
      dragging.style.cssText = '';
      dragging.classList.remove('sk-dragging');
      placeholder.replaceWith(dragging);
      placeholder = null;
      dragging = null;
      updateOrder();

      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onEnd);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend',  onEnd);
  }

  function updateOrder() {
    const layers = [...panelArea.querySelectorAll('.sk-layer')];
    orderInput.value = layers.map(l => l.dataset.layer).join(',');
  }

  // ── Panel-side toggle ────────────────────────────────────────────────────

  sideBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      sideBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sideInput.value = btn.dataset.side;

      const imageArea = canvas.querySelector('.sk-image-area');
      const panel     = canvas.querySelector('.sk-panel-area');

      if (btn.dataset.side === 'left') {
        canvas.insertBefore(panel, imageArea);    // panel first = left
      } else {
        canvas.insertBefore(imageArea, panel);    // image first = left, panel = right
      }
    });
  });

  // Init order value
  updateOrder();
})();
