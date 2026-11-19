// Adapter for the pinned, same-origin OnlyOffice 8.3 deployment. All editor
// access is read/selection only; saving and document content stay with DocsAPI.
const clean = value => String(value || '').replace(/[\s\u200b]+/gu, '');
const severity = { high: '高风险', medium: '中风险', low: '低风险' };
export function commentTargets(finding, comments) {
  const blocks = [...new Set((finding.evidence || []).filter(e => e.quote && e.blockId).map(e => e.blockId))];
  const header = clean(`${severity[finding.disposition?.severity || finding.severity] || '审查意见'} · ${finding.title}`);
  const reason = clean(`判断理由：${finding.reason || '请法务核实'}`);
  const suggestion = clean(`修改建议：${finding.disposition?.suggestion ?? finding.suggestion ?? '请法务补充处理意见'}`);
  return blocks.map(blockId => {
    const matches = comments.filter(comment => {
      const data = comment.Data || {}, lines = String(data.Text || '').split(/\r?\n/).map(clean), text = clean(data.Text);
      return data.UserName === 'AI 合同预审' && lines[0] === header && lines.includes(clean(`原文段落：${blockId}`)) && text.includes(reason) && text.includes(suggestion);
    });
    return { blockId, id: matches.length === 1 ? String(matches[0].Id) : null, ambiguous: matches.length > 1 };
  });
}

export function connectionGeometry({ frame, viewport, anchor, layout, card, list, lane = 0 }) {
  if (!anchor || ![anchor.x, anchor.y].every(Number.isFinite) || card.left < frame.right - 4) return null;
  const top = frame.top + viewport.top, bottom = Math.min(frame.bottom, frame.top + viewport.bottom);
  const y = top + anchor.y;
  if (y < top + 2 || y > bottom - 2 || card.bottom < list.top || card.top > list.bottom) return null;
  const x = Math.max(frame.left + viewport.left + 4, Math.min(frame.left + viewport.left + anchor.x, frame.left + viewport.right - 8));
  const start = { x: x - layout.left, y: y - layout.top };
  const end = { x: card.left - layout.left + 2, y: Math.max(list.top + 12, Math.min(card.top + 33, list.bottom - 12)) - layout.top };
  if (end.x <= start.x) return null;
  const bend = Math.min(end.x - 8, Math.max(start.x + 16, frame.right - layout.left - 12 - (lane % 5) * 6));
  return { start, end, path: `M ${start.x} ${start.y} H ${bend - 8} Q ${bend} ${start.y} ${bend} ${start.y + Math.sign(end.y - start.y) * Math.min(8, Math.abs(end.y - start.y) / 2)} L ${bend} ${end.y} H ${end.x}` };
}

// asc_showComment only reads a comment's native coordinates and dispatches its
// popup event. Capture that dispatch synchronously, including the SDK's compiled
// aliases, so measuring never opens popups, changes selection or scrolls. Restore
// every descriptor in finally; no SDK callback or method stays replaced.
export function readCommentPositions(api, ids) {
  const positions = new Map(), restore = [];
  if (!api.asc_showComment || !api.sync_ShowComment || !api.sync_HideComment) return positions;
  const overrides = new Map([
    [api.sync_ShowComment, (targets, x, y) => { for (const id of Array.isArray(targets) ? targets : [targets]) positions.set(String(id), { x, y }); }],
    [api.sync_HideComment, () => {}],
  ]);
  const methods = new Map();
  for (let prototype = api; prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (!methods.has(name) && overrides.has(descriptor?.value)) methods.set(name, overrides.get(descriptor.value));
    }
  }
  try {
    for (const [name, method] of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(api, name);
      Object.defineProperty(api, name, descriptor ? { ...descriptor, value: method } : { configurable: true, writable: true, value: method });
      restore.push([name, descriptor]);
    }
    for (const id of ids) api.asc_showComment(id);
  } finally {
    for (const [name, descriptor] of restore.reverse()) {
      if (descriptor) Object.defineProperty(api, name, descriptor);
      else delete api[name];
    }
  }
  return positions;
}

