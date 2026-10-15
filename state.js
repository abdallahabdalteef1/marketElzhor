// Tiny shared state + event bus so the storefront modules stay decoupled.
export const state = {
  settings: null,
  cats: [],
  brands: new Map(),
  session: null,
  roles: { owner: false, staff: false, permissions: {} },
  profile: null,
};

const handlers = {};
export const bus = {
  on(evt, fn) { (handlers[evt] ||= []).push(fn); },
  emit(evt, data) { (handlers[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); },
};

// Orders a visitor placed on this device (order number + secret token) so guests can reopen them.
const OK = 'market.orders.v1';
export const rememberOrder = (number, token) => {
  try {
    const list = JSON.parse(localStorage.getItem(OK) || '[]').filter((o) => o.n !== number);
    list.unshift({ n: number, t: token, ts: Date.now() });
    localStorage.setItem(OK, JSON.stringify(list.slice(0, 20)));
  } catch { /* storage unavailable: nothing to do */ }
};
export const rememberedOrders = () => { try { return JSON.parse(localStorage.getItem(OK) || '[]'); } catch { return []; } };
