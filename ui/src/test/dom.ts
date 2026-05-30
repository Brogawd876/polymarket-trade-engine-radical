import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://127.0.0.1/',
});

globalThis.window = dom.window as unknown as Window & typeof globalThis;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.window.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
globalThis.window.cancelAnimationFrame = (id: number) => clearTimeout(id);
globalThis.window.matchMedia = globalThis.window.matchMedia ?? (() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
}));
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame.bind(globalThis.window);
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame.bind(globalThis.window);
globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
};
