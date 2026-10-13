/** Styled, keyboard-accessible menus backed by the existing select values/events. */
interface SelectControl { source: HTMLSelectElement; trigger: HTMLButtonElement; value: HTMLSpanElement; label: string }
const controls = new Map<HTMLSelectElement, SelectControl>();
let opened: SelectControl | null = null;
let popup: HTMLDivElement | null = null;
let active = -1;
let search = '', searchedAt = 0;
let sequence = 0;

function closeMenu(restoreFocus = false) {
  const previous = opened;
  if (previous) { previous.trigger.setAttribute('aria-expanded', 'false'); previous.trigger.removeAttribute('aria-activedescendant'); }
  popup?.remove(); popup = null; opened = null; search = '';
  if (restoreFocus) previous?.trigger.focus();
}
function positionMenu() {
  if (!opened || !popup) return;
  const rect = opened.trigger.getBoundingClientRect();
  const dock = opened.trigger.closest('.dock-scroll')?.getBoundingClientRect();
  if (rect.bottom < 8 || rect.top > innerHeight - 8 || (dock && (rect.bottom < dock.top || rect.top > dock.bottom))) { closeMenu(); return; }
  const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
  const upwards = below < 220 && above > below;
  popup.style.width = `${Math.min(Math.max(rect.width, 200), innerWidth - 20)}px`;
  popup.style.maxHeight = `${Math.max(60, Math.min(320, upwards ? above : below))}px`;
  popup.style.left = `${Math.max(10, Math.min(rect.left, innerWidth - popup.offsetWidth - 10))}px`;
  popup.style.top = `${upwards ? rect.top - popup.offsetHeight - 6 : rect.bottom + 6}px`;
}
function highlight(index: number, scroll = true) {
  if (!opened || !popup) return;
  active = index;
  [...popup.children].forEach((option, i) => option.classList.toggle('highlighted', i === active));
  const option = popup.children[active] as HTMLElement | undefined;
  if (option) { opened.trigger.setAttribute('aria-activedescendant', option.id); if (scroll) option.scrollIntoView({ block: 'nearest' }); }
}
function choose(index: number) {
  if (!opened || opened.source.options[index]?.disabled) return;
  const source = opened.source;
  closeMenu(true);
  if (source.selectedIndex !== index) {
    source.selectedIndex = index;
    source.dispatchEvent(new Event('input', { bubbles: true }));
    source.dispatchEvent(new Event('change', { bubbles: true }));
  }
  syncSelects();
}
function openMenu(control: SelectControl) {
  if (control.source.disabled) return;
  closeMenu(); opened = control;
  popup = document.createElement('div'); popup.className = 'select-popup'; popup.id = `${control.trigger.id}-list`;
  popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', control.label);
  // The top layer avoids clipping inside scrolling docks and modal dialogs.
  popup.setAttribute('popover', 'manual');
  (control.trigger.closest('dialog') ?? document.body).append(popup);
  [...control.source.options].forEach((source, i) => {
    const option = document.createElement('div'); option.className = 'select-option'; option.id = `${popup!.id}-${i}`;
    option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(source.selected));
    option.setAttribute('aria-disabled', String(source.disabled)); option.textContent = source.textContent;
    option.addEventListener('pointermove', () => { if (!source.disabled) highlight(i, false); });
    option.addEventListener('pointerdown', e => e.preventDefault());
    option.addEventListener('click', () => choose(i)); popup!.append(option);
  });
  popup.showPopover(); positionMenu();
  control.trigger.setAttribute('aria-expanded', 'true');
  highlight(Math.max(0, control.source.selectedIndex));
}
function handleKey(control: SelectControl, e: KeyboardEvent) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape', 'Tab'];
  if (!keys.includes(e.key) && (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey)) return;
  if (e.key === 'Tab') { if (opened === control) choose(active); return; }
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape') { closeMenu(true); return; }
  const wasOpen = opened === control;
  if (!wasOpen) openMenu(control);
  if (e.key === 'Enter' || e.key === ' ') { if (wasOpen) choose(active); return; }
  const available = [...control.source.options].map((option, i) => option.disabled ? -1 : i).filter(i => i >= 0);
  if (!available.length) return;
  if (e.key === 'Home') highlight(available[0]);
  else if (e.key === 'End') highlight(available[available.length - 1]);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const next = Math.max(0, Math.min(available.length - 1, available.indexOf(active) + (e.key === 'ArrowDown' ? 1 : -1)));
    highlight(available[next]);
  } else {
    const now = performance.now(); search = now - searchedAt > 700 ? e.key.toLowerCase() : search + e.key.toLowerCase(); searchedAt = now;
    const match = available.find(i => control.source.options[i].text.toLowerCase().startsWith(search));
    if (match !== undefined) highlight(match);
  }
}
export function enhanceSelects(container: ParentNode = document) {
  container.querySelectorAll<HTMLSelectElement>('select').forEach(source => {
    if (controls.has(source)) return;
    const labelElement = source.labels?.[0] ?? source.closest('label');
    const label = source.getAttribute('aria-label') ?? labelElement?.querySelector('span')?.textContent?.trim() ?? 'Choose an option';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'select-trigger';
    trigger.id = `${source.id || `select-${++sequence}`}-control`; trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-controls', `${trigger.id}-list`);
    if (source.hasAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', source.getAttribute('aria-describedby')!);
    const value = document.createElement('span'); trigger.append(value);
    const caret = document.createElement('span'); caret.className = 'select-caret'; caret.setAttribute('aria-hidden', 'true'); trigger.append(caret);
    source.hidden = true; source.tabIndex = -1; source.setAttribute('aria-hidden', 'true'); source.after(trigger);
    if (labelElement instanceof HTMLLabelElement) labelElement.htmlFor = trigger.id;
    const control = { source, trigger, value, label }; controls.set(source, control);
    trigger.addEventListener('click', () => opened === control ? closeMenu() : openMenu(control));
    trigger.addEventListener('keydown', e => handleKey(control, e));
    source.addEventListener('change', () => syncSelects());
  });
  syncSelects();
}
/** Called alongside rendering so programmatic select.value assignments stay visible. */
export function syncSelects() {
  for (const [source, control] of controls) {
    if (!source.isConnected) { if (opened === control) closeMenu(); controls.delete(source); continue; }
    const label = source.getAttribute('aria-label') ?? source.closest('label')?.querySelector('span')?.textContent?.trim();
    if (label && label !== control.label) {
      control.label = label; control.trigger.setAttribute('aria-label', label);
      if (opened === control) popup?.setAttribute('aria-label', label);
    }
    const text = source.selectedOptions[0]?.textContent ?? 'Choose an option';
    if (control.value.textContent !== text) control.value.textContent = text;
    control.trigger.disabled = source.disabled;
    if (opened === control && (source.disabled || !control.trigger.getClientRects().length)) closeMenu();
  }
}
export function installSelects() {
  enhanceSelects();
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && (node.matches('select') || node.querySelector('select'))) enhanceSelects(node.parentElement ?? node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('pointerdown', e => { if (opened && !opened.trigger.contains(e.target as Node) && !popup?.contains(e.target as Node)) closeMenu(); }, true);
  document.addEventListener('focusin', e => { if (opened && !opened.trigger.contains(e.target as Node) && !popup?.contains(e.target as Node)) closeMenu(); });
  document.addEventListener('scroll', e => { if (opened && e.target !== popup) positionMenu(); }, true);
  window.addEventListener('resize', () => closeMenu());
}
