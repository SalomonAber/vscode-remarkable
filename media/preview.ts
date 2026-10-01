import * as pdfjs from 'pdfjs-dist';

interface ViewState { zoom: number; scrollTop: number; scrollLeft: number }

declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };
declare global { interface Window { __remarkableWorkerUri: string; __remarkableViewState: ViewState | null } }

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const renderPixelRatio = 2;
const minZoom = 0.25;
const maxZoom = 5;
const reportDelayMs = 250;
// The extension host hands back where this document was last left, so the first
// render already uses the right scale and lands at the right offset.
const restored = window.__remarkableViewState;
let zoom = clamp(restored?.zoom, 1, minZoom, maxZoom);
let renderedZoom = zoom;
let scrollTop = clamp(restored?.scrollTop, 0, 0, Number.MAX_SAFE_INTEGER);
let scrollLeft = clamp(restored?.scrollLeft, 0, 0, Number.MAX_SAFE_INTEGER);
let currentUri: string | undefined;
let renderGeneration = 0;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;
let reportTimer: ReturnType<typeof setTimeout> | undefined;
let pagesVisible = false;

pdfjs.GlobalWorkerOptions.workerSrc = window.__remarkableWorkerUri;

window.addEventListener('message', event => {
	const message = event.data as { type?: string; uri?: string; message?: string };
	if (message.type === 'loading') { pagesVisible = false; app.replaceChildren(text('p', 'Loading reMarkable preview…')); }
	if (message.type === 'error') { showError(message.message || 'Unknown rendering error'); }
	if (message.type === 'pdf' && typeof message.uri === 'string') { void showPdf(message.uri); }
});

async function showPdf(uri: string): Promise<void> {
	currentUri = uri;
	const generation = ++renderGeneration;
	const targetZoom = zoom;
	try {
		const pdfDocument = await pdfjs.getDocument(uri).promise;
		const fragment = document.createDocumentFragment();
		for (let number = 1; number <= pdfDocument.numPages; number++) {
			const pdfPage = await pdfDocument.getPage(number);
			const viewport = pdfPage.getViewport({ scale: targetZoom * renderPixelRatio });
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
			canvas.style.width = `${viewport.width / renderPixelRatio}px`;
			canvas.setAttribute('aria-label', `Page ${number}`);
			await pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
			fragment.append(canvas);
		}
		if (generation !== renderGeneration) { return; }
		app.replaceChildren(fragment);
		renderedZoom = targetZoom;
		pagesVisible = true;
		app.scrollLeft = scrollLeft;
		app.scrollTop = scrollTop;
	} catch (error) {
		if (generation === renderGeneration) { showError(error instanceof Error ? error.message : 'PDF viewer failed to load the rendered file.'); }
	}
}

function showError(message: string): void {
	pagesVisible = false;
	const retry = text('button', 'Retry'); retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
	const log = text('button', 'Open Output Log'); log.addEventListener('click', () => vscode.postMessage({ type: 'openOutput' }));
	const detail = text('p', message); detail.className = 'detail';
	app.replaceChildren(text('h2', 'Rendering failed'), detail, retry, log);
}

function text(tag: string, contents: string): HTMLElement { const element = document.createElement(tag); element.textContent = contents; return element; }

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Scroll and pinch-zoom fire continuously; the host only needs the resting position. */
function reportViewState(): void {
	if (reportTimer) { return; }
	reportTimer = setTimeout(() => {
		reportTimer = undefined;
		vscode.postMessage({ type: 'viewState', zoom, scrollTop, scrollLeft });
	}, reportDelayMs);
}

app.addEventListener('wheel', event => {
	if (!event.ctrlKey || !currentUri) { return; }
	event.preventDefault();
	const nextZoom = Math.min(maxZoom, Math.max(minZoom, zoom * Math.exp(-event.deltaY * 0.01)));
	if (Math.abs(nextZoom - zoom) < 0.001) { return; }
	const bounds = app.getBoundingClientRect();
	const x = event.clientX - bounds.left;
	const y = event.clientY - bounds.top;
	const ratio = nextZoom / zoom;
	zoom = nextZoom;
	for (const canvas of app.querySelectorAll('canvas')) { canvas.style.width = `${canvas.width * zoom / (renderedZoom * renderPixelRatio)}px`; }
	app.scrollLeft = (app.scrollLeft + x) * ratio - x;
	app.scrollTop = (app.scrollTop + y) * ratio - y;
	scrollLeft = app.scrollLeft;
	scrollTop = app.scrollTop;
	reportViewState();
	if (zoomTimer) { clearTimeout(zoomTimer); }
	zoomTimer = setTimeout(() => {
		zoomTimer = undefined;
		if (currentUri) { void showPdf(currentUri); }
	}, 80);
}, { passive: false });
app.addEventListener('scroll', () => {
	// The loading and error states replace the pages, which collapses the offset
	// to zero and fires this event. The remembered position has to survive that.
	if (!pagesVisible) { return; }
	scrollTop = app.scrollTop;
	scrollLeft = app.scrollLeft;
	reportViewState();
});