export function connectOfficeComments(host, findings, { position, select, unavailable } = {}) {
  let frame, api, anchor = null, selected = null, style, stopped = false, enabled = true;
  const handlers = [], mappings = new Map();
  try {
    frame = host.querySelector('iframe');
    const win = frame?.contentWindow;
    api = win?.Asc?.editor || win?.editor;
    if (!api?.pluginMethod_GetAllComments || !api.asc_selectComment || !api.asc_registerCallback || !api.asc_unregisterCallback) throw new Error('Editor bridge unavailable');
    const comments = api.pluginMethod_GetAllComments();
    for (const finding of findings) {
      const targets = commentTargets(finding, comments);
      mappings.set(finding.id, targets);
    }
    const byComment = new Map();
    for (const [findingId, targets] of mappings) for (const target of targets) if (target.id) {
      if (byComment.has(target.id) && byComment.get(target.id)?.findingId !== findingId) byComment.set(target.id, null);
      else byComment.set(target.id, { ...target, findingId });
    }
    style = win.document.createElement('style');
    // Workbench AI comments use the external card; human comments retain their
    // native editor popup. Scope and remove this rule with the edit session.
    style.textContent = 'html[data-legal-comment-link] .asc-window:has(#id-comments-popover),html[data-legal-comment-link] #id-comments-arrow{visibility:hidden!important;pointer-events:none!important}';
    win.document.head.appendChild(style);
    const mark = active => win.document.documentElement.toggleAttribute('data-legal-comment-link', active);
    function show(ids, x, y) {
      if (!enabled) { mark(false); anchor = null; position?.(null); return; }
      const candidates = (Array.isArray(ids) ? ids : [ids]).map(id => byComment.get(String(id))).filter(Boolean);
      const target = candidates.find(t => t.id === selected?.id) || candidates[0];
      if (!target) { selected = null; anchor = null; mark(false); position?.(null); return; }
      const changed = selected?.id !== target.id;
      selected = target; anchor = { id: target.id, x, y }; mark(true);
      if (changed) {
        const targets = (mappings.get(target.findingId) || []).filter(t => t.id && byComment.get(t.id));
        select?.(target.findingId, { count: targets.length, index: targets.findIndex(t => t.id === target.id) });
      }
      position?.(anchor);
    }
    function hide() { selected = null; anchor = null; mark(false); position?.(null); }
    function register(name, handler) { api.asc_registerCallback(name, handler); handlers.push([name, handler]); }
    register('asc_onShowComment', show);
    register('asc_onUpdateCommentPosition', show);
    register('asc_onHideComment', hide);
    function invalidate(id) { byComment.delete(String(id)); if (String(id) === selected?.id) hide(); }
    register('asc_onRemoveComment', invalidate);
    register('asc_onChangeCommentData', invalidate);
    return {
      available: true,
      locate(findingId, index = 0) {
        const targets = mappings.get(findingId) || [], valid = targets.filter(t => t.id && byComment.get(t.id));
        if (!valid.length) { hide(); return { state: targets.some(t => t.ambiguous) ? 'ambiguous' : 'missing', count: 0 }; }
        const target = valid[index % valid.length]; selected = { ...target, findingId };
        api.asc_selectComment(target.id);
        if (api.scrollToTarget) api.scrollToTarget();
        else if (api.ViewScrollToY) {
          // 8.3 does not scroll an unchanged caret back into view. Read the
          // native anchor at scroll zero, then use its exact document offset.
          // Both scrolls are synchronous, before the browser paints.
          api.ViewScrollToY(0); api.asc_showComment(target.id);
          if (anchor?.id === target.id && Number.isFinite(anchor.y)) api.ViewScrollToY(Math.max(0, anchor.y - 110));
        }
        api.asc_showComment(target.id);
        return { state: 'linked', count: valid.length, index: index % valid.length };
      },
      measure(layout, card, list) {
        const viewport = win.document.querySelector('#editor_sdk');
        if (stopped || !viewport || !anchor) return null;
        return connectionGeometry({ frame: frame.getBoundingClientRect(), viewport: viewport.getBoundingClientRect(), anchor, layout, card, list });
      },
      measureAll(layout, cards, list) {
        const viewport = win.document.querySelector('#editor_sdk');
        if (stopped || !enabled || !viewport || !cards.size) return [];
        const targets = [...byComment].filter(([, target]) => target && cards.has(target.findingId));
        try {
          const positions = readCommentPositions(api, targets.map(([id]) => id));
          const input = { frame: frame.getBoundingClientRect(), viewport: viewport.getBoundingClientRect(), layout, list };
          return targets.flatMap(([id, target], lane) => {
            const geometry = connectionGeometry({ ...input, anchor: positions.get(id), card: cards.get(target.findingId), lane });
            return geometry ? [{ ...geometry, findingId: target.findingId, commentId: id }] : [];
          });
        } catch { unavailable?.(); return []; }
      },
      refresh() {},
      setEnabled(value) { enabled = value; if (!value) { anchor = null; mark(false); position?.(null); } },
      disconnect() { stopped = true; for (const [name, handler] of handlers) api.asc_unregisterCallback(name, handler); style.remove(); mark(false); },
    };
  } catch {
    for (const [name, handler] of handlers) api?.asc_unregisterCallback?.(name, handler);
    style?.remove(); unavailable?.();
    return { available: false, locate: () => ({ state: 'unavailable', count: 0 }), measure: () => null, measureAll: () => [], refresh() {}, setEnabled() {}, disconnect() {} };
  }
}
